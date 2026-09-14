# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import subprocess

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from plane.db.models import GiteaIntegration, Workspace, WorkspaceMember
from plane.utils.gitea import decrypt, encrypt

pytestmark = [pytest.mark.contract, pytest.mark.django_db]
TOKEN = "generated-workspace-fixture-secret"


@pytest.fixture
def integration(workspace, settings):
    settings.APP_BASE_URL = "https://plane.example.test/subpath"
    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
    cache.clear()
    return GiteaIntegration.objects.create(workspace=workspace, enabled=True, secret=encrypt(TOKEN))


def endpoint(workspace, suffix="hooks/"):
    return f"/api/workspaces/{workspace.slug}/integrations/gitea/{suffix}"


def test_generate_copyable_workspace_hooks_without_repository_input(session_client, workspace, integration):
    before = integration.secret
    response = session_client.post(endpoint(workspace), {}, format="json")
    assert response.status_code == 200
    assert response["Content-Type"].startswith("application/json")
    assert response["Cache-Control"] == "no-store"
    assert "Content-Disposition" not in response
    assert set(response.data) == {"pre_receive", "post_receive"}
    for field, name, action in (
        ("pre_receive", "pre-receive", "validate"),
        ("post_receive", "post-receive", "commits"),
    ):
        hook = response.data[field]
        assert hook["filename"] == name
        assert hook["content"].startswith("#!/bin/sh\n")
        assert TOKEN in hook["content"]
        assert (
            f"https://plane.example.test/subpath/api/integrations/gitea/{workspace.slug}/{action}/" in hook["content"]
        )
        result = subprocess.run(["sh", "-n"], input=hook["content"], text=True, capture_output=True, timeout=5)
        assert result.returncode == 0, result.stderr
    for variable in ("GITEA_ROOT_URL", "GITEA_REPO_USER_NAME", "GITEA_REPO_NAME"):
        assert variable in response.data["post_receive"]["content"]
    integration.refresh_from_db()
    assert integration.secret == before
    assert GiteaIntegration.objects.count() == 1


@pytest.mark.parametrize("role", [5, 15])
def test_nonadmins_cannot_generate_workspace_secrets(session_client, workspace, create_user, integration, role):
    WorkspaceMember.objects.filter(workspace=workspace, member=create_user).update(role=role)
    response = session_client.post(endpoint(workspace), {}, format="json")
    assert response.status_code == 403
    assert TOKEN not in response.content.decode()
    assert response["Cache-Control"] == "no-store"


def test_generation_rejects_inactive_and_cross_workspace_access(session_client, workspace, create_user, integration):
    WorkspaceMember.objects.filter(workspace=workspace, member=create_user).update(is_active=False)
    assert session_client.post(endpoint(workspace), {}, format="json").status_code == 403
    other = Workspace.objects.create(name="Other", slug="other-hooks", owner=create_user)
    GiteaIntegration.objects.create(workspace=other, enabled=True, secret=encrypt("other-private-key"))
    response = session_client.post(endpoint(other), {}, format="json")
    assert response.status_code == 403
    assert "other-private-key" not in response.content.decode()


def test_disabled_integrations_and_anonymous_users_cannot_generate(session_client, workspace, integration):
    integration.enabled = False
    integration.save()
    response = session_client.post(endpoint(workspace), {}, format="json")
    assert response.status_code == 400
    assert TOKEN not in response.content.decode()
    assert APIClient().post(endpoint(workspace), {}, format="json").status_code in (401, 403)


@pytest.mark.parametrize(
    "body",
    [
        {"repository_url": "javascript:alert(1)"},
        {"repository_url": "https://user:secret@git.example/team/repo"},
        {"repository_url": "https://git.example/team/repo?token=secret"},
        {"repository_url": "https://git.example/team/repo#fragment"},
        {"repository_url": None},
        {"workspace_id": "other"},
    ],
)
def test_invalid_input_does_not_return_hook_secrets(session_client, workspace, integration, body):
    response = session_client.post(endpoint(workspace), body, format="json")
    assert response.status_code == 400
    assert TOKEN not in response.content.decode()


def test_rotation_changes_the_secret_in_newly_generated_code(session_client, workspace, integration):
    first = session_client.post(endpoint(workspace), {}, format="json").data
    assert session_client.post(endpoint(workspace, "rotate-token/"), {}, format="json").status_code == 200
    integration.refresh_from_db()
    new_key = decrypt(integration.secret)
    second = session_client.post(endpoint(workspace), {}, format="json").data
    assert new_key != TOKEN
    assert TOKEN in first["pre_receive"]["content"]
    for field in ("pre_receive", "post_receive"):
        assert TOKEN not in second[field]["content"]
        assert new_key in second[field]["content"]


def test_explicit_repository_url_remains_compatible_for_api_clients(session_client, workspace, integration):
    response = session_client.post(
        endpoint(workspace), {"repository_url": "https://git.example/team/legacy"}, format="json"
    )
    assert response.status_code == 200
    assert "https://git.example/team/legacy" in response.data["post_receive"]["content"]
