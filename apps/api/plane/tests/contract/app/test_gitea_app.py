from unittest.mock import patch

import pytest
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import (
    GiteaCommit,
    GiteaCommitLink,
    GiteaIntegration,
    Issue,
    Project,
    ProjectMember,
    Workspace,
    WorkspaceMember,
)
from plane.utils.gitea import decrypt, encrypt

pytestmark = [pytest.mark.contract, pytest.mark.django_db]
SHA = "a" * 40
TOKEN = "workspace-secret"


@pytest.fixture(autouse=True)
def configuration(settings):
    settings.APP_BASE_URL = "https://plane.example"
    cache.clear()


@pytest.fixture
def integration(workspace):
    return GiteaIntegration.objects.create(workspace=workspace, enabled=True, secret=encrypt(TOKEN))


@pytest.fixture
def items(workspace, create_user):
    result = []
    for prefix in ["研发_7", "TEAM-SUB"]:
        project = Project.objects.create(workspace=workspace, name=prefix, identifier=prefix)
        ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=20)
        result.append(Issue.objects.create(workspace=workspace, project=project, name="Actual work"))
    return result


@pytest.fixture
def bearer():
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {TOKEN}")
    return client


def public(integration, suffix="validate/"):
    return f"/api/integrations/gitea/{integration.workspace.slug}/{suffix}"


def admin(workspace, suffix=""):
    return f"/api/workspaces/{workspace.slug}/integrations/gitea/{suffix}"


def key(issue):
    return f"{issue.project.identifier}-{issue.sequence_id}"


def commit(issue, sha=SHA, repository="repo-a"):
    return {
        "sha": sha,
        "message": f"{key(issue)} implement work\nbody",
        "url": f"http://git.internal/team/{repository}/commit/{sha}",
        "repository_name": f"team/{repository}",
        "branch": "main",
        "author_name": "Developer",
        "committed_at": "2026-01-01T10:00:00Z",
    }


def report(bearer, integration, commits):
    return bearer.post(public(integration, "commits/"), {"commits": commits}, format="json")


def test_cross_projects_multirepositories_and_report_lookup_roundtrip(bearer, session_client, integration, items):
    # One repository serves multiple projects; one item accepts multiple repositories.
    values = [commit(items[0]), commit(items[1], "b" * 40)]
    result = report(bearer, integration, values)
    assert result.status_code == 200 and result.json()["linked_count"] == 2
    assert report(bearer, integration, [commit(items[0], repository="repo-b")]).status_code == 200
    assert GiteaCommit.objects.count() == 3 and GiteaCommitLink.objects.count() == 3
    for item in items:
        response = bearer.get(public(integration, f"work-items/{key(item)}/"))
        assert response.status_code == 200 and response.json()["project_id"] == str(item.project_id)
        url = f"/api/workspaces/{integration.workspace.slug}/projects/{item.project_id}/issues/{item.id}/git-commits/"
        rows = session_client.get(url).json()["results"]
        assert len(rows) == (2 if item == items[0] else 1)
        assert all("repository_id" not in row and row["url"].startswith("http://git.internal/") for row in rows)
    reverse = bearer.get(public(integration, f"commits/{SHA}/work-items/"))
    assert [row["id"] for row in reverse.json()["results"]] == [str(items[0].id)]
    assert bearer.get(
        public(integration, f"commits/{SHA}/work-items/"), {"url": "https://unknown/commit/x"}
    ).json() == {"results": []}


def test_same_sha_from_different_urls_can_link_different_projects(bearer, integration, items):
    for item, repository in zip(items, ["a", "b"]):
        assert report(bearer, integration, [commit(item, repository=repository)]).status_code == 200
    response = bearer.get(public(integration, f"commits/{SHA}/work-items/"))
    assert {row["id"] for row in response.json()["results"]} == {str(item.id) for item in items}
    response = bearer.get(
        public(integration, f"commits/{SHA}/work-items/"), {"url": commit(items[1], repository="b")["url"]}
    )
    assert [row["id"] for row in response.json()["results"]] == [str(items[1].id)]


