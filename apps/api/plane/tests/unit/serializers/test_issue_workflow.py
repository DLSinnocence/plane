# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from types import SimpleNamespace
from uuid import uuid4

import pytest
from crum import impersonate
from rest_framework.exceptions import PermissionDenied, ValidationError

from plane.api.serializers.issue import IssueSerializer as APIIssueSerializer
from plane.app.serializers.issue import IssueCreateSerializer
from plane.db.models import Issue, IssueAssignee, Project, ProjectMember, State, User

pytestmark = [pytest.mark.unit, pytest.mark.django_db]


@pytest.fixture(autouse=True)
def audit_context(create_user):
    with impersonate(create_user):
        yield


@pytest.fixture
def workflow(workspace, create_user):
    project = Project.objects.create(name="Workflow", identifier="WF", workspace=workspace)
    ProjectMember.objects.create(project=project, member=create_user, role=20, is_active=True)
    developer = User.objects.create(email="developer@example.com", username="workflow-developer")
    reviewer = User.objects.create(email="reviewer@example.com", username="workflow-reviewer")
    other = User.objects.create(email="other@example.com", username="workflow-other")
    for user in (developer, reviewer, other):
        ProjectMember.objects.create(project=project, member=user, role=15, is_active=True)
    development = State.objects.create(name="开发中", group="started", project=project, default=True)
    acceptance = State.objects.create(name="开发完成/待验收", group="started", project=project)
    issue = Issue(
        name="Workflow item",
        project=project,
        state=development,
        created_by=developer,
        state_assignees={str(development.id): [str(developer.id)], str(acceptance.id): [str(reviewer.id)]},
    )
    issue.save(created_by_id=developer.id)
    IssueAssignee.objects.create(issue=issue, project=project, assignee=developer)
    return SimpleNamespace(
        project=project,
        admin=create_user,
        developer=developer,
        reviewer=reviewer,
        other=other,
        development=development,
        acceptance=acceptance,
        issue=issue,
    )


@pytest.fixture(params=["app", "api"])
def endpoint(request):
    if request.param == "app":
        return IssueCreateSerializer, "state_id", "assignee_ids"
    return APIIssueSerializer, "state", "assignees"


def serializer_for(endpoint, workflow, actor, data, instance=None):
    serializer_class, _, _ = endpoint
    return serializer_class(
        instance=instance if instance is not None else workflow.issue,
        data=data,
        partial=True,
        context={
            "request": SimpleNamespace(user=actor),
            "project_id": workflow.project.id,
            "workspace_id": workflow.project.workspace_id,
            "default_assignee_id": None,
        },
    )


def save(serializer):
    serializer.is_valid(raise_exception=True)
    with impersonate(serializer.context["request"].user):
        return serializer.save()


def assert_denied(serializer):
    with pytest.raises(PermissionDenied):
        save(serializer)


def test_current_responsible_can_transition_and_hands_off(endpoint, workflow):
    _, state_key, _ = endpoint
    issue = save(serializer_for(endpoint, workflow, workflow.developer, {state_key: str(workflow.acceptance.id)}))
    assert issue.state_id == workflow.acceptance.id
    assert set(IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True)) == {
        workflow.reviewer.id
    }
    assert_denied(
        serializer_for(
            endpoint, workflow, workflow.developer, {state_key: str(workflow.development.id)}, instance=issue
        )
    )
    save(
        serializer_for(endpoint, workflow, workflow.reviewer, {state_key: str(workflow.development.id)}, instance=issue)
    )


def test_destination_assignee_cannot_transition_from_current_state(endpoint, workflow):
    _, state_key, _ = endpoint
    assert_denied(serializer_for(endpoint, workflow, workflow.reviewer, {state_key: str(workflow.acceptance.id)}))
    workflow.issue.refresh_from_db()
    assert workflow.issue.state_id == workflow.development.id


