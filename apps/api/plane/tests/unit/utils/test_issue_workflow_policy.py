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
    configured=True,
    state_group="started",
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
        state=SimpleNamespace(pk=current_state, group=state_group),
        state_assignees={str(current_state): current} if configured else {},
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
        patch("plane.utils.issue_workflow.workflow_default_assignees", return_value=[str(issue.created_by_id)]),
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
    allowed = allowed and assignment_field == "state_assignees"
    if allowed:
        authorize(**context, transition=False, assignment_field=assignment_field)
    else:
        with pytest.raises(PermissionDenied):
            authorize(**context, transition=False, assignment_field=assignment_field)


def test_missing_current_stage_uses_creator_not_actual_assignees():
    authorize(configured=False, owner=True)
    with pytest.raises(PermissionDenied):
        authorize(configured=False, responsible=True)
    with pytest.raises(PermissionDenied):
        authorize(configured=False, owner=True, active_membership=False)


def test_default_assignees_require_active_creator_membership():
    from plane.utils.issue_workflow import workflow_default_assignees

    issue = SimpleNamespace(created_by_id=uuid4(), project_id=uuid4())
    with patch("plane.utils.issue_workflow.ProjectMember.objects.filter") as members:
        members.return_value.exists.return_value = True
        assert workflow_default_assignees(issue) == [str(issue.created_by_id)]
        assert members.call_args.kwargs == {
            "project_id": issue.project_id,
            "member_id": issue.created_by_id,
            "is_active": True,
            "role__gte": 15,
            "member__is_active": True,
        }
        members.return_value.exists.return_value = False
        assert workflow_default_assignees(issue) == []
    issue.created_by_id = None
    assert workflow_default_assignees(issue) == []


def test_complete_plan_preserves_empty_and_fills_only_live_stages():
    from plane.utils.issue_workflow import complete_workflow_plan

    current, future, deleted, creator = (str(uuid4()) for _ in range(4))
    issue = SimpleNamespace(project_id=uuid4())
    with (
        patch("plane.utils.issue_workflow.workflow_default_assignees", return_value=[creator]),
        patch("plane.utils.issue_workflow.State.objects.filter") as states,
    ):
        states.return_value.values_list.return_value = [(current, "started"), (future, "unstarted")]
        assert complete_workflow_plan(issue, {current: [], deleted: [creator]}) == {current: [], future: [creator]}
        assert states.call_args.kwargs["deleted_at__isnull"] is True


def test_unrelated_update_skips_assignment_completion_and_validation():
    from unittest.mock import Mock

    state = SimpleNamespace(pk=uuid4())
    issue = SimpleNamespace(pk=uuid4(), state_id=state.pk, state=state)
    serializer = SimpleNamespace(
        _validate_workflow_save=Mock(),
        _authorize_workflow=Mock(),
        update_workflow_issue=Mock(return_value=issue),
        _validate_workflow_members=Mock(),
    )
    payload = {"name": "New title"}
    with (
        patch("plane.utils.issue_workflow.Issue.objects.select_for_update") as locked,
        patch("plane.utils.issue_workflow.complete_workflow_plan") as complete,
    ):
        locked.return_value.get.return_value = issue
        assert IssueWorkflowSerializerMixin.update.__wrapped__(serializer, issue, payload) is issue
        complete.assert_not_called()
    serializer._validate_workflow_members.assert_not_called()
    serializer.update_workflow_issue.assert_called_once_with(issue, {"name": "New title"})


@pytest.mark.parametrize(
    "group,is_triage,allow_triage,includes_triage",
    [
        ("started", False, False, False),
        ("triage", False, False, True),
        ("started", True, False, True),
        ("started", False, True, True),
    ],
)
def test_triage_states_are_only_included_when_relevant(group, is_triage, allow_triage, includes_triage):
    from plane.utils.issue_workflow import workflow_state_manager, State

    issue = SimpleNamespace(state=SimpleNamespace(group=group, is_triage=is_triage))
    assert workflow_state_manager(issue, allow_triage=allow_triage) is (
        State.all_state_objects if includes_triage else State.objects
    )


@pytest.mark.parametrize("group", ["backlog", "completed", "cancelled", "unstarted", "started"])
@pytest.mark.parametrize("submitted_creator", [True, False])
def test_fixed_stage_stale_creator_is_normalized_before_member_validation(group, submitted_creator):
    from unittest.mock import Mock

    stage, creator, other = (str(uuid4()) for _ in range(3))
    serializer = IssueWorkflowSerializerMixin()
    serializer.instance = SimpleNamespace(project_id=uuid4(), created_by_id=creator)
    serializer.context = {}
    serializer._validate_workflow_members = Mock(side_effect=lambda members: members)
    submitted = [creator if submitted_creator else other]
    expected = [] if submitted_creator and group in {"backlog", "completed", "cancelled"} else submitted
    with (
        patch("plane.utils.issue_workflow.workflow_default_assignees", return_value=[]),
        patch("plane.utils.issue_workflow.State.objects.filter") as states,
    ):
        states.return_value.values_list.return_value = [(stage, group)]
        assert serializer.validate_state_assignees({stage: submitted}) == {stage: expected}
    serializer._validate_workflow_members.assert_called_once_with(expected)


@pytest.mark.parametrize("group", ["backlog", "completed", "cancelled"])
def test_fixed_stage_permissions_ignore_historic_custom_assignee(group):
    authorize(state_group=group, owner=True)
    with pytest.raises(PermissionDenied):
        authorize(state_group=group, responsible=True)


@pytest.mark.parametrize("group", ["backlog", "completed", "cancelled"])
@pytest.mark.parametrize("creator_valid", [True, False])
def test_fixed_stage_cannot_override_creator(group, creator_valid):
    from rest_framework.exceptions import ValidationError
    from plane.utils.issue_workflow import complete_workflow_plan

    stage, creator, other = (str(uuid4()) for _ in range(3))
    default = [creator] if creator_valid else []
    issue = SimpleNamespace(project_id=uuid4())
    with (
        patch("plane.utils.issue_workflow.workflow_default_assignees", return_value=default),
        patch("plane.utils.issue_workflow.State.objects.filter") as states,
    ):
        states.return_value.values_list.return_value = [(stage, group)]
        assert complete_workflow_plan(issue, {stage: [other]}) == {stage: default}
        assert complete_workflow_plan(issue, {stage: default}, validate_fixed=True) == {stage: default}
        with pytest.raises(ValidationError):
            complete_workflow_plan(issue, {stage: [other]}, validate_fixed=True)
        if creator_valid:
            with pytest.raises(ValidationError):
                complete_workflow_plan(issue, {stage: []}, validate_fixed=True)


@pytest.mark.parametrize("assignment_field", ["state_assignees", "assignees"])
def test_combined_requests_require_both_permissions(assignment_field):
    with pytest.raises(PermissionDenied):
        authorize(owner=True, transition=True, assignment_field=assignment_field)
    with pytest.raises(PermissionDenied):
        authorize(responsible=True, transition=True, assignment_field=assignment_field)
    with pytest.raises(PermissionDenied):
        authorize(lead=True, transition=True, assignment_field=assignment_field)
    if assignment_field == "assignees":
        with pytest.raises(PermissionDenied):
            authorize(owner=True, responsible=True, transition=True, assignment_field=assignment_field)
        with pytest.raises(PermissionDenied):
            authorize(project_role=20, transition=True, assignment_field=assignment_field)
    else:
        authorize(owner=True, responsible=True, transition=True, assignment_field=assignment_field)
        authorize(project_role=20, transition=True, assignment_field=assignment_field)
