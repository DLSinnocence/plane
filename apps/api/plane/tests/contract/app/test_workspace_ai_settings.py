# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from unittest.mock import Mock

import pytest
from rest_framework.test import APIClient

from plane.db.models import User, UserAISettings, Workspace, WorkspaceAIModel, WorkspaceAIProvider, WorkspaceMember
from plane.utils.ai import decrypt_model_key, encrypt_model_key

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def settings_url(workspace):
    return f"/api/workspaces/{workspace.slug}/ai-settings/"


def providers_url(workspace):
    return settings_url(workspace) + "providers/"


def provider_url(workspace, provider):
    return providers_url(workspace) + f"{provider.id}/"


def models_url(workspace, provider):
    return provider_url(workspace, provider) + "models/"


def model_url(workspace, model):
    return models_url(workspace, model.provider_config) + f"{model.id}/"


@pytest.fixture
def member(workspace):
    user = User.objects.create(email="workspace-ai-member@example.com", username="workspace-ai-member")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    return user


@pytest.fixture
def member_client(member):
    client = APIClient()
    client.force_authenticate(user=member)
    return client


def create_provider(workspace, key="workspace-secret", **values):
    return WorkspaceAIProvider.objects.create(
        workspace=workspace,
        name=values.pop("name", "Primary"),
        provider=values.pop("provider", "openai"),
        base_url=values.pop("base_url", "https://api.openai.com/v1"),
        api_key_encrypted=encrypt_model_key(key),
        **values,
    )


def create_model(provider, **values):
    return WorkspaceAIModel.objects.create(
        workspace=provider.workspace,
        provider_config=provider,
        model=values.pop("model", "gpt-4o-mini"),
        **values,
    )


def test_member_reads_safe_workspace_config_but_cannot_mutate(session_client, member_client, workspace):
    provider = create_provider(workspace)
    model = create_model(provider, is_default=True, supports_images=True)

    response = member_client.get(settings_url(workspace))
    assert response.status_code == 200
    assert response.json() == {
        "providers": [
            {
                "id": str(provider.id),
                "name": "Primary",
                "provider": "openai",
                "base_url": "https://api.openai.com/v1",
                "has_api_key": True,
                "is_enabled": True,
                "models": [
                    {
                        "id": str(model.id),
                        "model": "gpt-4o-mini",
                        "supports_images": True,
                        "is_enabled": True,
                        "is_default": True,
                    }
                ],
            }
        ]
    }
    assert response["Cache-Control"] == "no-store"
    assert "workspace-secret" not in response.content.decode()
    assert provider.api_key_encrypted not in response.content.decode()

    denied = member_client.post(
        providers_url(workspace),
        {"name": "Denied", "provider": "openai", "base_url": "", "api_key": "key"},
        format="json",
    )
    assert denied.status_code == 403
    assert WorkspaceAIProvider.objects.filter(workspace=workspace).count() == 1


def test_admin_crud_switches_single_default_and_never_returns_key(session_client, workspace):
    response = session_client.post(
        providers_url(workspace),
        {
            "name": "Gateway",
            "provider": "openai",
            "base_url": "",
            "api_key": "new-workspace-key",
        },
        format="json",
    )
    assert response.status_code == 201
    provider = WorkspaceAIProvider.objects.get(id=response.json()["id"])
    assert provider.base_url == "https://api.openai.com/v1"
    assert decrypt_model_key(provider.api_key_encrypted) == "new-workspace-key"
    assert "new-workspace-key" not in response.content.decode()

    first_response = session_client.post(
        models_url(workspace, provider),
        {"model": "first", "is_default": True},
        format="json",
    )
    second_response = session_client.post(
        models_url(workspace, provider),
        {"model": "second", "supports_images": True, "is_default": True},
        format="json",
    )
    assert first_response.status_code == second_response.status_code == 201
    first = WorkspaceAIModel.objects.get(id=first_response.json()["id"])
    second = WorkspaceAIModel.objects.get(id=second_response.json()["id"])
    first.refresh_from_db()
    assert first.is_default is False
    assert second.is_default is True

    response = session_client.patch(
        provider_url(workspace, provider), {"name": "Renamed", "api_key": ""}, format="json"
    )
    assert response.status_code == 200
    provider.refresh_from_db()
    assert provider.name == "Renamed"
    assert decrypt_model_key(provider.api_key_encrypted) == "new-workspace-key"

    response = session_client.patch(provider_url(workspace, provider), {"is_enabled": False}, format="json")
    assert response.status_code == 200
    second.refresh_from_db()
    assert second.is_default is False