def test_submitted_self_assignment_does_not_grant_transition(endpoint, workflow):
    _, state_key, assignees_key = endpoint
    assert_denied(
        serializer_for(
            endpoint,
            workflow,
            workflow.other,
            {
                state_key: str(workflow.acceptance.id),
                assignees_key: [str(workflow.other.id)],
                "state_assignees": {str(workflow.development.id): [str(workflow.other.id)]},
            },
        )
    )
    workflow.issue.refresh_from_db()
    assert workflow.issue.state_id == workflow.development.id
    assert set(IssueAssignee.objects.filter(issue=workflow.issue).values_list("assignee_id", flat=True)) == {
        workflow.developer.id
    }


@pytest.mark.parametrize("edit_kind", ["plan", "current"])
def test_unrelated_member_cannot_edit_assignments(endpoint, workflow, edit_kind):
    _, _, assignees_key = endpoint
    data = (
        {"state_assignees": {str(workflow.development.id): [str(workflow.other.id)]}}
        if edit_kind == "plan"
        else {assignees_key: [str(workflow.other.id)]}
    )
    assert_denied(serializer_for(endpoint, workflow, workflow.other, data))


@pytest.mark.parametrize("edit_kind", ["plan", "current", "reset"])
@pytest.mark.parametrize("with_transition", [False, True])
def test_current_assignee_cannot_reconfigure_assignments(endpoint, workflow, edit_kind, with_transition):
    # The creator is distinct from the person currently processing the work item.
    workflow.issue.save(created_by_id=workflow.other.id)
    original_plan = dict(workflow.issue.state_assignees)
    _, state_key, assignees_key = endpoint
    if edit_kind == "plan":
        data = {"state_assignees": {str(workflow.acceptance.id): [str(workflow.developer.id)]}}
    elif edit_kind == "current":
        data = {assignees_key: [str(workflow.developer.id)]}
    else:
        data = {"state_assignees": {}}
    if with_transition:
        data[state_key] = str(workflow.acceptance.id)
    assert_denied(serializer_for(endpoint, workflow, workflow.developer, data))
    workflow.issue.refresh_from_db()
    assert workflow.issue.state_id == workflow.development.id
    assert workflow.issue.state_assignees == original_plan
    assert set(IssueAssignee.objects.filter(issue=workflow.issue).values_list("assignee_id", flat=True)) == {
        workflow.developer.id
    }


def test_non_owner_assignee_can_still_handoff_to_configured_reviewer(endpoint, workflow):
    workflow.issue.save(created_by_id=workflow.other.id)
    _, state_key, _ = endpoint
    issue = save(serializer_for(endpoint, workflow, workflow.developer, {state_key: str(workflow.acceptance.id)}))
    assert issue.state_id == workflow.acceptance.id
    assert set(IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True)) == {
        workflow.reviewer.id
    }


@pytest.mark.parametrize("edit_kind", ["plan", "current", "reset"])
def test_owner_can_configure_after_handoff(endpoint, workflow, edit_kind):
    _, state_key, assignees_key = endpoint
    save(serializer_for(endpoint, workflow, workflow.developer, {state_key: str(workflow.acceptance.id)}))
    if edit_kind == "plan":
        data = {"state_assignees": {str(workflow.acceptance.id): [str(workflow.other.id)]}}
    elif edit_kind == "current":
        assert_denied(serializer_for(endpoint, workflow, workflow.developer, {assignees_key: [str(workflow.other.id)]}))
        return
    else:
        data = {"state_assignees": {}}
    issue = save(serializer_for(endpoint, workflow, workflow.developer, data))
    assert issue.state_id == workflow.acceptance.id
    expected = workflow.developer.id if edit_kind == "reset" else workflow.other.id
    assert set(IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True)) == {expected}
    if edit_kind == "reset":
        assert issue.state_assignees[str(workflow.acceptance.id)] == [str(workflow.developer.id)]
        save(serializer_for(endpoint, workflow, workflow.developer, {state_key: str(workflow.development.id)}))
    else:
        # Editing other stages does not grant the creator a transition bypass.
        assert_denied(serializer_for(endpoint, workflow, workflow.developer, {state_key: str(workflow.development.id)}))


