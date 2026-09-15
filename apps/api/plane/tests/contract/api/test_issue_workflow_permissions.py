# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from importlib import import_module
from types import SimpleNamespace

import pytest
from rest_framework import status

from plane.db.models import Issue, IssueAssignee, Project, ProjectMember, State, User, WorkspaceMember


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture(autouse=True)
def workflow_request_settings(settings):
    from django.core.cache import cache

    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
    settings.WEB_URL = "http://testserver"
    settings.APP_BASE_URL = "http://testserver"
    cache.clear()
    yield
    cache.clear()


@pytest.fixture(autouse=True)
def disable_workflow_background_tasks(monkeypatch):
    """Exercise HTTP and persistence without sending work to a broker."""
    task_names = {
        "plane.middleware.logger": ("process_logs",),
        "plane.api.views.issue": ("issue_activity", "model_activity"),
        "plane.app.views.issue.base": (
            "issue_activity",
            "model_activity",
            "issue_description_version_task",
        ),
    }
    for module_name, names in task_names.items():
        module = import_module(module_name)
        for name in names:
            monkeypatch.setattr(getattr(module, name), "delay", lambda *args, **kwargs: None)


@pytest.fixture
def workflow_issue(workspace, create_user):
    project = Project.objects.create(
        name="Workflow permissions", identifier="WFP", workspace=workspace, created_by=create_user
    )
    membership = ProjectMember.objects.create(project=project, member=create_user, role=15, is_active=True)
    current_owner = User.objects.create(email="current-workflow-owner@plane.so", username="current-workflow-owner")
    WorkspaceMember.objects.create(workspace=workspace, member=current_owner, role=15)
    ProjectMember.objects.create(project=project, member=current_owner, role=15, is_active=True)
    development = State.objects.create(
        name="开发中",
        group="started",
        color="#F59E0B",
        default=True,
        project=project,
        workspace=workspace,
    )
    acceptance = State.objects.create(
        name="开发完成/待验收",
        group="started",
        color="#F59E0B",
        project=project,
        workspace=workspace,
    )
    plan = {
        str(development.pk): [str(current_owner.pk)],
        str(acceptance.pk): [str(create_user.pk)],
    }
    issue = Issue.objects.create(
        name="Development owned by another member",
        project=project,
        workspace=workspace,
        state=development,
        state_assignees=plan,
        created_by=create_user,
    )
    issue.save(created_by_id=create_user.pk)
    IssueAssignee.objects.create(
        issue=issue,
        assignee=current_owner,
        project=project,
        workspace=workspace,
    )
    # The actor is the creator and a future assignee; denial tests explicitly
    # transfer ownership when isolating future-assignee access.
    WorkspaceMember.objects.filter(workspace=workspace, member=create_user).update(role=15)
    assert membership.role == 15
    assert project.project_lead_id is None
    return SimpleNamespace(
        issue=issue,
        membership=membership,
        development=development,
        acceptance=acceptance,
        current_owner=current_owner,
        actor=create_user,
        plan=plan,
    )


@pytest.fixture(params=["public-api", "app"], ids=["public-api", "app"])
def workflow_endpoint(request, workflow_issue):
    public = request.param == "public-api"
    client = request.getfixturevalue("api_key_client" if public else "session_client")
    issue = workflow_issue.issue
    prefix = "/api/v1" if public else "/api"
    url = f"{prefix}/workspaces/{issue.workspace.slug}/projects/{issue.project_id}/issues/{issue.pk}/"
    return SimpleNamespace(
        client=client,
        url=url,
        state_field="state" if public else "state_id",
        assignee_field="assignees" if public else "assignee_ids",
        success_status=status.HTTP_200_OK,
    )


def assert_workflow_unchanged(workflow):
    workflow.issue.refresh_from_db()
    assert workflow.issue.state_id == workflow.development.pk
    assert workflow.issue.state_assignees == workflow.plan
    assert set(IssueAssignee.objects.filter(issue=workflow.issue).values_list("assignee_id", flat=True)) == {
        workflow.current_owner.pk
    }


def test_destination_assignee_cannot_change_current_state(workflow_endpoint, workflow_issue):
    workflow_issue.issue.save(created_by_id=workflow_issue.current_owner.pk)
    endpoint = workflow_endpoint
    response = endpoint.client.patch(
        endpoint.url, {endpoint.state_field: str(workflow_issue.acceptance.pk)}, format="json"
    )

    assert response.status_code == status.HTTP_403_FORBIDDEN, response.data
    assert_workflow_unchanged(workflow_issue)


