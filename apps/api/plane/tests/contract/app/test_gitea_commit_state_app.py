# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Real database contracts for work item state restrictions on both hook transports."""

import hashlib

import pytest
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import GiteaCommit, GiteaCommitLink, GiteaIntegration, Issue, Project, ProjectMember, State
from plane.utils.gitea import encrypt

pytestmark = [pytest.mark.contract, pytest.mark.django_db]
TOKEN = "state-contract-secret"
REPOSITORY = "https://git.example/team/state-contract"


@pytest.fixture(autouse=True)
def configuration(settings):
    settings.APP_BASE_URL = "https://plane.example"
    cache.clear()


@pytest.fixture
def integration(workspace):
    return GiteaIntegration.objects.create(workspace=workspace, enabled=True, secret=encrypt(TOKEN))


@pytest.fixture
def bearer():
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {TOKEN}")
    return client


@pytest.fixture
def item(workspace, create_user):
    project = Project.objects.create(workspace=workspace, identifier="STATE", name="State contract")
    ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=20)
    state = State.objects.create(workspace=workspace, project=project, name="开发中", group="started")
    return Issue.objects.create(workspace=workspace, project=project, state=state, name="Actual stateful work")


def key(item):
    return f"{item.project.identifier}-{item.sequence_id}"


def endpoint(integration, suffix):
    return f"/api/integrations/gitea/{integration.workspace.slug}/{suffix}/"


