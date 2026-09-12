# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from unittest.mock import Mock

import pytest
from rest_framework.test import APIClient

from plane.db.models import Project, ProjectMember, ProjectMemberInvite, User, WorkspaceMember, WorkspaceMemberInvite

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture(autouse=True)
def invitation_settings(settings, monkeypatch):
    from django.core.cache import cache

    settings.APP_BASE_URL = "https://plane.example.test"
    settings.WEB_URL = "https://plane.example.test"
    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
    cache.clear()
    monkeypatch.setattr("plane.utils.cache.invalidate_cache_directly", Mock())
    monkeypatch.setattr("plane.app.views.workspace.invite.invalidate_cache_directly", Mock())
    monkeypatch.setattr("plane.middleware.logger.process_logs.delay", Mock())
    yield
    cache.clear()


@pytest.fixture(autouse=True)
def mail_configuration(monkeypatch):
    configuration = Mock(return_value=(None, None, None, "587", "1", "0", "noreply@example.com"))
    monkeypatch.setattr("plane.utils.invitations.get_email_configuration", configuration)
    return configuration


@pytest.fixture(params=["workspace", "project"])
def invitation_scope(request, workspace, create_user):
    if request.param == "workspace":
        return {
            "url": f"/api/workspaces/{workspace.slug}/invitations/",
            "model": WorkspaceMemberInvite,
            "task": "plane.app.views.workspace.invite.workspace_invitation.delay",
            "join": lambda invite: f"/api/workspaces/{workspace.slug}/invitations/{invite.id}/join/",
        }
    project = Project.objects.create(name="Invitation project", identifier="INV", workspace=workspace)
    ProjectMember.objects.create(project=project, workspace=workspace, member=create_user, role=20)
    return {
        "url": f"/api/workspaces/{workspace.slug}/projects/{project.id}/invitations/",
        "model": ProjectMemberInvite,
        "task": "plane.app.views.project.invite.project_invitation.delay",
        "join": lambda invite: f"/api/workspaces/{workspace.slug}/projects/{project.id}/join/{invite.id}/",
        "project": project,
    }


def create_invitation(client, scope, email="new.person@example.com", role=15):
    return client.post(scope["url"], {"emails": [{"email": email, "role": role}]}, format="json")


def test_unregistered_email_without_smtp_is_persisted(session_client, invitation_scope, workspace, monkeypatch):
    task = Mock()
    monkeypatch.setattr(invitation_scope["task"], task)
    response = create_invitation(session_client, invitation_scope, "  NEW.Person@example.com  ")
    assert response.status_code == 200, response.data
    assert response.data["email_status"] == "not_configured"
    invitation = invitation_scope["model"].objects.get(email="new.person@example.com")
    returned = response.json()["invitations"][0]
    assert returned["id"] == str(invitation.id)
    assert invitation.token and invitation.token in returned["invite_link"]
    assert returned["invite_link"].startswith("/workspace-invitations/")
    assert invitation.responded_at is None and not invitation.accepted
    assert not User.objects.filter(email=invitation.email).exists()
    assert WorkspaceMember.objects.filter(workspace=workspace).count() == 1
    task.assert_not_called()


def test_no_smtp_invitation_does_not_require_mail_origin(session_client, invitation_scope, settings):
    settings.APP_BASE_URL = ""
    settings.WEB_URL = ""
    response = create_invitation(session_client, invitation_scope)
    assert response.status_code == 200, response.data
    assert response.data["email_status"] == "not_configured"
    assert response.data["invitations"][0]["invite_link"].startswith("/workspace-invitations/")