@pytest.mark.parametrize("edit_kind", ["plan", "current"])
def test_project_lead_without_admin_role_cannot_configure(endpoint, workflow, edit_kind):
    workflow.project.project_lead = workflow.other
    workflow.project.save()
    _, _, assignees_key = endpoint
    data = (
        {"state_assignees": {str(workflow.acceptance.id): [str(workflow.other.id)]}}
        if edit_kind == "plan"
        else {assignees_key: [str(workflow.other.id)]}
    )
    assert_denied(serializer_for(endpoint, workflow, workflow.other, data))


def test_stale_creator_cannot_reconfigure_assignments(endpoint, workflow):
    stale = Issue.objects.get(pk=workflow.issue.pk)
    workflow.issue.save(created_by_id=workflow.other.id)
    assert_denied(serializer_for(endpoint, workflow, workflow.developer, {"state_assignees": {}}, instance=stale))


@pytest.mark.parametrize("configured", [True, False])
def test_missing_destination_defaults_to_creator_but_explicit_empty_clears(endpoint, workflow, configured):
    workflow.issue.state_assignees = {str(workflow.acceptance.id): []} if configured else {}
    workflow.issue.save()
    IssueAssignee.objects.filter(issue=workflow.issue).delete()
    IssueAssignee.objects.create(issue=workflow.issue, project=workflow.project, assignee=workflow.other)
    _, state_key, _ = endpoint
    assert_denied(serializer_for(endpoint, workflow, workflow.other, {state_key: str(workflow.acceptance.id)}))
    issue = save(serializer_for(endpoint, workflow, workflow.developer, {state_key: str(workflow.acceptance.id)}))
    assert issue.state_assignees[str(workflow.acceptance.id)] == ([] if configured else [str(workflow.developer.id)])
    assert set(IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True)) == (
        set() if configured else {workflow.developer.id}
    )


def test_explicit_empty_current_overrides_legacy_assignees(endpoint, workflow):
    workflow.issue.state_assignees = {str(workflow.development.id): []}
    workflow.issue.save()
    _, state_key, _ = endpoint
    assert_denied(serializer_for(endpoint, workflow, workflow.developer, {state_key: str(workflow.acceptance.id)}))


def test_admin_can_transition_unassigned_issue(endpoint, workflow):
    workflow.issue.state_assignees = {str(workflow.development.id): []}
    workflow.issue.save()
    _, state_key, _ = endpoint
    save(serializer_for(endpoint, workflow, workflow.admin, {state_key: str(workflow.acceptance.id)}))


def test_active_project_lead_can_transition(endpoint, workflow):
    workflow.project.project_lead = workflow.other
    workflow.project.save()
    _, state_key, _ = endpoint
    save(serializer_for(endpoint, workflow, workflow.other, {state_key: str(workflow.acceptance.id)}))


def test_stale_instance_cannot_reuse_previous_responsibility(endpoint, workflow):
    stale = Issue.objects.get(pk=workflow.issue.pk)
    _, state_key, _ = endpoint
    save(serializer_for(endpoint, workflow, workflow.developer, {state_key: str(workflow.acceptance.id)}))
    assert_denied(
        serializer_for(
            endpoint, workflow, workflow.developer, {state_key: str(workflow.development.id)}, instance=stale
        )
    )


@pytest.mark.parametrize("invalid_kind", ["unknown_state", "foreign_state", "outsider", "inactive", "guest", "shape"])
def test_invalid_assignment_plan_rejected(endpoint, workflow, invalid_kind):
    state_id = str(workflow.development.id)
    user_id = str(workflow.developer.id)
    if invalid_kind == "unknown_state":
        state_id = str(uuid4())
    elif invalid_kind == "foreign_state":
        project = Project.objects.create(name="Foreign", identifier="FR", workspace=workflow.project.workspace)
        state_id = str(State.objects.create(project=project, name="Foreign", group="started").id)
    elif invalid_kind == "outsider":
        user_id = str(User.objects.create(email="outsider@example.com", username="workflow-outsider").id)
    elif invalid_kind in ("inactive", "guest"):
        ProjectMember.objects.filter(project=workflow.project, member=workflow.other).update(
            **({"is_active": False} if invalid_kind == "inactive" else {"role": 5})
        )
        user_id = str(workflow.other.id)
    plan = {state_id: user_id if invalid_kind == "shape" else [user_id]}
    with pytest.raises(ValidationError):
        save(serializer_for(endpoint, workflow, workflow.admin, {"state_assignees": plan}))


