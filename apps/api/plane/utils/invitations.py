# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import secrets

from django.db import transaction
from rest_framework import serializers

from plane.db.models import Workspace
from plane.license.utils.instance_value import get_email_configuration
from plane.utils.exception_logger import log_exception


class InvitationRecipientSerializer(serializers.Serializer):
    email = serializers.EmailField(max_length=255)
    role = serializers.ChoiceField(choices=[5, 15, 20], default=5)

    def validate_email(self, value):
        return value.strip().lower()


class InvitationRequestSerializer(serializers.Serializer):
    emails = InvitationRecipientSerializer(many=True, allow_empty=False)

    def validate_emails(self, recipients):
        unique = {}
        for recipient in recipients:
            email = recipient["email"]
            if email in unique and unique[email]["role"] != recipient["role"]:
                raise serializers.ValidationError("Duplicate email addresses must have the same role.")
            unique[email] = recipient
        return list(unique.values())


def persist_invitations(model, workspace, recipients, inviter, project=None):
    """Serialize creates per workspace, including projects without a unique constraint.

    Repeated invites reuse the persisted pending token and role. A previously
    declined invite starts a new pending invitation with a fresh token.
    """
    invitations = []
    with transaction.atomic():
        Workspace.objects.select_for_update().get(pk=workspace.pk)
        scope = {"workspace": workspace}
        if project is not None:
            scope["project"] = project
        for recipient in recipients:
            invitation = model.objects.filter(email__iexact=recipient["email"], **scope).first()
            if invitation is None:
                invitation = model.objects.create(
                    **scope, **recipient, token=secrets.token_urlsafe(32), created_by=inviter
                )
            elif invitation.responded_at is not None:
                invitation.email = recipient["email"]
                invitation.role = recipient["role"]
                invitation.token = secrets.token_urlsafe(32)
                invitation.responded_at = None
                invitation.accepted = False
                invitation.message = None
                invitation.created_by = inviter
                invitation.save()
            elif not invitation.token:
                invitation.token = secrets.token_urlsafe(32)
                invitation.save()
            invitations.append(invitation)
    return invitations


def invitation_response(invitations, serializer_class, task, scope_id, current_site, inviter):
    """Return persisted links; queue only after commit and never claim delivery.

    pending means an enclosing transaction has not committed yet. In normal
    autocommit requests the callback runs immediately and reports queued/failed.
    """
    payload = {
        "message": "Invitations created successfully",
        "email_status": "pending",
        "invitations": list(serializer_class(invitations, many=True).data),
    }
    try:
        configured = bool((get_email_configuration()[0] or "").strip())
    except Exception as exc:
        log_exception(exc)
        payload["email_status"] = "failed"
        return payload
    if not configured:
        payload["email_status"] = "not_configured"
        return payload
    try:
        mail_origin = current_site() if callable(current_site) else current_site
    except Exception as exc:
        log_exception(exc)
        payload["email_status"] = "failed"
        return payload

    def dispatch():
        failed = False
        for invitation, data in zip(invitations, payload["invitations"]):
            try:
                task.delay(invitation.email, scope_id, invitation.token, mail_origin, inviter)
                data["email_status"] = "queued"
            except Exception as exc:
                log_exception(exc)
                failed = True
                data["email_status"] = "failed"
        payload["email_status"] = "failed" if failed else "queued"

    transaction.on_commit(dispatch)
    return payload