def test_validation_is_read_only_and_drafts_deleted_missing_rejected(bearer, integration, items):
    def validate(item):
        value = commit(item)
        return bearer.post(
            public(integration), {"commits": [{"sha": value["sha"], "message": value["message"]}]}, format="json"
        )

    assert validate(items[0]).json()["valid"]
    assert validate(items[1]).json()["valid"]
    assert not GiteaCommit.objects.exists() and not GiteaCommitLink.objects.exists()
    Issue.objects.filter(pk=items[0].pk).update(is_draft=True)
    assert not validate(items[0]).json()["valid"]
    Issue.all_objects.filter(pk=items[0].pk).update(is_draft=False, deleted_at=timezone.now())
    assert not validate(items[0]).json()["valid"]
    Project.objects.filter(pk=items[1].project_id).update(deleted_at=timezone.now())
    assert not validate(items[1]).json()["valid"]


@pytest.mark.parametrize(
    "bad_field,bad_value", [("message", "UNKNOWN-999 missing"), ("url", "javascript:alert(1)"), ("committed_at", "bad")]
)
def test_invalid_batch_is_atomic(bearer, integration, items, bad_field, bad_value):
    values = [commit(items[0]), {**commit(items[1], "b" * 40), bad_field: bad_value}]
    response = report(bearer, integration, values)
    assert response.status_code == 400
    assert "errors" in response.json() or response.json()["valid"] is False
    assert not GiteaCommit.objects.exists() and not GiteaCommitLink.objects.exists()


@pytest.mark.parametrize("field,value", [("sha", "c" * 40), ("message", "{key} changed")])
def test_idempotent_replay_and_url_conflict_atomicity(bearer, integration, items, field, value):
    original = commit(items[0])
    assert report(bearer, integration, [original]).status_code == 200
    assert report(bearer, integration, [original]).status_code == 200
    assert GiteaCommit.objects.count() == 1 and GiteaCommitLink.objects.count() == 1
    conflict = {**original, field: value.format(key=key(items[0]))}
    response = report(bearer, integration, [commit(items[1], "b" * 40), conflict])
    assert response.status_code == 400 and response.json()["results"][1]["error"]["code"] == "commit_conflict"
    assert GiteaCommit.objects.count() == 1 and GiteaCommitLink.objects.count() == 1
    assert GiteaCommit.objects.get().message == original["message"]


def test_config_enable_rotation_hooks_and_no_secret_leak(session_client, workspace, bearer):
    response = session_client.get(admin(workspace))
    assert (
        response.status_code == 200 and response.json()["enabled"] is False and response.json()["has_secret"] is False
    )
    assert set(response.json()) == {
        "enabled",
        "has_secret",
        "validation_url",
        "commits_url",
        "lookup_url",
        "issue_url_template",
    }
    response = session_client.patch(admin(workspace), {"enabled": True}, format="json")
    integration = GiteaIntegration.objects.get(workspace=workspace)
    first = decrypt(integration.secret)
    assert len(first) == 64 and first not in str(response.json())
    response = session_client.post(
        admin(workspace, "hooks/"), {"repository_url": "http://git.internal/team/repo"}, format="json"
    )
    assert response.status_code == 200 and response["Cache-Control"] == "no-store"
    assert set(response.json()) == {"pre_receive", "post_receive"}
    assert all(first in response.json()[name]["content"] for name in ["pre_receive", "post_receive"])
    for name, filename in [("pre_receive", "pre-receive"), ("post_receive", "post-receive")]:
        assert response.json()[name]["filename"] == filename
    response = session_client.post(admin(workspace, "rotate-token/"), {}, format="json")
    integration.refresh_from_db()
    assert decrypt(integration.secret) != first and first not in str(response.json())
    bearer.credentials(HTTP_AUTHORIZATION=f"Bearer {first}")
    assert bearer.get(public(integration, "work-items/ABC-1/")).status_code == 401
    bearer.credentials(HTTP_AUTHORIZATION=f"Bearer {decrypt(integration.secret)}")
    assert bearer.get(public(integration, "work-items/ABC-1/")).status_code == 404
    assert session_client.patch(admin(workspace), {"project_id": "x"}, format="json").status_code == 400
    assert session_client.patch(admin(workspace), {"enabled": "true"}, format="json").status_code == 400
    assert session_client.post(admin(workspace, "rotate-token/"), {"secret": "x"}, format="json").status_code == 400