def test_provider_destination_change_requires_new_key_atomically(session_client, workspace):
    provider = create_provider(workspace)
    before = (provider.provider, provider.base_url, provider.api_key_encrypted)
    response = session_client.patch(
        provider_url(workspace, provider),
        {"provider": "anthropic", "base_url": ""},
        format="json",
    )
    assert response.status_code == 400
    provider.refresh_from_db()
    assert (provider.provider, provider.base_url, provider.api_key_encrypted) == before


def test_foreign_provider_and_model_ids_are_not_addressable(
    session_client, workspace, create_user, monkeypatch
):
    other = Workspace.objects.create(name="Other AI", slug="other-ai", owner=create_user)
    provider = create_provider(other)
    model = create_model(provider)
    discover = Mock()
    monkeypatch.setattr("plane.app.views.ai.discover_models", discover)

    assert session_client.patch(provider_url(workspace, provider), {"name": "stolen"}, format="json").status_code == 404
    assert session_client.patch(model_url(workspace, model), {"is_default": True}, format="json").status_code == 404
    discovery = session_client.post(
        settings_url(workspace) + "models/",
        {
            "provider": "openai",
            "base_url": "https://api.openai.com/v1",
            "provider_id": str(provider.id),
            "api_key": "temporary-key",
        },
        format="json",
    )
    assert discovery.status_code == 404
    discover.assert_not_called()
    provider.refresh_from_db()
    model.refresh_from_db()
    assert provider.name == "Primary"
    assert model.is_default is False


def test_discovery_reuses_only_matching_workspace_provider_key(session_client, workspace, monkeypatch):
    provider = create_provider(workspace)
    discover = Mock(return_value={"models": [{"id": "example"}], "truncated": False})
    monkeypatch.setattr("plane.app.views.ai.discover_models", discover)

    response = session_client.post(
        settings_url(workspace) + "models/",
        {
            "provider": "openai",
            "base_url": "https://api.openai.com/v1",
            "provider_id": str(provider.id),
        },
        format="json",
    )
    assert response.status_code == 200
    discover.assert_called_once_with("openai", "https://api.openai.com/v1", "workspace-secret")

    discover.reset_mock()
    response = session_client.post(
        settings_url(workspace) + "models/",
        {"provider": "anthropic", "base_url": "", "provider_id": str(provider.id)},
        format="json",
    )
    assert response.status_code == 400
    discover.assert_not_called()


def test_schema_migration_does_not_promote_personal_keys(session_client, create_user, workspace):
    UserAISettings.objects.create(user=create_user, api_key_encrypted=encrypt_model_key("private-personal-key"))
    response = session_client.get(settings_url(workspace))
    assert response.status_code == 200
    assert response.json() == {"providers": []}
    assert not WorkspaceAIProvider.objects.filter(workspace=workspace).exists()


def test_model_update_refetches_after_lock_and_does_not_resurrect_deleted(
    session_client, workspace, monkeypatch
):
    provider = create_provider(workspace)
    model = create_model(provider, is_default=True)
    select_for_update = Workspace.objects.select_for_update

    def delete_then_lock(*args, **kwargs):
        WorkspaceAIModel.objects.filter(id=model.id).delete()
        return select_for_update(*args, **kwargs)

    monkeypatch.setattr(Workspace.objects, "select_for_update", delete_then_lock)
    response = session_client.patch(model_url(workspace, model), {"supports_images": True}, format="json")

    assert response.status_code == 404
    assert not WorkspaceAIModel.objects.filter(id=model.id).exists()


def test_model_update_refetches_provider_state_after_lock(session_client, workspace, monkeypatch):
    provider = create_provider(workspace)
    model = create_model(provider, is_default=True)
    select_for_update = Workspace.objects.select_for_update

    def disable_then_lock(*args, **kwargs):
        WorkspaceAIProvider.objects.filter(id=provider.id).update(is_enabled=False)
        WorkspaceAIModel.objects.filter(id=model.id).update(is_default=False)
        return select_for_update(*args, **kwargs)

    monkeypatch.setattr(Workspace.objects, "select_for_update", disable_then_lock)
    response = session_client.patch(model_url(workspace, model), {"supports_images": True}, format="json")

    assert response.status_code == 200
    model.refresh_from_db()
    assert model.supports_images is True
    assert model.is_default is False


