# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from types import SimpleNamespace

import pytest

from plane.db.models import Issue, IssueAssignee, ProjectMember, State
from plane.tests.contract.api import test_issue_workflow_permissions as workflow_fixtures

pytestmark = [pytest.mark.contract, pytest.mark.django_db]
disable_workflow_background_tasks = workflow_fixtures.disable_workflow_background_tasks
workflow_issue = workflow_fixtures.workflow_issue
workflow_request_settings = workflow_fixtures.workflow_request_settings

COMPLETION_ERROR = {
    "code": "unfinished_sub_issues",
    "error": "Finish or cancel all sub-work items before completing this work item.",
}


@pytest.fixture(params=["app", "public-issues", "public-work-items"])
def completion_endpoint(request, workflow_issue):
    issue = workflow_issue.issue
    public = request.param != "app"
    client = request.getfixturevalue("api_key_client" if public else "session_client")
    route = "work-items" if request.param == "public-work-items" else "issues"
    prefix = "/api/v1" if public else "/api"
    base = f"{prefix}/workspaces/{issue.workspace.slug}/projects/{issue.project_id}/{route}/"
    state_key = "state" if public else "state_id"

    def transition(state, issue_id=None):
        return client.patch(f"{base}{issue_id or issue.pk}/", {state_key: str(state.pk)}, format="json")

    return SimpleNamespace(transition=transition, client=client, state_key=state_key)


@pytest.fixture
def completion_states(workflow_issue):
    project = workflow_issue.issue.project
    return {
        group: State.objects.create(name=f"Completion {group}", group=group, color="#000000", project=project)
        for group in ("completed", "cancelled", "backlog", "unstarted", "triage")
    }


def make_child(workflow, state, parent=None):
    return Issue.objects.create(
        name="Completion descendant",
        project=workflow.issue.project,
        state=state,
        parent=parent or workflow.issue,
    )


@pytest.mark.parametrize("depth", [1, 2])
@pytest.mark.parametrize("actor", ["creator", "assignee", "administrator"])
def test_cannot_complete_a_parent_with_an_unfinished_descendant(
    completion_endpoint, workflow_issue, completion_states, depth, actor
):
    workflow = workflow_issue
    if actor == "assignee":
        completion_endpoint.client.force_authenticate(user=workflow.current_owner)
    elif actor == "administrator":
        ProjectMember.objects.filter(pk=workflow.membership.pk).update(role=20)
    parent = workflow.issue
    if depth == 2:
        parent = make_child(workflow, completion_states["completed"])
    child = make_child(workflow, workflow.development, parent=parent)
    plan = dict(workflow.issue.state_assignees)
    assignees = set(IssueAssignee.objects.filter(issue=workflow.issue).values_list("assignee_id", flat=True))

    response = completion_endpoint.transition(completion_states["completed"])

    assert response.status_code == 400, response.data
    assert response.data["code"] == "unfinished_sub_issues"
    assert response.json()["code"] == "unfinished_sub_issues"
    assert response.json() == COMPLETION_ERROR
    workflow.issue.refresh_from_db()
    child.refresh_from_db()
    assert workflow.issue.state_id == workflow.development.pk
    assert workflow.issue.completed_at is None
    assert workflow.issue.state_assignees == plan
    assert set(IssueAssignee.objects.filter(issue=workflow.issue).values_list("assignee_id", flat=True)) == assignees
    assert child.state_id == workflow.development.pk


@pytest.mark.parametrize("group", ["backlog", "unstarted", "triage", None])
def test_every_nonterminal_descendant_blocks_completion(completion_endpoint, workflow_issue, completion_states, group):
    child = make_child(workflow_issue, completion_states.get(group, workflow_issue.development))
    if group is None:
        Issue.objects.filter(pk=child.pk).update(state=None)
    response = completion_endpoint.transition(completion_states["completed"])
    assert response.status_code == 400, response.data
    assert response.data["code"] == "unfinished_sub_issues"
    assert response.json()["code"] == "unfinished_sub_issues"
    assert response.json() == COMPLETION_ERROR


def test_terminal_descendants_and_deleted_branches_allow_completion(
    completion_endpoint, workflow_issue, completion_states
):
    completed = make_child(workflow_issue, completion_states["completed"])
    make_child(workflow_issue, completion_states["cancelled"], parent=completed)
    deleted = make_child(workflow_issue, workflow_issue.development)
    make_child(workflow_issue, workflow_issue.development, parent=deleted)
    Issue.objects.filter(pk=deleted.pk).delete()

    response = completion_endpoint.transition(completion_states["completed"])

    assert response.status_code == 200, response.data
    workflow_issue.issue.refresh_from_db()
    assert workflow_issue.issue.state_id == completion_states["completed"].pk
    assert workflow_issue.issue.completed_at is not None


def test_cancelled_intermediate_descendant_does_not_hide_unfinished_grandchildren(
    completion_endpoint, workflow_issue, completion_states
):
    cancelled = make_child(workflow_issue, completion_states["cancelled"])
    make_child(workflow_issue, workflow_issue.development, parent=cancelled)
    response = completion_endpoint.transition(completion_states["completed"])
    assert response.status_code == 400, response.data