@pytest.mark.parametrize("assignment_source", ["actual-assignees", "state-plan"])
def test_self_assignment_cannot_authorize_same_request_state_change(
    workflow_endpoint, workflow_issue, assignment_source
):
    workflow_issue.issue.save(created_by_id=workflow_issue.current_owner.pk)
    endpoint = workflow_endpoint
    actor_id = str(workflow_issue.actor.pk)
    payload = {endpoint.state_field: str(workflow_issue.acceptance.pk)}
    if assignment_source == "actual-assignees":
        payload[endpoint.assignee_field] = [actor_id]
    else:
        payload["state_assignees"] = {
            str(workflow_issue.development.pk): [actor_id],
            str(workflow_issue.acceptance.pk): [actor_id],
        }

    response = endpoint.client.patch(endpoint.url, payload, format="json")

    assert response.status_code == status.HTTP_403_FORBIDDEN, response.data
    assert_workflow_unchanged(workflow_issue)


def test_project_admin_can_handoff_and_sync_destination_assignees(workflow_endpoint, workflow_issue):
    workflow_issue.membership.role = 20
    workflow_issue.membership.save(update_fields=["role"])
    endpoint = workflow_endpoint

    response = endpoint.client.patch(
        endpoint.url, {endpoint.state_field: str(workflow_issue.acceptance.pk)}, format="json"
    )

    assert response.status_code == endpoint.success_status, response.data
    workflow_issue.issue.refresh_from_db()
    assert workflow_issue.issue.state_id == workflow_issue.acceptance.pk
    assert workflow_issue.issue.state_assignees == workflow_issue.plan
    assert response.json()[endpoint.state_field] == str(workflow_issue.acceptance.pk)
    assert response.data[endpoint.assignee_field] == [str(workflow_issue.actor.pk)]
    assert response.data["state_assignees"] == workflow_issue.plan
    assert set(IssueAssignee.objects.filter(issue=workflow_issue.issue).values_list("assignee_id", flat=True)) == {
        workflow_issue.actor.pk
    }


@pytest.mark.parametrize("active_membership", [True, False])
def test_workspace_admin_requires_active_project_membership(workflow_endpoint, workflow_issue, active_membership):
    issue = workflow_issue.issue
    WorkspaceMember.objects.filter(workspace=issue.workspace, member=workflow_issue.actor).update(role=20)
    ProjectMember.objects.filter(pk=workflow_issue.membership.pk).update(is_active=active_membership)
    endpoint = workflow_endpoint
    response = endpoint.client.patch(
        endpoint.url, {endpoint.state_field: str(workflow_issue.acceptance.pk)}, format="json"
    )
    if active_membership:
        assert response.status_code == status.HTTP_200_OK, response.data
        assert response.data[endpoint.assignee_field] == [str(workflow_issue.actor.pk)]
    else:
        assert response.status_code == status.HTTP_403_FORBIDDEN, response.data
        assert_workflow_unchanged(workflow_issue)


def test_current_owner_handoff_returns_actual_owners_and_revokes_access(workflow_endpoint, workflow_issue):
    endpoint = workflow_endpoint
    endpoint.client.force_authenticate(user=workflow_issue.current_owner)
    response = endpoint.client.patch(
        endpoint.url, {endpoint.state_field: str(workflow_issue.acceptance.pk)}, format="json"
    )
    assert response.status_code == status.HTTP_200_OK, response.data
    assert response.data[endpoint.assignee_field] == [str(workflow_issue.actor.pk)]
    assert response.json()[endpoint.state_field] == str(workflow_issue.acceptance.pk)
    assert response.data["state_assignees"] == workflow_issue.plan
    rejected = endpoint.client.patch(
        endpoint.url, {endpoint.state_field: str(workflow_issue.development.pk)}, format="json"
    )
    assert rejected.status_code == status.HTTP_403_FORBIDDEN, rejected.data
    workflow_issue.issue.refresh_from_db()
    assert workflow_issue.issue.state_id == workflow_issue.acceptance.pk


@pytest.mark.parametrize("assignment_source", ["actual-assignees", "state-plan", "reset"])
@pytest.mark.parametrize("with_transition", [False, True])
def test_current_assignee_cannot_change_assignments(
    workflow_endpoint, workflow_issue, assignment_source, with_transition
):
    endpoint = workflow_endpoint
    endpoint.client.force_authenticate(user=workflow_issue.current_owner)
    if assignment_source == "actual-assignees":
        payload = {endpoint.assignee_field: [str(workflow_issue.current_owner.pk)]}
    elif assignment_source == "state-plan":
        payload = {"state_assignees": {str(workflow_issue.acceptance.pk): [str(workflow_issue.current_owner.pk)]}}
    else:
        payload = {"state_assignees": {}}
    if with_transition:
        payload[endpoint.state_field] = str(workflow_issue.acceptance.pk)
    response = endpoint.client.patch(endpoint.url, payload, format="json")
    assert response.status_code == status.HTTP_403_FORBIDDEN, response.data
    assert_workflow_unchanged(workflow_issue)


