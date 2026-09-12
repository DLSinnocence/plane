# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Resolve structured card name slots from Feishu without using SSO display names."""

from copy import deepcopy
from datetime import timedelta
from uuid import UUID

from django.utils import timezone

from plane.db.models import FeishuMessage, User, WorkspaceMember
from plane.utils.feishu import FeishuError
from plane.utils.phone import normalize_phone_number

NAME_SLOTS_KEY = "_plane_name_slots"
MAX_PEOPLE_PER_CARD = 20
UNAVAILABLE_NAME = "成员（飞书昵称不可用）"


def member_parts(ids):
    parts = []
    for user_id in sorted(ids):
        if parts:
            parts.append("、")
        parts.append({"user_id": str(user_id)})
    return parts or ["未分配"]


def render_parts(parts, names=None):
    names = names or {}
    return "".join(
        part if isinstance(part, str) else names.get(part.get("user_id"), UNAVAILABLE_NAME)
        for part in parts
        if isinstance(part, (str, dict))
    )


def hydrate_card_names(message, integration, client, claim, lease_seconds):
    """Freeze Feishu nicknames before the first send, retaining identical content on retries."""
    if NAME_SLOTS_KEY not in message.card:
        return True
    card = deepcopy(message.card)
    slots = card.pop(NAME_SLOTS_KEY)
    slots = slots if isinstance(slots, list) else []
    ids = []
    for slot in slots:
        if not isinstance(slot, dict):
            continue
        for part in slot.get("parts", []):
            if not isinstance(part, dict):
                continue
            try:
                user_id = str(UUID(part.get("user_id", "")))
            except (ValueError, TypeError, AttributeError):
                continue
            if user_id not in ids:
                ids.append(user_id)
    ids = ids[:MAX_PEOPLE_PER_CARD]
    active_members = WorkspaceMember.objects.filter(
        workspace_id=integration.workspace_id,
        member_id__in=ids,
        is_active=True,
    ).values_list("member_id", flat=True)
    phones = {
        str(pk): normalize_phone_number(phone)
        for pk, phone in User.objects.filter(pk__in=active_members, is_active=True).values_list("pk", "mobile_number")
    }
    names = {}
    for user_id in ids:
        mobile = phones.get(user_id)
        if not mobile:
            continue
        # Name enrichment can involve multiple people. Renew the existing claim
        # before each bounded provider lookup so another worker cannot take it.
        if not FeishuMessage.objects.filter(pk=message.pk, status="sending", claim_token=claim).update(
            lease_expires_at=timezone.now() + timedelta(seconds=lease_seconds), updated_at=timezone.now()
        ):
            return False
        try:
            open_id = (
                message.recipient_open_id if user_id == str(message.receiver_id) else client.resolve_mobile(mobile)
            )
            name = client.get_display_name(open_id)
            if isinstance(name, str) and name.strip():
                names[user_id] = " ".join(name.split())[:100]
        except FeishuError as exc:
            if exc.retryable:
                raise
            # Missing contact permissions/identity must not hide the work-item
            # alert, and must never silently revert to a MeowAlive nickname.
            continue
    for slot in slots:
        if not isinstance(slot, dict):
            continue
        index, parts = slot.get("element_index"), slot.get("parts")
        if type(index) is not int or not isinstance(parts, list):
            continue
        elements = card.get("elements", [])
        if not 0 <= index < len(elements):
            continue
        text = elements[index].get("text", {})
        if text.get("tag") == "plain_text":
            text["content"] = render_parts(parts, names)[:6000]
    updated = FeishuMessage.objects.filter(pk=message.pk, status="sending", claim_token=claim).update(
        card=card, lease_expires_at=timezone.now() + timedelta(seconds=lease_seconds), updated_at=timezone.now()
    )
    if updated:
        message.card = card
    return bool(updated)