def test_model_create_refetches_provider_after_lock(session_client, workspace, monkeypatch):
    provider = create_provider(workspace)
    select_for_update = Workspace.objects.select_for_update

    def delete_then_lock(*args, **kwargs):
        WorkspaceAIProvider.objects.filter(id=provider.id).delete()
        return select_for_update(*args, **kwargs)

    monkeypatch.setattr(Workspace.objects, "select_for_update", delete_then_lock)
    response = session_client.post(models_url(workspace, provider), {"model": "stale"}, format="json")

    assert response.status_code == 404
    assert not WorkspaceAIModel.objects.filter(model="stale").exists()


def test_model_create_refetches_disabled_provider_state(session_client, workspace, monkeypatch):
    provider = create_provider(workspace)
    select_for_update = Workspace.objects.select_for_update

    def disable_then_lock(*args, **kwargs):
        WorkspaceAIProvider.objects.filter(id=provider.id).update(is_enabled=False)
        return select_for_update(*args, **kwargs)

    monkeypatch.setattr(Workspace.objects, "select_for_update", disable_then_lock)
    response = session_client.post(
        models_url(workspace, provider),
        {"model": "stale-default", "is_default": True},
        format="json",
    )

    assert response.status_code == 400
    assert "is_default" in response.json()
    assert not WorkspaceAIModel.objects.filter(model="stale-default").exists()


@pytest.mark.parametrize("payload", [{"is_enabled": False}, {"is_enabled": False, "is_default": True}])
def test_disabling_current_default_clears_default(session_client, workspace, payload):
    provider = create_provider(workspace)
    model = create_model(provider, is_default=True)

    response = session_client.patch(model_url(workspace, model), payload, format="json")

    assert response.status_code == 200
    assert response.json()["is_enabled"] is False
    assert response.json()["is_default"] is False
    model.refresh_from_db()
    assert model.is_enabled is False
    assert model.is_default is False


@pytest.mark.parametrize("role", [5, 15])
def test_non_admin_cannot_use_any_workspace_ai_mutation(member_client, member, workspace, monkeypatch, role):
    WorkspaceMember.objects.filter(workspace=workspace, member=member).update(role=role)
    provider = create_provider(workspace)
    model = create_model(provider, is_default=True)
    discover = Mock()
    monkeypatch.setattr("plane.app.views.ai.discover_models", discover)
    operations = [
        ("post", providers_url(workspace), {"name": "Denied", "provider": "openai", "api_key": "key"}),
        ("patch", provider_url(workspace, provider), {"name": "Denied"}),
        ("delete", provider_url(workspace, provider), None),
        ("post", models_url(workspace, provider), {"model": "denied"}),
        ("patch", model_url(workspace, model), {"model": "denied"}),
        ("delete", model_url(workspace, model), None),
        (
            "post",
            settings_url(workspace) + "models/",
            {"provider": "openai", "base_url": "", "api_key": "temporary"},
        ),
    ]

    for method, url, body in operations:
        response = getattr(member_client, method)(url, body, format="json")
        assert response.status_code == 403, (method, url, response.data)

    provider.refresh_from_db()
    model.refresh_from_db()
    assert provider.name == "Primary"
    assert model.model == "gpt-4o-mini"
    discover.assert_not_called()


def test_workspace_ai_mutations_require_csrf(create_user, workspace, monkeypatch):
    provider = create_provider(workspace)
    model = create_model(provider, is_default=True)
    discover = Mock()
    monkeypatch.setattr("plane.app.views.ai.discover_models", discover)
    client = APIClient(enforce_csrf_checks=True)
    client.force_login(create_user)
    operations = [
        ("post", providers_url(workspace), {"name": "Denied", "provider": "openai", "api_key": "key"}),
        ("patch", provider_url(workspace, provider), {"name": "Denied"}),
        ("delete", provider_url(workspace, provider), None),
        ("post", models_url(workspace, provider), {"model": "denied"}),
        ("patch", model_url(workspace, model), {"model": "denied"}),
        ("delete", model_url(workspace, model), None),
        (
            "post",
            settings_url(workspace) + "models/",
            {"provider": "openai", "base_url": "", "api_key": "temporary"},
        ),
    ]

    for method, url, body in operations:
        response = getattr(client, method)(url, body, format="json")
        assert response.status_code == 403, (method, url, response.data)
        assert "CSRF" in str(response.data)

    provider.refresh_from_db()
    model.refresh_from_db()
    assert provider.name == "Primary"
    assert model.model == "gpt-4o-mini"
    discover.assert_not_called()