def test_creator_can_bootstrap_but_cannot_combine_with_transition(endpoint, workflow):
    workflow.issue.state_assignees = {str(workflow.development.id): []}
    workflow.issue.save()
    IssueAssignee.objects.filter(issue=workflow.issue).delete()
    _, state_key, assignees_key = endpoint
    assert_denied(
        serializer_for(
            endpoint,
            workflow,
            workflow.developer,
            {state_key: str(workflow.acceptance.id), assignees_key: [str(workflow.developer.id)]},
        )
    )
    save(
        serializer_for(
            endpoint,
            workflow,
            workflow.developer,
            {"state_assignees": {str(workflow.development.id): [str(workflow.developer.id)]}},
        )
    )
    save(serializer_for(endpoint, workflow, workflow.developer, {state_key: str(workflow.acceptance.id)}))


def test_owner_can_reassign_even_with_existing_actual_assignments(endpoint, workflow):
    workflow.issue.state_assignees = {str(workflow.development.id): []}
    workflow.issue.save()
    IssueAssignee.objects.filter(issue=workflow.issue).delete()
    IssueAssignee.objects.create(issue=workflow.issue, project=workflow.project, assignee=workflow.reviewer)
    issue = save(
        serializer_for(
            endpoint,
            workflow,
            workflow.developer,
            {"state_assignees": {str(workflow.development.id): [str(workflow.developer.id)]}},
        )
    )
    assert set(IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True)) == {
        workflow.developer.id
    }


def test_current_plan_edit_updates_actual_assignees(endpoint, workflow):
    issue = save(
        serializer_for(
            endpoint,
            workflow,
            workflow.developer,
            {"state_assignees": {str(workflow.development.id): [str(workflow.reviewer.id)]}},
        )
    )
    assert set(IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True)) == {
        workflow.reviewer.id
    }


@pytest.mark.parametrize("actor_name", ["developer", "admin"])
def test_current_assignment_edit_is_rejected_even_for_owner_and_admin(endpoint, workflow, actor_name):
    _, _, assignees_key = endpoint
    original_plan = dict(workflow.issue.state_assignees)
    assert_denied(
        serializer_for(endpoint, workflow, getattr(workflow, actor_name), {assignees_key: [str(workflow.reviewer.id)]})
    )
    workflow.issue.refresh_from_db()
    assert workflow.issue.state_assignees == original_plan
    assert set(IssueAssignee.objects.filter(issue=workflow.issue).values_list("assignee_id", flat=True)) == {
        workflow.developer.id
    }


@pytest.mark.parametrize("same_state_field", [True, False])
def test_title_edit_does_not_validate_or_rewrite_stale_assignment(endpoint, workflow, same_state_field):
    ProjectMember.objects.filter(project=workflow.project, member=workflow.developer).update(is_active=False)
    original_plan = dict(workflow.issue.state_assignees)
    _, state_key, _ = endpoint
    data = {"name": "Renamed despite stale assignment"}
    if same_state_field:
        data[state_key] = str(workflow.development.pk)
    issue = save(serializer_for(endpoint, workflow, workflow.admin, data))
    assert issue.name == data["name"]
    assert issue.state_assignees == original_plan
    assert set(IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True)) == {
        workflow.developer.pk
    }


def test_inactive_destination_member_rejected_at_transition(endpoint, workflow):
    ProjectMember.objects.filter(project=workflow.project, member=workflow.reviewer).update(is_active=False)
    _, state_key, _ = endpoint
    with pytest.raises(ValidationError):
        save(serializer_for(endpoint, workflow, workflow.developer, {state_key: str(workflow.acceptance.id)}))
    workflow.issue.refresh_from_db()
    assert workflow.issue.state_id == workflow.development.id
    assert set(IssueAssignee.objects.filter(issue=workflow.issue).values_list("assignee_id", flat=True)) == {
        workflow.developer.id
    }


