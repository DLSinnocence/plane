# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import pytest
from rest_framework.exceptions import PermissionDenied

from plane.utils.issue_workflow import IssueWorkflowSerializerMixin


pytestmark = pytest.mark.unit


def authorize(
    *,
    project_role=15,
    workspace_admin=False,
    lead=False,
    responsible=False,
    active_user=True,
    active_membership=True,
    owner=False,
    actual=None,
    transition=True,
    assignment_field=None,
):
    actor_id, current_state, next_state = uuid4(), uuid4(), uuid4()
    actor = SimpleNamespace(pk=actor_id, is_active=active_user)
    current = [str(actor_id)] if responsible else []
    issue = SimpleNamespace(
        project_id=uuid4(),
        workspace_id=uuid4(),
        state_id=current_state,
        state=SimpleNamespace(pk=current_state),
        state_assignees={str(current_state): current},
        created_by_id=actor_id if owner else uuid4(),
        project=SimpleNamespace(project_lead_id=actor_id if lead else None),
    )
    serializer = SimpleNamespace(context={"request": SimpleNamespace(user=actor)}, workflow_assignee_field="assignees")
    membership = SimpleNamespace(role=project_role) if project_role is not None and active_membership else None
    payload = {"state": SimpleNamespace(pk=next_state)} if transition else {}
    if assignment_field:
        payload[assignment_field] = {} if assignment_field == "state_assignees" else []
    with (
        patch("plane.utils.issue_workflow.ProjectMember.objects.filter") as project_members,
        patch("plane.utils.issue_workflow.WorkspaceMember.objects.filter") as workspace_members,
        patch("plane.utils.issue_workflow.IssueAssignee.objects.filter") as assignees,
    ):
        project_members.return_value.first.return_value = membership
        workspace_members.return_value.exists.return_value = workspace_admin
        assignees.return_value.values_list.return_value = actual or []
        IssueWorkflowSerializerMixin._authorize_workflow(serializer, issue, payload)
        if active_user:
            assert project_members.call_args.kwargs["is_active"] is True
            assert project_members.call_args.kwargs["member__is_active"] is True


@pytest.mark.parametrize(
    "context,allowed",
    [
        ({"project_role": 20}, True),
        ({"workspace_admin": True}, True),
        ({"project_role": 5, "workspace_admin": True}, True),
        ({"project_role": None, "workspace_admin": True}, False),
        ({"lead": True}, True),
        ({"project_role": 5, "lead": True}, False),
        ({"responsible": True}, True),
        ({"owner": True}, False),
        ({}, False),
        ({"project_role": 20, "active_user": False}, False),
        ({"project_role": 20, "active_membership": False, "workspace_admin": True}, False),
    ],
)
def test_manager_and_current_responsibility_policy(context, allowed):
    if allowed:
        authorize(**context)
    else:
        with pytest.raises(PermissionDenied):
            authorize(**context)


@pytest.mark.parametrize("assignment_field", ["state_assignees", "assignees"])
@pytest.mark.parametrize(
    "context,allowed",
    [
        ({"owner": True}, True),
        ({"owner": True, "actual": [str(uuid4())]}, True),
        ({"project_role": 20}, True),
        ({"workspace_admin": True}, True),
        ({"project_role": 5, "workspace_admin": True}, True),
        ({"lead": True}, False),
        ({"responsible": True}, False),
        ({"responsible": True, "lead": True}, False),
        ({"owner": True, "responsible": True}, True),
        ({"owner": True, "project_role": 5}, False),
        ({"owner": True, "active_user": False}, False),
        ({"owner": True, "active_membership": False}, False),
        ({"project_role": None, "workspace_admin": True}, False),
        ({}, False),
    ],
)
def test_only_owner_and_administrators_can_manage_assignments(context, allowed, assignment_field):
    if allowed:
        authorize(**context, transition=False, assignment_field=assignment_field)
    else:
        with pytest.raises(PermissionDenied):
            authorize(**context, transition=False, assignment_field=assignment_field)


@pytest.mark.parametrize("assignment_field", ["state_assignees", "assignees"])
def test_combined_requests_require_both_permissions(assignment_field):
    with pytest.raises(PermissionDenied):
        authorize(owner=True, transition=True, assignment_field=assignment_field)
    with pytest.raises(PermissionDenied):
        authorize(responsible=True, transition=True, assignment_field=assignment_field)
    with pytest.raises(PermissionDenied):
        authorize(lead=True, transition=True, assignment_field=assignment_field)
    authorize(owner=True, responsible=True, transition=True, assignment_field=assignment_field)
    authorize(project_role=20, transition=True, assignment_field=assignment_field)
