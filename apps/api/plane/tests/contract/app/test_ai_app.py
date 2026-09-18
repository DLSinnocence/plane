# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""AI API contracts; require the PostgreSQL test stack, but no live AI service.

The CSRF cases deliberately use force_login, never force_authenticate, so DRF's
SessionAuthentication is exercised with a genuine session cookie.
"""

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from django.conf import settings as django_settings
from django.utils import timezone
from rest_framework.exceptions import AuthenticationFailed
from rest_framework.test import APIClient

from plane.api.middleware.api_authentication import APIKeyAuthentication
from plane.db.models import (
    APIToken,
    Project,
    ProjectMember,
    User,
    UserAISettings,
    Workspace,
    WorkspaceAIModel,
    WorkspaceAIProvider,
    WorkspaceMember,
)
from plane.utils.ai import AGENT_TOKEN_LABEL, DEFAULT_AI_SETTINGS, decrypt_model_key, encrypt_model_key

pytestmark = [pytest.mark.contract, pytest.mark.django_db]
SETTINGS_URL = "/api/users/me/ai-settings/"


def chat_url(workspace):
    return f"/api/workspaces/{workspace.slug}/agent/chat/"


@pytest.fixture(autouse=True)
def ai_environment(settings):
    settings.AI_AGENT_URL = "http://live.internal"
    settings.LIVE_SERVER_SECRET_KEY = "test-internal-secret"


@pytest.fixture
def other_user():
    return User.objects.create(email="other-ai-user@example.com", username="other-ai-user")


def save_settings(user, key="model-secret"):
    return UserAISettings.objects.create(user=user, api_key_encrypted=encrypt_model_key(key))


def save_workspace_settings(workspace, key="model-secret", **model_values):
    provider = WorkspaceAIProvider.objects.create(
        workspace=workspace,
        name="Primary",
        provider="openai",
        base_url="https://api.openai.com/v1",
        api_key_encrypted=encrypt_model_key(key),
    )
    return WorkspaceAIModel.objects.create(
        workspace=workspace,
        provider_config=provider,
        model=model_values.pop("model", "gpt-4o-mini"),
        is_default=True,
        **model_values,
    )


def test_settings_are_owned_by_session_user_even_with_injected_owner(session_client, create_user, other_user):
    other_config = save_settings(other_user, "other-user-secret")
    original_ciphertext = other_config.api_key_encrypted
    response = session_client.get(SETTINGS_URL)
    assert response.status_code == 200
    assert response.json() == DEFAULT_AI_SETTINGS
    assert response["Cache-Control"] == "no-store"

    response = session_client.patch(
        SETTINGS_URL,
        {
            "api_key": "my-new-secret",
            "model": "test-model",
            "user": str(other_user.id),
            "user_id": str(other_user.id),
            "api_key_encrypted": "attacker-controlled",
        },
        format="json",
    )
    assert response.status_code == 200
    assert response.json() == {
        "provider": "openai",
        "base_url": "https://api.openai.com/v1",
        "model": "test-model",
        "has_api_key": True,
        "supports_images": False,
    }
    assert response["Cache-Control"] == "no-store"
    mine = UserAISettings.objects.get(user=create_user)
    assert mine.api_key_encrypted != "my-new-secret"
    assert decrypt_model_key(mine.api_key_encrypted) == "my-new-secret"
    other_config.refresh_from_db()
    assert other_config.api_key_encrypted == original_ciphertext
    response = session_client.get(SETTINGS_URL)
    assert "my-new-secret" not in response.content.decode()
    assert mine.api_key_encrypted not in response.content.decode()
    assert "api_key" not in response.json()
    assert "api_key_encrypted" not in response.json()


def test_saved_model_metadata_reloads_without_upstream_access(session_client, create_user, monkeypatch):
    config = save_settings(create_user)
    config.model = "gpt-4o"
    config.save()
    discover = Mock(side_effect=AssertionError("Settings must not fetch upstream models"))
    decrypt = Mock(side_effect=AssertionError("Settings must not decrypt saved keys"))
    monkeypatch.setattr("plane.app.views.ai.discover_models", discover)
    monkeypatch.setattr("plane.app.views.ai.decrypt_model_key", decrypt)
    response = session_client.get(SETTINGS_URL)
    assert response.status_code == 200
    metadata = response.json()["model_metadata"]
    assert metadata["metadata_source"] == "models.dev"
    assert metadata["vision"] is True
    assert metadata["tools"] is True
    assert response.json()["supports_images"] is False
    config.refresh_from_db()
    assert config.supports_images is False
    assert response["Cache-Control"] == "no-store"
    assert "model-secret" not in response.content.decode()
    discover.assert_not_called()
    decrypt.assert_not_called()


@pytest.mark.parametrize("change", [{"provider": "anthropic"}, {"base_url": "https://api.anthropic.com/v1"}])
@pytest.mark.parametrize("key_value", [None, ""])
def test_destination_change_requires_fresh_key_and_is_atomic(session_client, create_user, change, key_value):
    config = save_settings(create_user)
    before = (config.provider, config.base_url, config.api_key_encrypted)
    body = dict(change)
    if key_value is not None:
        body["api_key"] = key_value
    response = session_client.patch(SETTINGS_URL, body, format="json")
    assert response.status_code == 400
    assert "api_key" in response.json()
    config.refresh_from_db()
    assert (config.provider, config.base_url, config.api_key_encrypted) == before


def test_model_only_update_preserves_existing_key_and_rotation_replaces_it(session_client, create_user):
    config = save_settings(create_user)
    original_ciphertext = config.api_key_encrypted
    response = session_client.patch(SETTINGS_URL, {"model": "new-model", "api_key": ""}, format="json")
    assert response.status_code == 200
    config.refresh_from_db()
    assert config.api_key_encrypted == original_ciphertext
    assert config.model == "new-model"
    response = session_client.patch(
        SETTINGS_URL,
        {"provider": "anthropic", "base_url": "https://api.anthropic.com/v1", "api_key": "rotated-secret"},
        format="json",
    )
    assert response.status_code == 200
    config.refresh_from_db()
    assert decrypt_model_key(config.api_key_encrypted) == "rotated-secret"
    assert "rotated-secret" not in response.content.decode()


def test_first_save_without_key_does_not_create_config(session_client, create_user):
    response = session_client.patch(SETTINGS_URL, {"model": "new-model"}, format="json")
    assert response.status_code == 400
    assert not UserAISettings.objects.filter(user=create_user).exists()


def test_private_gateway_is_accepted_with_explicit_new_key(session_client, create_user):
    config = save_settings(create_user)
    response = session_client.patch(
        SETTINGS_URL, {"base_url": "http://10.0.0.1:8000/v1", "api_key": "new-secret"}, format="json"
    )
    assert response.status_code == 200
    config.refresh_from_db()
    assert config.base_url == "http://10.0.0.1:8000/v1"
    assert decrypt_model_key(config.api_key_encrypted) == "new-secret"


def test_delete_only_removes_own_config_and_revokes_own_ai_tokens(session_client, create_user, other_user, workspace):
    save_settings(create_user)
    save_settings(other_user)
    own_ai = APIToken.objects.create(user=create_user, workspace=workspace, is_service=True, label=AGENT_TOKEN_LABEL)
    other_ai = APIToken.objects.create(user=other_user, workspace=workspace, is_service=True, label=AGENT_TOKEN_LABEL)
    own_regular = APIToken.objects.create(user=create_user, workspace=workspace, label="personal")
    response = session_client.delete(SETTINGS_URL)
    assert response.status_code == 204
    assert not UserAISettings.objects.filter(user=create_user).exists()
    assert UserAISettings.objects.filter(user=other_user).exists()
    own_ai.refresh_from_db()
    other_ai.refresh_from_db()
    own_regular.refresh_from_db()
    assert not own_ai.is_active
    assert other_ai.is_active and own_regular.is_active


@pytest.mark.parametrize("operation", ["get", "patch", "delete", "chat", "models"])
def test_anonymous_and_api_key_only_requests_cannot_use_session_ai_endpoints(
    api_client, api_token, workspace, operation
):
    url = (
        chat_url(workspace)
        if operation == "chat"
        else SETTINGS_URL + "models/"
        if operation == "models"
        else SETTINGS_URL
    )
    method = "post" if operation in ("chat", "models") else operation
    for headers in ({}, {"HTTP_X_API_KEY": api_token.token}):
        response = getattr(api_client, method)(url, **headers)
        assert response.status_code == 401


@pytest.mark.parametrize("operation", ["patch", "delete", "chat", "models"])
def test_real_session_mutations_require_csrf(create_user, workspace, operation):
    save_settings(create_user)
    client = APIClient(enforce_csrf_checks=True)
    client.force_login(create_user)
    url = (
        chat_url(workspace)
        if operation == "chat"
        else SETTINGS_URL + "models/"
        if operation == "models"
        else SETTINGS_URL
    )
    method = "post" if operation in ("chat", "models") else operation
    response = getattr(client, method)(url, {}, format="json")
    assert response.status_code == 403
    assert "CSRF" in str(response.data)
    assert UserAISettings.objects.filter(user=create_user).exists()
    assert not APIToken.objects.filter(user=create_user, label=AGENT_TOKEN_LABEL).exists()


def test_real_session_matching_csrf_cookie_and_header_can_update(create_user):
    client = APIClient(enforce_csrf_checks=True)
    client.force_login(create_user)
    csrf = "a" * 32
    client.cookies[django_settings.CSRF_COOKIE_NAME] = csrf
    response = client.patch(SETTINGS_URL, {"api_key": "csrf-authorized-key"}, format="json", HTTP_X_CSRFTOKEN=csrf)
    assert response.status_code == 200
    assert decrypt_model_key(UserAISettings.objects.get(user=create_user).api_key_encrypted) == "csrf-authorized-key"


@pytest.mark.parametrize("membership", ["absent", "inactive"])
def test_chat_requires_active_workspace_membership(session_client, create_user, workspace, membership, monkeypatch):
    save_settings(create_user)
    query = WorkspaceMember.objects.filter(workspace=workspace, member=create_user)
    if membership == "absent":
        query.delete()
    else:
        query.update(is_active=False)
    stream = Mock()
    monkeypatch.setattr("plane.app.views.ai.stream_agent_turn", stream)
    response = session_client.post(
        chat_url(workspace), {"messages": [{"role": "user", "content": "hello"}]}, format="json"
    )
    assert response.status_code == 403
    assert response.json()["code"] == "ai_access_denied"
    assert response.json()["may_have_changes"] is False
    stream.assert_not_called()


@pytest.mark.parametrize("case", ["absent", "inactive", "other-workspace"])
def test_chat_project_scope_requires_active_membership_in_same_workspace(session_client, create_user, workspace, case):
    save_workspace_settings(workspace)
    target_workspace = workspace
    if case == "other-workspace":
        target_workspace = Workspace.objects.create(name="Other", slug="other-ai-workspace", owner=create_user)
    project = Project.objects.create(name="Private", identifier="AIP", workspace=target_workspace)
    if case != "absent":
        ProjectMember.objects.create(
            project=project, workspace=target_workspace, member=create_user, role=15, is_active=case != "inactive"
        )
    response = session_client.post(
        chat_url(workspace),
        {"messages": [{"role": "user", "content": "hello"}], "project_id": str(project.id)},
        format="json",
    )
    assert response.status_code == 403
    assert response.json()["code"] == "ai_access_denied"
    assert response.json()["may_have_changes"] is False
    assert not APIToken.objects.filter(user=create_user, label=AGENT_TOKEN_LABEL).exists()


@pytest.mark.parametrize("role", [5, 15, 20])
def test_authorized_chat_uses_saved_config_and_session_identity_without_eager_token(
    session_client, create_user, workspace, role, monkeypatch
):
    save_workspace_settings(workspace)
    WorkspaceMember.objects.filter(workspace=workspace, member=create_user).update(role=role)
    captured = {}

    def stream(payload, workspace_id):
        captured.update(payload=payload, workspace_id=workspace_id)

        async def events():
            yield b'{"type":"done"}\n'

        return events()

    monkeypatch.setattr("plane.app.views.ai.stream_agent_turn", stream)
    response = session_client.post(
        chat_url(workspace),
        {
            "messages": [{"role": "user", "content": "hello", "tool_calls": [{"name": "delete"}]}],
            "user_id": "attacker",
            "workspace_slug": "other",
            "plane_api_token": "attacker-key",
            "model_config": {"api_key": "attacker-model-key"},
        },
        format="json",
        HTTP_ACCEPT_ENCODING="gzip, deflate, br",
    )
    assert response.status_code == 200
    assert response.streaming
    assert response["Content-Type"] == "application/x-ndjson"
    assert response["Cache-Control"] == "no-store, no-transform"
    assert "Content-Encoding" not in response
    assert response["X-Accel-Buffering"] == "no"
    assert captured["workspace_id"] == workspace.id
    assert captured["payload"]["user_id"] == str(create_user.id)
    assert captured["payload"]["workspace_slug"] == workspace.slug
    assert captured["payload"]["model_config"]["api_key"] == "model-secret"
    assert captured["payload"]["messages"] == [{"role": "user", "content": "hello"}]
    assert "plane_api_token" not in captured["payload"]
    assert not APIToken.objects.filter(user=create_user, label=AGENT_TOKEN_LABEL).exists()
    response.close()


@pytest.mark.parametrize(
    "url,secret",
    [
        ("http://live.internal", ""),
        ("", "secret"),
        ("not-a-url", "secret"),
        ("http://user:key@live.internal", "secret"),
    ],
)
def test_service_configuration_failure_never_claims_changes(
    session_client, create_user, workspace, settings, monkeypatch, url, secret
):
    settings.AI_AGENT_URL = url
    settings.LIVE_SERVER_SECRET_KEY = secret
    stream = Mock()
    monkeypatch.setattr("plane.app.views.ai.stream_agent_turn", stream)
    response = session_client.post(
        chat_url(workspace), {"messages": [{"role": "user", "content": "hello"}]}, format="json"
    )
    assert response.status_code == 503
    assert response.json() == {
        "error": "The AI service is not configured on this instance.",
        "code": "ai_service_not_configured",
        "may_have_changes": False,
    }
    stream.assert_not_called()
    assert not APIToken.objects.filter(user=create_user, label=AGENT_TOKEN_LABEL).exists()


def test_chat_does_not_require_public_live_url(session_client, create_user, workspace, settings, monkeypatch):
    settings.LIVE_URL = ""
    save_workspace_settings(workspace)
    monkeypatch.setattr("plane.app.views.ai.stream_agent_turn", Mock(return_value=iter([])))
    response = session_client.post(
        chat_url(workspace), {"messages": [{"role": "user", "content": "hello"}]}, format="json"
    )
    assert response.status_code == 200
    response.close()


@pytest.mark.parametrize("problem", ["missing", "unreadable", "invalid-url"])
def test_unusable_saved_settings_prevent_starting_chat(
    session_client, create_user, workspace, problem, settings, monkeypatch
):
    if problem != "missing":
        config = save_workspace_settings(workspace)
        provider = config.provider_config
        if problem == "unreadable":
            provider.api_key_encrypted = "not-a-valid-ciphertext"
            provider.save()
        else:
            provider.base_url = "https://user:secret@gateway.test"
            provider.save()
    stream = Mock()
    monkeypatch.setattr("plane.app.views.ai.stream_agent_turn", stream)
    response = session_client.post(
        chat_url(workspace), {"messages": [{"role": "user", "content": "hello"}]}, format="json"
    )
    assert response.status_code == 400
    assert response.json()["code"] == ("ai_key_unreadable" if problem == "unreadable" else "ai_model_not_configured")
    assert response.json()["may_have_changes"] is False
    stream.assert_not_called()
    assert "not-a-valid-ciphertext" not in response.content.decode()


@pytest.mark.parametrize("invalid", ["expired", "inactive", "inactive-user", "wrong-workspace"])
def test_temporary_api_token_authentication_rejects_invalid_authority(create_user, workspace, invalid):
    token = APIToken.objects.create(
        user=create_user,
        workspace=workspace,
        is_service=True,
        label=AGENT_TOKEN_LABEL,
        expired_at=timezone.now() + timedelta(minutes=3),
    )
    if invalid == "expired":
        token.expired_at = timezone.now() - timedelta(seconds=1)
        token.save()
    elif invalid == "inactive":
        token.is_active = False
        token.save()
    elif invalid == "inactive-user":
        create_user.is_active = False
        create_user.save()
    request = SimpleNamespace(
        headers={"X-Api-Key": token.token},
        path=f"/api/v1/workspaces/{workspace.slug}/projects/",
        parser_context={"kwargs": {"slug": "other" if invalid == "wrong-workspace" else workspace.slug}},
    )
    with pytest.raises(AuthenticationFailed):
        APIKeyAuthentication().authenticate(request)
    token.refresh_from_db()
    assert token.last_used is None


@pytest.mark.parametrize(
    "provider,base,key,allowed",
    [
        ("openai", "https://API.OPENAI.COM:443/v1/", "", True),
        ("openai", "", None, True),
        ("openai", "http://localhost:11434/v1", "", False),
        ("openai", "https://api.openai.com/other", None, False),
        ("anthropic", "https://api.openai.com/v1", "", False),
        ("openai", "http://10.0.0.1/v1", "explicit-new-key", True),
    ],
)
def test_discovery_saved_key_destination_isolation_without_mutation(
    session_client, create_user, other_user, monkeypatch, provider, base, key, allowed
):
    config = save_settings(create_user)
    save_settings(other_user, "other-user-key")
    before = (config.provider, config.base_url, config.api_key_encrypted, config.updated_at)
    discover = Mock(
        return_value={
            "models": [{"id": "custom", "name": "Custom", "vision": None, "tools": None}],
            "truncated": False,
        }
    )
    monkeypatch.setattr("plane.app.views.ai.discover_models", discover)
    body = {"provider": provider, "base_url": base, "user": str(other_user.id)}
    if key is not None:
        body["api_key"] = key
    response = session_client.post(SETTINGS_URL + "models/", body, format="json")
    assert response.status_code == (200 if allowed else 400)
    if allowed:
        assert discover.call_args.args[2] == (key or "model-secret")
        assert response["Cache-Control"] == "no-store"
    else:
        discover.assert_not_called()
    config.refresh_from_db()
    assert (config.provider, config.base_url, config.api_key_encrypted, config.updated_at) == before


def test_discovery_does_not_reuse_another_users_key(session_client, create_user, other_user, monkeypatch):
    save_settings(other_user)
    discover = Mock()
    monkeypatch.setattr("plane.app.views.ai.discover_models", discover)
    response = session_client.post(
        SETTINGS_URL + "models/", {"provider": "openai", "base_url": "", "user_id": str(other_user.id)}, format="json"
    )
    assert response.status_code == 400
    discover.assert_not_called()
    assert not UserAISettings.objects.filter(user=create_user).exists()


def test_discovery_with_new_key_and_valid_csrf_does_not_save(create_user, monkeypatch):
    client = APIClient(enforce_csrf_checks=True)
    client.force_login(create_user)
    csrf = "a" * 32
    client.cookies[django_settings.CSRF_COOKIE_NAME] = csrf
    discover = Mock(
        return_value={
            "models": [{"id": "custom", "name": "Custom", "vision": True, "tools": None}],
            "truncated": False,
        }
    )
    monkeypatch.setattr("plane.app.views.ai.discover_models", discover)
    response = client.post(
        SETTINGS_URL + "models/",
        {"provider": "anthropic", "base_url": "", "api_key": "new-key"},
        format="json",
        HTTP_X_CSRFTOKEN=csrf,
    )
    assert response.status_code == 200
    discover.assert_called_once_with("anthropic", "https://api.anthropic.com", "new-key")
    assert not UserAISettings.objects.filter(user=create_user).exists()


@pytest.mark.parametrize("vision", [True, False, None])
@pytest.mark.parametrize("stored", [False, True])
def test_saved_image_preference_matches_settings_chat_gate_and_payload(
    session_client, create_user, workspace, monkeypatch, vision, stored
):
    personal_config = save_settings(create_user)
    personal_config.supports_images = stored
    personal_config.save()
    config = save_workspace_settings(workspace, supports_images=stored)
    monkeypatch.setattr("plane.app.views.ai.lookup_model_metadata", lambda *args: {"vision": vision})
    stream = Mock(return_value=iter([]))
    monkeypatch.setattr("plane.app.views.ai.stream_agent_turn", stream)
    assert session_client.get(SETTINGS_URL).json()["supports_images"] is stored
    response = session_client.post(
        chat_url(workspace),
        {
            "messages": [
                {"role": "user", "content": "Describe", "images": [{"data": "iVBORw0KGgo=", "mime_type": "image/png"}]}
            ]
        },
        format="json",
    )
    if stored:
        assert response.status_code == 200
        assert stream.call_args.args[0]["model_config"]["supports_images"] is True
    else:
        assert response.status_code == 400
        assert response.json()["code"] == "ai_images_disabled"
        assert response.json()["may_have_changes"] is False
        stream.assert_not_called()
    config.refresh_from_db()
    assert config.supports_images is stored
    if stored:
        response.close()


def test_image_support_settings_and_forwarding(session_client, create_user, workspace, monkeypatch):
    personal_config = save_settings(create_user)
    config = save_workspace_settings(workspace, model="custom/not-in-catalogue")
    stream = Mock(return_value=iter([]))
    monkeypatch.setattr("plane.app.views.ai.stream_agent_turn", stream)
    messages = [
        {
            "role": "user",
            "content": "",
            "images": [{"data": "iVBORw0KGgo=", "mime_type": "image/png", "name": "diagram.png"}],
        }
    ]
    response = session_client.post(chat_url(workspace), {"messages": messages}, format="json")
    assert response.status_code == 400
    assert "does not support images" in response.json()["error"]
    stream.assert_not_called()
    response = session_client.patch(
        SETTINGS_URL, {"supports_images": True, "model": "personal-only-model"}, format="json"
    )
    assert response.status_code == 200
    personal_config.refresh_from_db()
    config.refresh_from_db()
    assert personal_config.supports_images is True
    assert config.supports_images is False
    response = session_client.patch(
        f"/api/workspaces/{workspace.slug}/ai-settings/providers/{config.provider_config_id}/models/{config.id}/",
        {"supports_images": True},
        format="json",
    )
    assert response.status_code == 200
    config.refresh_from_db()
    assert config.supports_images is True
    response = session_client.post(chat_url(workspace), {"messages": messages}, format="json")
    assert response.status_code == 200
    assert stream.call_args.args[0]["messages"] == messages
    assert stream.call_args.args[0]["model_config"]["supports_images"] is True
    response.close()


@pytest.mark.parametrize(
    "provider,expected", [("openai", "https://api.openai.com/v1"), ("anthropic", "https://api.anthropic.com")]
)
def test_settings_blank_base_uses_provider_default(session_client, provider, expected):
    response = session_client.patch(
        SETTINGS_URL, {"provider": provider, "base_url": "", "api_key": "new-key"}, format="json"
    )
    assert response.status_code == 200
    assert response.json()["base_url"] == expected
