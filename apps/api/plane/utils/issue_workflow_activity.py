# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import json

from django.core.serializers.json import DjangoJSONEncoder

from plane.db.models import IssueAssignee


def issue_activity_payload(data, issue, assignee_field="assignee_ids", *, previous_state_id=None):
    """Add persisted assignments for workflow plans and every state handoff.

    Call after saving the issue and pass its previous state for updates. A creation
    enters its initial state from None. Unrelated submitted fields are preserved.
    """
    payload = json.loads(data) if isinstance(data, str) else dict(data)
    destination = str(issue.state_id)
    changing_state = str(previous_state_id) != destination
    if "state_assignees" in payload:
        payload["state_assignees"] = issue.state_assignees
    if "state_assignees" in payload or changing_state:
        # Emit one alias: the task processes both assignment keys independently.
        payload.pop("assignee_ids" if assignee_field == "assignees" else "assignees", None)
        payload[assignee_field] = list(
            IssueAssignee.objects.filter(issue_id=issue.pk, deleted_at__isnull=True)
            .order_by("assignee_id")
            .values_list("assignee_id", flat=True)
        )
    return json.dumps(payload, cls=DjangoJSONEncoder)