@pytest.mark.parametrize("group", ["backlog", "completed", "cancelled"])
def test_admin_can_repair_plan_with_stale_creator_in_fixed_stage(endpoint, workflow, group):
    fixed = State.objects.create(project=workflow.project, name=group, group=group)
    ProjectMember.objects.filter(project=workflow.project, member=workflow.developer).update(is_active=False)
    payload = {
        "state_assignees": {
            str(fixed.pk): [str(workflow.developer.pk)],
            str(workflow.development.pk): [str(workflow.other.pk)],
            str(workflow.acceptance.pk): [str(workflow.reviewer.pk)],
        }
    }
    issue = save(serializer_for(endpoint, workflow, workflow.admin, payload))
    assert issue.state_assignees[str(fixed.pk)] == []
    assert issue.state_assignees[str(workflow.development.pk)] == [str(workflow.other.pk)]
    assert set(IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True)) == {workflow.other.pk}


@pytest.mark.parametrize("group", ["backlog", "completed", "cancelled"])
@pytest.mark.parametrize("operation", ["create-plan", "create-direct", "update"])
def test_fixed_stage_rejects_custom_assignment(endpoint, workflow, group, operation):
    fixed = State.objects.create(project=workflow.project, name=group, group=group)
    serializer_class, state_key, assignee_key = endpoint
    data = {"state_assignees": {str(fixed.pk): [str(workflow.other.pk)]}}
    if operation == "update":
        serializer = serializer_for(endpoint, workflow, workflow.admin, data)
    else:
        if operation == "create-direct":
            data = {assignee_key: [str(workflow.other.pk)]}
        data.update({"name": "Fixed-stage override", state_key: str(fixed.pk)})
        serializer = serializer_class(
            data=data,
            context={
                "request": SimpleNamespace(user=workflow.developer),
                "project_id": workflow.project.pk,
                "workspace_id": workflow.project.workspace_id,
                "default_assignee_id": None,
            },
        )
    with pytest.raises(ValidationError):
        save(serializer)
    assert not Issue.objects.filter(project=workflow.project, name="Fixed-stage override").exists()
    workflow.issue.refresh_from_db()
    assert str(fixed.pk) not in workflow.issue.state_assignees


@pytest.mark.parametrize("group", ["backlog", "completed", "cancelled"])
def test_fixed_stage_handoff_normalizes_historic_custom_assignment(endpoint, workflow, group):
    fixed = State.objects.create(project=workflow.project, name=group, group=group)
    workflow.issue.state_assignees[str(fixed.pk)] = [str(workflow.other.pk)]
    workflow.issue.save()
    _, state_key, _ = endpoint
    issue = save(serializer_for(endpoint, workflow, workflow.developer, {state_key: str(fixed.pk)}))
    assert issue.state_assignees[str(fixed.pk)] == [str(workflow.developer.pk)]
    assert set(IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True)) == {
        workflow.developer.pk
    }
    assert_denied(serializer_for(endpoint, workflow, workflow.other, {state_key: str(workflow.development.pk)}))


@pytest.mark.parametrize("mode", ["default", "stages", "direct", "empty", "conflict"])
def test_creation_materializes_every_stage(endpoint, workflow, mode):
    State.objects.create(project=workflow.project, name="Triage", group="triage")
    fixed_states = [
        State.objects.create(project=workflow.project, name=group, group=group)
        for group in ("backlog", "completed", "cancelled")
    ]
    serializer_class, state_key, assignee_key = endpoint
    data = {"name": "Explicit stages", state_key: str(workflow.development.pk)}
    initial = [str(workflow.developer.pk)]
    future = initial
    if mode == "stages":
        initial, future = [str(workflow.other.pk)], [str(workflow.reviewer.pk)]
        data["state_assignees"] = {
            str(workflow.development.pk): initial,
            str(workflow.acceptance.pk): future,
        }
    elif mode in ("direct", "empty", "conflict"):
        initial = [] if mode == "empty" else [str(workflow.other.pk)]
        data[assignee_key] = initial
        if mode == "conflict":
            data["state_assignees"] = {str(workflow.development.pk): []}
    serializer = serializer_class(
        data=data,
        context={
            "request": SimpleNamespace(user=workflow.developer),
            "project_id": workflow.project.pk,
            "workspace_id": workflow.project.workspace_id,
            "default_assignee_id": workflow.admin.pk,
        },
    )
    if mode == "conflict":
        with pytest.raises(ValidationError):
            save(serializer)
        assert not Issue.objects.filter(project=workflow.project, name=data["name"]).exists()
        return
    issue = save(serializer)
    issue.refresh_from_db()
    assert issue.state_assignees == {
        str(workflow.development.pk): initial,
        str(workflow.acceptance.pk): future,
        **{str(state.pk): [str(workflow.developer.pk)] for state in fixed_states},
    }
    assert (
        sorted(str(pk) for pk in IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True))
        == initial
    )


