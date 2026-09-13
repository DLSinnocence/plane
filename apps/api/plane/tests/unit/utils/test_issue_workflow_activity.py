# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import json
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import pytest

from plane.utils.issue_workflow_activity import issue_activity_payload


pytestmark = pytest.mark.unit


@pytest.mark.parametrize("alias", ["assignee_ids", "assignees"])
@pytest.mark.parametrize("actual", [[], ["7ecf09ec-cf72-4aef-b282-e7c31334c281"]])
@pytest.mark.parametrize("configured", [True, False])
def test_configured_handoff_uses_actual_assignments_and_one_alias(alias, actual, configured):
    destination = uuid4()
    issue = SimpleNamespace(
        pk=uuid4(), state_id=destination, state_assignees={str(destination): []} if configured else {}
    )
    data = {"state": str(destination), "assignee_ids": ["stale"], "assignees": ["stale"], "name": "Keep me"}
    with patch("plane.utils.issue_workflow_activity.IssueAssignee.objects.filter") as rows:
        rows.return_value.order_by.return_value.values_list.return_value = actual
        result = json.loads(issue_activity_payload(data, issue, alias, previous_state_id=uuid4()))
        assert rows.call_args.kwargs["deleted_at__isnull"] is True
    assert result[alias] == actual
    assert ("assignees" if alias == "assignee_ids" else "assignee_ids") not in result
    assert result["name"] == "Keep me"
    assert data["assignee_ids"] == ["stale"]


@pytest.mark.parametrize("configured,transition", [(False, False), (True, False)])
def test_unrelated_changes_preserve_payload_without_assignment_query(configured, transition):
    destination = uuid4()
    issue = SimpleNamespace(
        pk=uuid4(), state_id=destination, state_assignees={str(destination): []} if configured else {}
    )
    data = {"name": "Rename", "assignee_ids": ["submitted"]}
    with patch("plane.utils.issue_workflow_activity.IssueAssignee.objects.filter") as rows:
        result = json.loads(
            issue_activity_payload(
                json.dumps(data),
                issue,
                previous_state_id=uuid4() if transition else destination,
            )
        )
        rows.assert_not_called()
    assert result == data


def test_explicit_plan_edit_captures_actual_rows_without_transition():
    destination = uuid4()
    issue = SimpleNamespace(pk=uuid4(), state_id=destination, state_assignees={})
    with patch("plane.utils.issue_workflow_activity.IssueAssignee.objects.filter") as rows:
        rows.return_value.order_by.return_value.values_list.return_value = []
        result = json.loads(
            issue_activity_payload(
                {"state_assignees": {}},
                issue,
                previous_state_id=destination,
            )
        )
    assert result == {"state_assignees": {}, "assignee_ids": []}