def test_noncompletion_transitions_are_still_allowed_with_unfinished_children(
    completion_endpoint, workflow_issue, completion_states
):
    make_child(workflow_issue, workflow_issue.development)
    response = completion_endpoint.transition(workflow_issue.acceptance)
    assert response.status_code == 200, response.data
    response = completion_endpoint.transition(completion_states["cancelled"])
    assert response.status_code == 200, response.data


def test_completion_guard_does_not_disclose_subtree_to_an_unauthorized_actor(
    completion_endpoint, workflow_issue, completion_states
):
    make_child(workflow_issue, workflow_issue.development)
    Issue.objects.filter(pk=workflow_issue.issue.pk).update(state_assignees={str(workflow_issue.development.pk): []})
    completion_endpoint.client.force_authenticate(user=workflow_issue.current_owner)
    response = completion_endpoint.transition(completion_states["completed"])
    assert response.status_code == 403, response.data
    assert "unfinished" not in str(response.data).lower()


def test_completion_is_allowed_after_the_last_child_finishes(completion_endpoint, workflow_issue, completion_states):
    child = make_child(workflow_issue, workflow_issue.development)
    rejected = completion_endpoint.transition(completion_states["completed"])
    assert rejected.status_code == 400, rejected.data
    child.state = completion_states["completed"]
    child.save()
    response = completion_endpoint.transition(completion_states["completed"])
    assert response.status_code == 200, response.data


def test_automatic_completion_skips_blocked_parent_and_continues_with_other_candidates(
    workflow_issue, completion_states, monkeypatch
):
    from datetime import timedelta
    from unittest.mock import Mock

    from django.utils import timezone
    from plane.bgtasks.issue_automation_task import close_old_issues
    from plane.db.models import Project

    issue = workflow_issue.issue
    # The child was updated recently and is not an auto-close candidate.
    child = make_child(workflow_issue, workflow_issue.development)
    sibling = Issue.objects.create(
        name="Independent candidate", project=issue.project, state=workflow_issue.development
    )
    Project.objects.filter(pk=issue.project_id).update(close_in=1, default_state=completion_states["completed"])
    old = timezone.now() - timedelta(days=40)
    Issue.objects.filter(pk__in=[issue.pk, sibling.pk]).update(updated_at=old)
    monkeypatch.setattr("plane.bgtasks.issue_automation_task.issue_activity.delay", Mock())
    errors = Mock()
    monkeypatch.setattr("plane.bgtasks.issue_automation_task.log_exception", errors)
    assignees = set(IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True))

    close_old_issues()

    issue.refresh_from_db()
    child.refresh_from_db()
    sibling.refresh_from_db()
    assert issue.state_id == workflow_issue.development.pk
    assert issue.completed_at is None
    assert set(IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True)) == assignees
    assert child.state_id == workflow_issue.development.pk
    assert sibling.state_id == completion_states["completed"].pk
    errors.assert_not_called()


@pytest.mark.parametrize("has_completed_descendant", [False, True])
def test_child_can_finish_independently_of_its_unfinished_parent_and_sibling(
    completion_endpoint, workflow_issue, completion_states, has_completed_descendant
):
    child = make_child(workflow_issue, workflow_issue.development)
    child.save(created_by_id=workflow_issue.actor.pk)
    sibling = make_child(workflow_issue, workflow_issue.development)
    if has_completed_descendant:
        make_child(workflow_issue, completion_states["completed"], parent=child)

    response = completion_endpoint.transition(completion_states["completed"], issue_id=child.pk)

    assert response.status_code == 200, response.data
    child.refresh_from_db()
    sibling.refresh_from_db()
    workflow_issue.issue.refresh_from_db()
    assert child.state_id == completion_states["completed"].pk
    assert child.completed_at is not None
    assert sibling.state_id == workflow_issue.development.pk
    assert workflow_issue.issue.state_id == workflow_issue.development.pk
    rejected = completion_endpoint.transition(completion_states["completed"])
    assert rejected.status_code == 400, rejected.data
    assert rejected.json() == COMPLETION_ERROR


@pytest.mark.parametrize("target", ["eligible-parent", "independent-child"])
def test_automatic_completion_preserves_valid_parent_and_child_transitions(
    workflow_issue, completion_states, monkeypatch, target
):
    from datetime import timedelta
    from unittest.mock import Mock

    from django.utils import timezone
    from plane.bgtasks.issue_automation_task import close_old_issues
    from plane.db.models import Project

    parent = workflow_issue.issue
    if target == "eligible-parent":
        make_child(workflow_issue, completion_states["completed"])
        make_child(workflow_issue, completion_states["cancelled"])
        issue = parent
    else:
        issue = make_child(workflow_issue, workflow_issue.development)
        issue.save(created_by_id=workflow_issue.actor.pk)
    Project.objects.filter(pk=parent.project_id).update(close_in=1, default_state=completion_states["completed"])
    Issue.objects.filter(pk=issue.pk).update(updated_at=timezone.now() - timedelta(days=40))
    errors = Mock()
    monkeypatch.setattr("plane.bgtasks.issue_automation_task.log_exception", errors)
    monkeypatch.setattr("plane.bgtasks.issue_automation_task.issue_activity.delay", Mock())

    close_old_issues()

    issue.refresh_from_db()
    assert issue.state_id == completion_states["completed"].pk
    assert issue.completed_at is not None
    if target == "independent-child":
        parent.refresh_from_db()
        assert parent.state_id == workflow_issue.development.pk
    errors.assert_not_called()