@pytest.mark.parametrize("invalid_creator", ["inactive", "guest", "removed", "disabled", "null"])
def test_missing_stage_with_invalid_creator_is_explicitly_unassigned(endpoint, workflow, invalid_creator):
    workflow.issue.state_assignees = {str(workflow.development.pk): [str(workflow.other.pk)]}
    if invalid_creator == "null":
        Issue.objects.filter(pk=workflow.issue.pk).update(created_by_id=None)
        workflow.issue.created_by_id = None
    elif invalid_creator == "disabled":
        User.objects.filter(pk=workflow.developer.pk).update(is_active=False)
    elif invalid_creator == "removed":
        ProjectMember.objects.filter(project=workflow.project, member=workflow.developer).delete()
    else:
        ProjectMember.objects.filter(project=workflow.project, member=workflow.developer).update(
            **({"is_active": False} if invalid_creator == "inactive" else {"role": 5})
        )
    workflow.issue.save(disable_auto_set_user=True)
    _, state_key, _ = endpoint
    issue = save(serializer_for(endpoint, workflow, workflow.admin, {state_key: str(workflow.acceptance.pk)}))
    assert issue.state_assignees[str(workflow.acceptance.pk)] == []
    assert not IssueAssignee.objects.filter(issue=issue).exists()


def test_new_stage_defaults_to_creator_and_deleted_stage_is_pruned(endpoint, workflow):
    from django.utils import timezone

    new_state = State.objects.create(project=workflow.project, name="New review", group="started")
    State.all_state_objects.filter(pk=workflow.acceptance.pk).update(deleted_at=timezone.now())
    _, state_key, _ = endpoint
    issue = save(serializer_for(endpoint, workflow, workflow.developer, {state_key: str(new_state.pk)}))
    assert issue.state_assignees[str(new_state.pk)] == [str(workflow.developer.pk)]
    assert str(workflow.acceptance.pk) not in issue.state_assignees
    assert set(IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True)) == {
        workflow.developer.pk
    }


def test_creation_applies_configured_initial_state(endpoint, workflow):
    serializer_class, state_key, _ = endpoint
    serializer = serializer_class(
        data={
            "name": "Created",
            state_key: str(workflow.development.id),
            "state_assignees": {str(workflow.development.id): [str(workflow.reviewer.id)]},
        },
        context={
            "request": SimpleNamespace(user=workflow.developer),
            "project_id": workflow.project.id,
            "workspace_id": workflow.project.workspace_id,
            "default_assignee_id": workflow.admin.id,
        },
    )
    issue = save(serializer)
    assert set(IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True)) == {
        workflow.reviewer.id
    }


def test_intake_creation_allows_triage_state_with_context(endpoint, workflow):
    triage = State.objects.create(project=workflow.project, name="Triage", group="triage")
    serializer_class, state_key, _ = endpoint
    serializer = serializer_class(
        data={
            "name": "Intake item",
            state_key: str(triage.id),
            "state_assignees": {str(triage.id): [str(workflow.reviewer.id)]},
        },
        context={
            "request": SimpleNamespace(user=workflow.admin),
            "project_id": workflow.project.id,
            "workspace_id": workflow.project.workspace_id,
            "default_assignee_id": None,
            "allow_triage_state": True,
        },
    )
    issue = save(serializer)
    assert issue.state_id == triage.id
    assert set(IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True)) == {
        workflow.reviewer.id
    }


