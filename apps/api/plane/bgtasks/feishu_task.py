# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import uuid
from datetime import timedelta

from celery import shared_task
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from plane.db.models import FeishuIntegration, FeishuMessage, Issue, ProjectMember, User, WorkspaceMember
from plane.utils.feishu import FeishuClient, FeishuError, decrypt_secret, valid_open_id
from plane.utils.feishu_card_people import hydrate_card_names
from plane.utils.phone import normalize_phone_number

MAX_ATTEMPTS = 4
LEASE_SECONDS = 120  # Covers lookup + send and their bounded token refreshes (at most seven HTTP calls).
SAFE_ERRORS = frozenset(
    {
        "enqueue_failed",
        "integration_disabled",
        "app_changed",
        "recipient_inactive",
        "issue_unavailable",
        "project_membership_inactive",
        "secret_decryption_failed",
        "network_error",
        "provider_unavailable",
        "provider_http_error",
        "invalid_provider_response",
        "provider_rejected",
        "delivery_failed",
        "attempt_limit",
        "phone_missing",
        "phone_invalid",
        "phone_not_found",
        "phone_ambiguous",
        "phone_changed",
        "phone_conflict",
        "phone_inactive",
    }
)
PHONE_SKIP_ERRORS = frozenset(
    {
        "phone_missing",
        "phone_invalid",
        "phone_not_found",
        "phone_ambiguous",
        "phone_changed",
        "phone_conflict",
        "phone_inactive",
    }
)


def safe_error(value):
    return value if value in SAFE_ERRORS else "delivery_failed"


def dispatch_feishu_message(message_id):
    """Call after commit; a broker outage cannot roll back a work-item mutation."""
    try:
        deliver_feishu_message.delay(str(message_id))
        return True
    except Exception:
        try:
            FeishuMessage.objects.filter(pk=message_id, status=FeishuMessage.Status.PENDING).update(
                status=FeishuMessage.Status.FAILED, last_error="enqueue_failed", updated_at=timezone.now()
            )
        except Exception:
            # The durable pending row remains available if the database is also unavailable.
            pass
        return False


@shared_task
def recover_feishu_messages():
    """Recover producer/worker crashes; terminal delivery records stay terminal."""
    now = timezone.now()
    stale = now - timedelta(seconds=LEASE_SECONDS)
    rows = (
        FeishuMessage.objects.filter(
            Q(status="pending", updated_at__lt=stale)
            | Q(status="sending", lease_expires_at__lte=now)
            | Q(status="sending", lease_expires_at__isnull=True, updated_at__lt=stale)
        )
        .order_by("updated_at")
        .values_list("id", flat=True)[:100]
    )
    for message_id in list(rows):
        dispatch_feishu_message(message_id)


def recipient_error(message, integration):
    if not integration.enabled or integration.deleted_at or integration.workspace.deleted_at:
        return "integration_disabled"
    if not integration.app_id or integration.app_id != message.app_id:
        return "app_changed"
    mobile = message.recipient_mobile
    if not mobile:
        return "phone_missing"
    normalized = normalize_phone_number(mobile)
    if not normalized or normalized != mobile:
        return "phone_invalid"
    current_mobile = (
        User.objects.filter(pk=message.receiver_id, is_active=True).values_list("mobile_number", flat=True).first()
    )
    if normalize_phone_number(current_mobile) != mobile:
        return "phone_changed"
    if not WorkspaceMember.objects.filter(
        workspace_id=integration.workspace_id,
        member_id=message.receiver_id,
        is_active=True,
        member__is_active=True,
    ).exists():
        return "recipient_inactive"
    if message.issue_id:
        issue = Issue.objects.filter(pk=message.issue_id, workspace_id=integration.workspace_id).first()
        if issue is None or issue.project.deleted_at:
            return "issue_unavailable"
        if not ProjectMember.objects.filter(
            project_id=issue.project_id, member_id=message.receiver_id, is_active=True, role__gte=15
        ).exists():
            return "project_membership_inactive"
    elif not message.event_key.startswith("test:"):
        # SET_NULL following issue deletion must never disclose an old card.
        return "issue_unavailable"
    return None