def test_admin_and_project_membership_are_active_and_scoped(session_client, workspace, integration, items, create_user):
    WorkspaceMember.objects.filter(workspace=workspace, member=create_user).update(role=15)
    for suffix, method, body in [
        ("", "get", None),
        ("", "patch", {"enabled": False}),
        ("hooks/", "post", {"repository_url": "https://git/repo"}),
        ("rotate-token/", "post", {}),
    ]:
        assert getattr(session_client, method)(admin(workspace, suffix), body, format="json").status_code == 403
    item = items[0]
    url = f"/api/workspaces/{workspace.slug}/projects/{item.project_id}/issues/{item.id}/git-commits/"
    assert session_client.get(url).status_code == 200
    ProjectMember.objects.filter(project=item.project, member=create_user).update(is_active=False)
    assert session_client.get(url).status_code == 403
    WorkspaceMember.objects.filter(workspace=workspace, member=create_user).update(role=20, is_active=False)
    assert session_client.get(admin(workspace)).status_code == 403


def test_bearer_wrong_disabled_and_workspace_isolation(bearer, integration, items, create_user):
    other = Workspace.objects.create(name="Other", slug="other", owner=create_user)
    project = Project.objects.create(workspace=other, name="Other", identifier="FOREIGN")
    foreign = Issue.objects.create(workspace=other, project=project, name="Foreign item")
    GiteaIntegration.objects.create(workspace=other, enabled=True, secret=encrypt("other-secret"))
    assert report(bearer, integration, [commit(foreign)]).status_code == 400
    assert bearer.get(public(integration, f"work-items/{key(foreign)}/")).status_code == 404
    assert bearer.get("/api/integrations/gitea/other/work-items/FOREIGN-1/").status_code == 401
    for header in ["", "Bearer wrong", "Token workspace-secret", "Bearer 中文"]:
        bearer.credentials(HTTP_AUTHORIZATION=header)
        assert bearer.get(public(integration, f"work-items/{key(items[0])}/")).status_code == 401
    bearer.credentials(HTTP_AUTHORIZATION=f"Bearer {TOKEN}")
    integration.enabled = False
    integration.save()
    assert report(bearer, integration, [commit(items[0])]).status_code == 401


def test_no_outbound_requests_during_report(bearer, integration, items):
    with patch("requests.sessions.Session.request", side_effect=AssertionError("No remote REST")):
        assert report(bearer, integration, [commit(items[0])]).status_code == 200


def test_issue_pagination(session_client, integration, items):
    item = items[0]
    for index in range(26):
        stored = GiteaCommit.objects.create(
            workspace=integration.workspace,
            sha=f"{index:040x}",
            url=f"http://git/commit/{index}",
            message="message",
            title="title",
        )
        GiteaCommitLink.objects.create(commit=stored, issue=item)
    url = f"/api/workspaces/{integration.workspace.slug}/projects/{item.project_id}/issues/{item.id}/git-commits/"
    response = session_client.get(url)
    assert response.json()["count"] == 26 and response.json()["next_page"] == 2
    assert len(response.json()["results"]) == 25
    assert len(session_client.get(url, {"page": 2}).json()["results"]) == 1
    assert session_client.get(url, {"page": 0}).status_code == 400