def test_intake_acceptance_checks_current_responsibility_and_hands_off(endpoint, workflow):
    from plane.api.serializers.intake import IntakeIssueUpdateSerializer
    from plane.app.serializers.intake import IntakeIssueSerializer
    from plane.db.models import Intake, IntakeIssue

    triage = State.objects.create(project=workflow.project, name="Triage", group="triage")
    workflow.issue.state = triage
    workflow.issue.state_assignees = {
        str(triage.id): [str(workflow.developer.id)],
        str(workflow.development.id): [str(workflow.reviewer.id)],
    }
    workflow.issue.save()
    intake = Intake.objects.create(project=workflow.project, name="Intake")
    item = IntakeIssue.objects.create(project=workflow.project, intake=intake, issue=workflow.issue)
    serializer_class = IntakeIssueSerializer if endpoint[1] == "state_id" else IntakeIssueUpdateSerializer
    context = {
        "project_id": workflow.project.id,
        "workspace_id": workflow.project.workspace_id,
        "allow_triage_state": True,
        "request": SimpleNamespace(user=workflow.other),
    }
    assert_denied(serializer_class(item, data={"status": 1}, partial=True, context=context))
    item.refresh_from_db()
    workflow.issue.refresh_from_db()
    assert item.status == -2
    assert workflow.issue.state_id == triage.id
    context["request"] = SimpleNamespace(user=workflow.admin)
    save(serializer_class(item, data={"status": 1}, partial=True, context=context))
    item.refresh_from_db()
    workflow.issue.refresh_from_db()
    assert item.status == 1
    assert workflow.issue.state_id == workflow.development.id
    assert set(IssueAssignee.objects.filter(issue=workflow.issue).values_list("assignee_id", flat=True)) == {
        workflow.reviewer.id
    }


@pytest.mark.parametrize("configured", [True, False])
def test_automatic_close_synchronizes_destination_assignees(workflow, monkeypatch, configured):
    from datetime import timedelta
    from django.utils import timezone
    from plane.bgtasks import issue_automation_task

    monkeypatch.setattr(issue_automation_task.issue_activity, "delay", lambda **kwargs: None)
    workflow.project.close_in = 1
    workflow.project.default_state = workflow.acceptance
    workflow.project.save()
    if not configured:
        workflow.issue.state_assignees = {str(workflow.development.pk): [str(workflow.other.pk)]}
        workflow.issue.save()
        IssueAssignee.objects.filter(issue=workflow.issue).delete()
        IssueAssignee.objects.create(issue=workflow.issue, project=workflow.project, assignee=workflow.other)
    Issue.objects.filter(pk=workflow.issue.pk).update(updated_at=timezone.now() - timedelta(days=90))
    issue_automation_task.close_old_issues()
    workflow.issue.refresh_from_db()
    assert workflow.issue.state_id == workflow.acceptance.id
    expected = workflow.reviewer.id if configured else workflow.developer.id
    assert set(IssueAssignee.objects.filter(issue=workflow.issue).values_list("assignee_id", flat=True)) == {expected}
    assert workflow.issue.state_assignees[str(workflow.acceptance.pk)] == [str(expected)]


def test_api_creation_activity_tracks_effective_assignees(workflow, monkeypatch):
    import json
    from plane.bgtasks import issue_activities_task

    calls = []
    monkeypatch.setattr(issue_activities_task, "track_assignees", lambda *args: calls.append(args[0]))
    issue_activities_task.create_issue_activity(
        requested_data=json.dumps({"assignees": [str(workflow.reviewer.id)]}),
        current_instance=None,
        issue_id=workflow.issue.id,
        project_id=workflow.project.id,
        workspace_id=workflow.project.workspace_id,
        actor_id=workflow.developer.id,
        issue_activities=[],
        epoch=0,
    )
    assert calls == [{"assignees": [str(workflow.reviewer.id)]}]


def test_alternate_write_alias_cannot_bypass(endpoint, workflow):
    _, state_key, _ = endpoint
    alias = "state" if state_key == "state_id" else "state_id"
    with pytest.raises(ValidationError):
        save(serializer_for(endpoint, workflow, workflow.other, {alias: str(workflow.acceptance.id)}))