@pytest.mark.parametrize("assignment_source", ["actual-assignees", "state-plan", "reset"])
def test_owner_can_manage_an_already_assigned_work_item(workflow_endpoint, workflow_issue, assignment_source):
    endpoint = workflow_endpoint
    owner_id = str(workflow_issue.actor.pk)
    if assignment_source == "actual-assignees":
        payload = {endpoint.assignee_field: [owner_id]}
    elif assignment_source == "state-plan":
        payload = {"state_assignees": {str(workflow_issue.development.pk): [owner_id]}}
    else:
        payload = {"state_assignees": {}}
    response = endpoint.client.patch(endpoint.url, payload, format="json")
    if assignment_source == "actual-assignees":
        assert response.status_code == status.HTTP_403_FORBIDDEN, response.data
        assert_workflow_unchanged(workflow_issue)
        return
    assert response.status_code == status.HTTP_200_OK, response.data
    assert response.json()[endpoint.state_field] == str(workflow_issue.development.pk)
    assert response.json()[endpoint.assignee_field] == [owner_id]
    if assignment_source == "reset":
        assert response.json()["state_assignees"][str(workflow_issue.development.pk)] == [owner_id]
        assert response.json()["state_assignees"][str(workflow_issue.acceptance.pk)] == [owner_id]


@pytest.mark.parametrize("administrator", ["project", "workspace"])
def test_non_owner_administrator_can_manage_assignments(workflow_endpoint, workflow_issue, administrator):
    endpoint = workflow_endpoint
    administrator_user = workflow_issue.current_owner
    endpoint.client.force_authenticate(user=administrator_user)
    if administrator == "project":
        ProjectMember.objects.filter(project=workflow_issue.issue.project, member=administrator_user).update(role=20)
    else:
        WorkspaceMember.objects.filter(workspace=workflow_issue.issue.workspace, member=administrator_user).update(
            role=20
        )
    response = endpoint.client.patch(
        endpoint.url, {endpoint.assignee_field: [str(workflow_issue.actor.pk)]}, format="json"
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN, response.data
    assert_workflow_unchanged(workflow_issue)
    response = endpoint.client.patch(
        endpoint.url,
        {"state_assignees": {str(workflow_issue.development.pk): [str(workflow_issue.actor.pk)]}},
        format="json",
    )
    assert response.status_code == status.HTTP_200_OK, response.data
    assert response.json()[endpoint.assignee_field] == [str(workflow_issue.actor.pk)]


@pytest.mark.parametrize("current_configured", [True, False])
def test_missing_target_defaults_to_creator_without_inheriting_actual_assignees(
    workflow_endpoint, workflow_issue, current_configured
):
    endpoint = workflow_endpoint
    issue = workflow_issue.issue
    issue.state_assignees = (
        {str(workflow_issue.development.pk): [str(workflow_issue.current_owner.pk)]} if current_configured else {}
    )
    issue.save(created_by_id=workflow_issue.actor.pk)
    endpoint.client.force_authenticate(user=workflow_issue.current_owner)
    payload = {endpoint.state_field: str(workflow_issue.acceptance.pk)}
    response = endpoint.client.patch(endpoint.url, payload, format="json")
    if not current_configured:
        assert response.status_code == status.HTTP_403_FORBIDDEN, response.data
        endpoint.client.force_authenticate(user=workflow_issue.actor)
        response = endpoint.client.patch(endpoint.url, payload, format="json")
    assert response.status_code == status.HTTP_200_OK, response.data
    assert response.json()[endpoint.assignee_field] == [str(workflow_issue.actor.pk)]
    assert response.json()["state_assignees"][str(workflow_issue.acceptance.pk)] == [str(workflow_issue.actor.pk)]


def test_project_lead_does_not_gain_assignment_configuration_permissions(workflow_endpoint, workflow_issue):
    endpoint = workflow_endpoint
    project = workflow_issue.issue.project
    project.project_lead = workflow_issue.current_owner
    project.save(update_fields=["project_lead"])
    endpoint.client.force_authenticate(user=workflow_issue.current_owner)
    response = endpoint.client.patch(endpoint.url, {"state_assignees": {}}, format="json")
    assert response.status_code == status.HTTP_403_FORBIDDEN, response.data
    assert_workflow_unchanged(workflow_issue)


@pytest.mark.parametrize("invalid_membership", ["inactive", "guest"])
def test_owner_requires_active_member_access_to_configure(workflow_endpoint, workflow_issue, invalid_membership):
    ProjectMember.objects.filter(pk=workflow_issue.membership.pk).update(
        **({"is_active": False} if invalid_membership == "inactive" else {"role": 5})
    )
    response = workflow_endpoint.client.patch(workflow_endpoint.url, {"state_assignees": {}}, format="json")
    assert response.status_code == status.HTTP_403_FORBIDDEN, response.data
    assert_workflow_unchanged(workflow_issue)


def test_current_assignee_cannot_spoof_work_item_ownership(workflow_endpoint, workflow_issue):
    endpoint = workflow_endpoint
    endpoint.client.force_authenticate(user=workflow_issue.current_owner)
    response = endpoint.client.patch(
        endpoint.url,
        {"created_by": str(workflow_issue.current_owner.pk), "state_assignees": {}},
        format="json",
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN, response.data
    assert_workflow_unchanged(workflow_issue)
    assert workflow_issue.issue.created_by_id == workflow_issue.actor.pk
