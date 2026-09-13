# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Resolve structured card name slots from Plane display names."""

from copy import deepcopy
from datetime import timedelta
from uuid import UUID

from django.utils import timezone

from plane.db.models import FeishuMessage, User, WorkspaceMember

NAME_SLOTS_KEY = "_plane_name_slots"
UNAVAILABLE_NAME = "成员"


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


def hydrate_card_names(message, integration, claim, lease_seconds):
    """Freeze Plane display names before the first send, retaining identical content on retries."""
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
    active_members = WorkspaceMember.objects.filter(
        workspace_id=integration.workspace_id,
        member_id__in=ids,
        is_active=True,
    ).values_list("member_id", flat=True)
    names = {
        str(pk): " ".join(name.split())[:100]
        for pk, name in User.objects.filter(pk__in=active_members, is_active=True).values_list("pk", "display_name")
        if name and name.strip()
    }
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