def commit(item, description="implement work"):
    message = f"{key(item)} {description}\n"
    raw = (
        "tree " + "a" * 40 + "\n"
        "author Developer <developer@example.invalid> 1767225600 +0000\n"
        "committer Developer <developer@example.invalid> 1767225600 +0000\n\n" + message
    ).encode()
    sha = hashlib.sha1(b"commit " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
    return {"sha": sha, "message": message, "raw": raw}


def post(client, integration, transport, operation, values):
    suffix = "commits" if operation == "report" else "validate"
    if transport == "shell":
        data = {"commits": [SimpleUploadedFile(value["sha"], value["raw"]) for value in values]}
        if operation == "report":
            data["repository_url"] = REPOSITORY
        return client.post(endpoint(integration, suffix), data, format="multipart")
    values = [
        {
            "sha": value["sha"],
            "message": value["message"],
            **({"url": f"{REPOSITORY}/commit/{value['sha']}"} if operation == "report" else {}),
        }
        for value in values
    ]
    return client.post(endpoint(integration, suffix), {"commits": values}, format="json")


def assert_rejected(response, transport, operation, item, state_name=None, row_index=0):
    assert TOKEN.encode() not in response.content
    if transport == "json":
        assert response.status_code == (200 if operation == "validate" else 400)
        data = response.json()
        assert data["valid"] is False
        row = data["results"][row_index]
        assert row["valid"] is False
        assert row["identifier"] == key(item)
        assert row["error"]["code"] == "work_item_not_in_progress"
        message = row["error"]["message"]
    else:
        assert response.status_code == 400
        assert response["Content-Type"] == "text/plain; charset=utf-8"
        message = response.content.decode()
        assert message.splitlines()[0] == "PLANE-HOOK-ERROR"
    assert key(item) in message
    if state_name is not None:
        assert state_name in message


@pytest.mark.parametrize("transport", ["json", "shell"])
@pytest.mark.parametrize("operation", ["validate", "report"])
@pytest.mark.parametrize(
    "group,name,exception,allowed",
    [
        ("started", "开发中", None, True),
        ("started", "开发完成/待验收", None, True),
        ("started", "团队自定义处理中", None, True),
        ("backlog", "待规划", None, False),
        ("unstarted", "待开始", None, False),
        ("completed", "已完成", None, False),
        ("cancelled", "已拒绝", None, False),
        ("triage", "待分诊", None, False),
        ("started", "开发中", "null", False),
        ("started", "开发中", "deleted_state", False),
        ("started", "开发中", "archived", False),
    ],
)
def test_commit_state_matrix(bearer, integration, item, transport, operation, group, name, exception, allowed):
    State.all_state_objects.filter(pk=item.state_id).update(group=group, name=name)
    if exception == "null":
        # Issue.save assigns a default state, so use a DB update to represent a legacy null state.
        Issue.objects.filter(pk=item.pk).update(state=None)
    elif exception == "deleted_state":
        State.all_state_objects.filter(pk=item.state_id).update(deleted_at=timezone.now())
    elif exception == "archived":
        Issue.objects.filter(pk=item.pk).update(archived_at=timezone.now().date())
    response = post(bearer, integration, transport, operation, [commit(item)])
    assert TOKEN.encode() not in response.content
    if allowed:
        assert response.status_code == 200
        if transport == "json":
            assert response.json()["valid"] is True
        else:
            assert response.content.decode().splitlines()[:3] == [
                "PLANE-HOOK-OK",
                commit(item)["sha"],
                "PLANE-HOOK-END",
            ]
    else:
        assert_rejected(response, transport, operation, item, None if exception == "null" else name)
    expected = int(allowed and operation == "report")
    assert GiteaCommit.objects.count() == GiteaCommitLink.objects.count() == expected


@pytest.mark.parametrize("transport", ["json", "shell"])
@pytest.mark.parametrize("operation", ["validate", "report"])
def test_closed_item_rejects_whole_batch_without_writes(bearer, integration, item, transport, operation):
    closed = State.objects.create(workspace=item.workspace, project=item.project, name="验收完成", group="completed")
    blocked = Issue.objects.create(workspace=item.workspace, project=item.project, state=closed, name="Closed work")
    response = post(bearer, integration, transport, operation, [commit(item), commit(blocked)])
    assert_rejected(response, transport, operation, blocked, closed.name, row_index=1)
    if transport == "json":
        assert response.json()["results"][0]["valid"] is True
    assert not GiteaCommit.objects.exists()
    assert not GiteaCommitLink.objects.exists()


@pytest.mark.parametrize("transport", ["json", "shell"])
def test_started_to_completed_is_rechecked_for_validate_and_report(bearer, integration, item, transport):
    values = [commit(item)]
    assert post(bearer, integration, transport, "validate", values).status_code == 200
    assert post(bearer, integration, transport, "report", values).status_code == 200
    state_name = "刚刚验收完成"
    State.objects.filter(pk=item.state_id).update(group="completed", name=state_name)
    for operation in ("validate", "report"):
        assert_rejected(post(bearer, integration, transport, operation, values), transport, operation, item, state_name)
        assert_rejected(
            post(bearer, integration, transport, operation, [commit(item, "new work")]),
            transport,
            operation,
            item,
            state_name,
        )
    assert GiteaCommit.objects.count() == GiteaCommitLink.objects.count() == 1


@pytest.mark.parametrize("transport", ["json", "shell"])
def test_old_commit_links_remain_queryable_after_completion(bearer, session_client, integration, item, transport):
    value = commit(item)
    assert post(bearer, integration, transport, "report", [value]).status_code == 200
    State.objects.filter(pk=item.state_id).update(group="completed", name="已完成")
    response = bearer.get(endpoint(integration, f"work-items/{key(item)}"))
    assert response.status_code == 200 and response.json()["id"] == str(item.id)
    response = bearer.get(endpoint(integration, f"commits/{value['sha']}/work-items"))
    assert response.status_code == 200
    assert [row["id"] for row in response.json()["results"]] == [str(item.id)]
    url = f"/api/workspaces/{item.workspace.slug}/projects/{item.project_id}/issues/{item.id}/git-commits/"
    response = session_client.get(url)
    assert response.status_code == 200
    assert [row["sha"] for row in response.json()["results"]] == [value["sha"]]
