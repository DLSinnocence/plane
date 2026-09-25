# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from types import SimpleNamespace

import pytest

from plane.db.models import ProjectMember, State, WorkspaceMember
from plane.tests.contract.api import test_issue_workflow_permissions as workflow_fixtures

pytestmark = [pytest.mark.contract, pytest.mark.django_db]
disable_workflow_background_tasks = workflow_fixtures.disable_workflow_background_tasks
workflow_issue = workflow_fixtures.workflow_issue
workflow_request_settings = workflow_fixtures.workflow_request_settings


@pytest.fixture(params=["app", "public-api"])
def state_endpoint(request, workflow_issue):
    public = request.param == "public-api"
    client = request.getfixturevalue("api_key_client" if public else "session_client")
    issue = workflow_issue.issue
    prefix = "/api/v1" if public else "/api"
    base = f"{prefix}/workspaces/{issue.workspace.slug}/projects/{issue.project_id}/"
    return SimpleNamespace(
        client=client,
        public=public,
        base=base,
        list_url=f"{base}states/",
        detail_url=f"{base}states/{workflow_issue.acceptance.pk}/",
    )


@pytest.fixture(params=["member", "project-admin", "workspace-admin"])
def state_actor(request, workflow_issue):
    if request.param == "project-admin":
        ProjectMember.objects.filter(pk=workflow_issue.membership.pk).update(role=20)
    elif request.param == "workspace-admin":
        WorkspaceMember.objects.filter(
            workspace=workflow_issue.issue.workspace, member=workflow_issue.actor
        ).update(role=20)
    return workflow_issue.actor


@pytest.mark.parametrize(
    "method,target,payload",
    [
        ("post", "list", {"name": "Custom state", "color": "#000000", "group": "started"}),
        ("patch", "detail", {"name": "Renamed state"}),
        ("patch", "detail", {"color": "#000000"}),
        ("patch", "detail", {"group": "completed"}),
        ("patch", "detail", {"sequence": -100}),
        ("patch", "detail", {"default": True}),
        ("patch", "detail", {"is_testing": True}),
        ("put", "detail", {"name": "Replacement", "group": "started", "color": "#000000"}),
        ("delete", "detail", {}),
    ],
    ids=["create", "rename", "recolor", "regroup", "reorder", "default", "testing", "replace", "delete"],
)
def test_state_writes_are_disallowed_for_members_and_admins(
    state_endpoint, state_actor, workflow_issue, method, target, payload
):
    states = State.objects.filter(project=workflow_issue.issue.project).order_by("id")
    before = list(states.values())

    response = getattr(state_endpoint.client, method)(
        getattr(state_endpoint, f"{target}_url"), payload, format="json"
    )

    assert response.status_code == 405, response.data
    assert not {"POST", "PUT", "PATCH", "DELETE"}.intersection(response["Allow"].split(", "))
    assert list(states.values()) == before


def test_app_mark_default_is_disallowed_for_members_and_admins(session_client, state_actor, workflow_issue):
    issue = workflow_issue.issue
    states = State.objects.filter(project=issue.project).order_by("id")
    before = list(states.values())
    response = session_client.post(
        f"/api/workspaces/{issue.workspace.slug}/projects/{issue.project_id}/"
        f"states/{workflow_issue.acceptance.pk}/mark-default/",
        {},
        format="json",
    )
    assert response.status_code == 405, response.data
    assert list(states.values()) == before


def test_state_list_and_detail_remain_readable(state_endpoint, state_actor, workflow_issue):
    response = state_endpoint.client.get(state_endpoint.list_url)
    assert response.status_code == 200, response.data
    rows = response.data["results"] if state_endpoint.public else response.data
    assert {row["id"] for row in rows} == {
        str(workflow_issue.development.pk),
        str(workflow_issue.acceptance.pk),
    }
    assert all(row["is_testing"] is False for row in rows)

    response = state_endpoint.client.get(state_endpoint.detail_url)
    assert response.status_code == 200, response.data
    assert response.data["id"] == str(workflow_issue.acceptance.pk)
    assert response.data["is_testing"] is False


def test_app_grouped_state_reads_remain_available(session_client, workflow_issue):
    issue = workflow_issue.issue
    response = session_client.get(
        f"/api/workspaces/{issue.workspace.slug}/projects/{issue.project_id}/states/?grouped=true"
    )
    assert response.status_code == 200, response.data
    assert {row["id"] for row in response.data["started"]} == {
        str(workflow_issue.development.pk),
        str(workflow_issue.acceptance.pk),
    }


def test_issue_can_still_transition_between_read_only_states(state_endpoint, state_actor, workflow_issue):
    state_key = "state" if state_endpoint.public else "state_id"
    response = state_endpoint.client.patch(
        f"{state_endpoint.base}issues/{workflow_issue.issue.pk}/",
        {state_key: str(workflow_issue.acceptance.pk)},
        format="json",
    )
    assert response.status_code == 200, response.data
    workflow_issue.issue.refresh_from_db()
    assert workflow_issue.issue.state_id == workflow_issue.acceptance.pk
