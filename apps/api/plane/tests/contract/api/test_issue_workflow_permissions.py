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
    # Future responsibility and creator status do not grant current-state access.
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