def test_missing_mail_origin_keeps_saved_invitation_when_smtp_enabled(
    session_client, invitation_scope, settings, mail_configuration, monkeypatch
):
    settings.APP_BASE_URL = ""
    settings.WEB_URL = ""
    mail_configuration.return_value = ("smtp.example.com", None, None, "587", "1", "0", "noreply@example.com")
    task = Mock()
    monkeypatch.setattr(invitation_scope["task"], task)
    response = create_invitation(session_client, invitation_scope)
    assert response.status_code == 200, response.data
    assert response.data["email_status"] == "failed"
    assert invitation_scope["model"].objects.count() == 1
    assert response.data["invitations"][0]["invite_link"].startswith("/workspace-invitations/")
    task.assert_not_called()


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"emails": []},
        {"emails": "email@example.com"},
        {"emails": [None]},
        {"emails": [{"email": "broken", "role": 15}]},
        {"emails": [{"email": "valid@example.com", "role": 999}]},
        {"emails": [{"email": "valid@example.com", "role": "admin"}]},
        {"emails": [{"email": "valid@example.com", "role": True}]},
        {"emails": [{"email": "valid@example.com", "role": 15}, {"email": "VALID@example.com", "role": 20}]},
    ],
)
def test_invalid_request_does_not_create_invites(session_client, invitation_scope, payload):
    response = session_client.post(invitation_scope["url"], payload, format="json")
    assert response.status_code == 400, response.data
    assert not invitation_scope["model"].objects.exists()


def test_duplicate_invites_reuse_persisted_token_and_role(session_client, invitation_scope):
    first = create_invitation(session_client, invitation_scope)
    assert first.status_code == 200, first.data
    second = session_client.post(
        invitation_scope["url"],
        {
            "emails": [
                {"email": "NEW.PERSON@example.com", "role": 5},
                {"email": " new.person@example.com ", "role": 5},
            ]
        },
        format="json",
    )
    assert second.status_code == 200, second.data
    assert invitation_scope["model"].objects.count() == 1
    assert len(second.data["invitations"]) == 1
    for field in ["id", "token", "invite_link", "role"]:
        assert second.data["invitations"][0][field] == first.data["invitations"][0][field]


@pytest.mark.parametrize("fails", [True, False])
def test_dispatch_after_commit_keeps_invitation_on_broker_failure(
    session_client, invitation_scope, mail_configuration, monkeypatch, django_capture_on_commit_callbacks, fails
):
    mail_configuration.return_value = ("smtp.example.com", None, None, "587", "1", "0", "noreply@example.com")
    task = Mock(side_effect=RuntimeError("broker unavailable") if fails else None)
    monkeypatch.setattr(invitation_scope["task"], task)
    with django_capture_on_commit_callbacks(execute=True):
        response = create_invitation(session_client, invitation_scope)
        assert response.status_code == 200, response.data
        assert invitation_scope["model"].objects.count() == 1
        task.assert_not_called()
    assert response.data["email_status"] == ("failed" if fails else "queued")
    invitation = invitation_scope["model"].objects.get()
    assert invitation.token in response.data["invitations"][0]["invite_link"]
    task.assert_called_once()


def test_accept_requires_token_and_matching_authenticated_email(
    session_client, api_client, invitation_scope, workspace
):
    response = create_invitation(session_client, invitation_scope)
    assert response.status_code == 200, response.data
    invitation = invitation_scope["model"].objects.get()
    url = invitation_scope["join"](invitation)
    payload = {"accepted": True, "token": invitation.token}
    assert APIClient().post(url, payload, format="json").status_code == 401
    assert session_client.post(url, payload, format="json").status_code == 403
    recipient = User.objects.create(email=invitation.email, username="invited-person")
    session_client.force_authenticate(recipient)
    assert session_client.post(url, {"accepted": True, "token": "wrong"}, format="json").status_code == 403
    assert session_client.post(url, {"accepted": "false", "token": invitation.token}, format="json").status_code == 400
    invitation.refresh_from_db()
    assert invitation.responded_at is None
    if "project" in invitation_scope:
        other_project = Project.objects.create(name="Other project", identifier="OTH", workspace=workspace)
        ProjectMember.objects.create(project=other_project, workspace=workspace, member=recipient, role=5)
    accepted = session_client.post(url, payload, format="json")
    assert accepted.status_code == 200, accepted.data
    assert WorkspaceMember.objects.filter(workspace=workspace, member=recipient, is_active=True).exists()
    if "project" in invitation_scope:
        assert ProjectMember.objects.filter(project=invitation_scope["project"], member=recipient, role=15).exists()