def resolve_recipient(message, client, claim):
    if not message.recipient_mobile:
        raise FeishuError("phone_missing")
    if message.recipient_open_id:
        if not valid_open_id(message.recipient_open_id):
            raise FeishuError("invalid_provider_response")
        return True
    open_id = client.resolve_mobile(message.recipient_mobile)
    if not valid_open_id(open_id):
        raise FeishuError("invalid_provider_response")
    updated = FeishuMessage.objects.filter(pk=message.id, claim_token=claim, status="sending").update(
        recipient_open_id=open_id, updated_at=timezone.now()
    )
    if not updated:
        return False
    message.recipient_open_id = open_id
    return True


def _finish(message_id, claim, **values):
    FeishuMessage.objects.filter(pk=message_id, claim_token=claim, status="sending").update(
        **values, claim_token=None, lease_expires_at=None, updated_at=timezone.now()
    )


@shared_task(bind=True, max_retries=None, acks_late=True, reject_on_worker_lost=True)
def deliver_feishu_message(self, message_id):
    now = timezone.now()
    with transaction.atomic():
        message = FeishuMessage.objects.select_for_update().filter(pk=message_id).first()
        if message is None or message.status in {"sent", "skipped", "failed"}:
            return
        if message.status == "sending" and message.lease_expires_at and message.lease_expires_at > now:
            delay = max(1, int((message.lease_expires_at - now).total_seconds()) + 1)
            raise self.retry(countdown=delay)
        if message.attempts >= MAX_ATTEMPTS:
            message.status = "failed"
            message.last_error = "attempt_limit"
            message.save(update_fields=["status", "last_error", "updated_at"])
            return
        claim = uuid.uuid4()
        message.status = "sending"
        message.claim_token = claim
        message.lease_expires_at = now + timedelta(seconds=LEASE_SECONDS)
        message.attempts += 1
        message.save(update_fields=["status", "claim_token", "lease_expires_at", "attempts", "updated_at"])
    try:
        integration = FeishuIntegration.objects.select_related("workspace").filter(pk=message.integration_id).first()
        reason = recipient_error(message, integration) if integration else "integration_disabled"
        if reason:
            _finish(message_id, claim, status="skipped", last_error=reason)
            return
        client = FeishuClient(integration.app_id, decrypt_secret(integration.app_secret))
        if not resolve_recipient(message, client, claim):
            return
        if not hydrate_card_names(message, integration, client, claim, LEASE_SECONDS):
            return
        # Contact/name resolution may take time; recheck phone, roles and app configuration.
        integration = FeishuIntegration.objects.select_related("workspace").filter(pk=message.integration_id).first()
        reason = recipient_error(message, integration) if integration else "integration_disabled"
        if reason:
            _finish(message_id, claim, status="skipped", last_error=reason)
            return
        client.send_card(message.recipient_open_id, message.card, message.id)
    except Exception as exc:
        reason = safe_error(exc.reason) if isinstance(exc, FeishuError) else "delivery_failed"
        retryable = isinstance(exc, FeishuError) and exc.retryable and message.attempts < MAX_ATTEMPTS
        failure_status = "skipped" if reason in PHONE_SKIP_ERRORS else "failed"
        _finish(message_id, claim, status="pending" if retryable else failure_status, last_error=reason)
        if retryable:
            try:
                # Publishing explicitly allows a broker error to be persisted safely.
                deliver_feishu_message.apply_async(args=[str(message_id)], countdown=min(60, 5 * 2**message.attempts))
            except Exception:
                FeishuMessage.objects.filter(pk=message_id, status="pending").update(
                    status="failed", last_error="enqueue_failed", updated_at=timezone.now()
                )
        return
    _finish(message_id, claim, status="sent", last_error="", sent_at=timezone.now())