def test_public_detail_never_exposes_token_in_message(session_client, api_client, invitation_scope):
    create_invitation(session_client, invitation_scope)
    invitation = invitation_scope["model"].objects.get()
    invitation.message = f"Open https://example.com/?token={invitation.token}"
    invitation.save()
    response = APIClient().get(invitation_scope["join"](invitation))
    assert response.status_code == 200, response.data
    assert "token" not in response.data and "invite_link" not in response.data and "message" not in response.data
    assert invitation.token not in str(response.data)


def test_unverified_user_cannot_discover_or_accept_without_token(session_client, workspace, create_user):
    invitation = WorkspaceMemberInvite.objects.create(workspace=workspace, email=create_user.email, token="secret")
    response = session_client.get("/api/users/me/workspaces/invitations/")
    assert "secret" not in str(response.data)
    response = session_client.post(
        "/api/users/me/workspaces/invitations/", {"invitations": [str(invitation.id)]}, format="json"
    )
    assert response.status_code == 403
    assert WorkspaceMemberInvite.objects.filter(pk=invitation.pk).exists()


def test_workspace_member_cannot_invite_or_edit_higher_role(session_client, workspace, create_user):
    WorkspaceMember.objects.filter(workspace=workspace, member=create_user).update(role=15)
    url = f"/api/workspaces/{workspace.slug}/invitations/"
    response = session_client.post(url, {"emails": [{"email": "new@example.com", "role": 20}]}, format="json")
    assert response.status_code == 400
    invitation = WorkspaceMemberInvite.objects.create(
        workspace=workspace, email="new@example.com", token="secret", role=5
    )
    response = session_client.patch(f"{url}{invitation.id}/", {"role": 20}, format="json")
    assert response.status_code == 400
    invitation.refresh_from_db()
    assert invitation.role == 5


def test_reinvite_repairs_legacy_empty_token(session_client, workspace):
    invitation = WorkspaceMemberInvite.objects.create(workspace=workspace, email="new.person@example.com", token="")
    response = session_client.post(
        f"/api/workspaces/{workspace.slug}/invitations/",
        {"emails": [{"email": invitation.email, "role": 15}]},
        format="json",
    )
    assert response.status_code == 200, response.data
    invitation.refresh_from_db()
    assert invitation.token
    assert invitation.token in response.data["invitations"][0]["invite_link"]


def test_project_invitation_does_not_restore_workspace_admin(workspace, create_user):
    project = Project.objects.create(name="Project invite", identifier="PIV", workspace=workspace)
    recipient = User.objects.create(email="former-admin@example.com", username="former-admin")
    membership = WorkspaceMember.objects.create(workspace=workspace, member=recipient, role=20, is_active=False)
    invitation = ProjectMemberInvite.objects.create(
        workspace=workspace, project=project, email=recipient.email, role=20, token="private-project-token"
    )
    client = APIClient()
    client.force_authenticate(user=recipient)
    response = client.post(
        f"/api/workspaces/{workspace.slug}/projects/{project.pk}/join/{invitation.pk}/",
        {"token": invitation.token, "accepted": True},
        format="json",
    )
    assert response.status_code == 200, response.data
    membership.refresh_from_db()
    assert membership.is_active and membership.role == 15
    assert ProjectMember.objects.filter(project=project, member=recipient, role=20).exists()


def test_external_api_creates_real_token_and_idempotent_link(api_key_client, workspace):
    url = f"/api/v1/workspaces/{workspace.slug}/invitations/"
    response = api_key_client.post(url, {"email": "API.PERSON@example.com", "role": 15}, format="json")
    assert response.status_code == 201, response.data
    assert response.data["email_status"] == "not_configured"
    invitation = WorkspaceMemberInvite.objects.get(email="api.person@example.com")
    assert response.json()["id"] == str(invitation.id)
    assert invitation.token in response.data["invitations"][0]["invite_link"]
    duplicate = api_key_client.post(url, {"email": "api.person@example.com", "role": 15}, format="json")
    assert duplicate.status_code == 201, duplicate.data
    assert duplicate.data["invitations"][0]["invite_link"] == response.data["invitations"][0]["invite_link"]
