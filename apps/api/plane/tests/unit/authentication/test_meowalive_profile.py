# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from unittest.mock import MagicMock
from uuid import uuid4

from django.db import models
import pytest

from plane.authentication.adapter import base
from plane.authentication.provider.oauth.meowalive import MeowAliveOAuthProvider
from plane.db.models import User

pytestmark = pytest.mark.unit


@pytest.fixture
def provider(rf):
    provider = MeowAliveOAuthProvider.__new__(MeowAliveOAuthProvider)
    base.Adapter.__init__(provider, request=rf.get("/"), provider="meowalive")
    provider.profile = {
        "sub": "sso-user",
        "email": "email-prefix@example.test",
        "name": "张三",
        "given_name": "Different given name",
        "family_name": "Different family name",
        "picture": "https://sso.example.test/avatar.png",
    }
    provider.download_and_upload_avatar = MagicMock(side_effect=AssertionError("SSO avatars must not be imported"))
    provider.delete_old_avatar = MagicMock(side_effect=AssertionError("Local avatars must be preserved"))
    return provider


@pytest.fixture
def persisted_users(monkeypatch):
    """Observe persistence while keeping the real User.save() name defaults."""
    persisted = []

    def save(user, *args, **kwargs):
        persisted.append((user.display_name, user.full_name, user.avatar, user.avatar_asset_id))

    monkeypatch.setattr(models.Model, "save", save)
    monkeypatch.setattr(base.Profile.objects, "create", MagicMock())
    monkeypatch.setattr(base, "get_configuration_value", lambda _: ("1",))
    return persisted


@pytest.mark.parametrize("returning", [False, True])
@pytest.mark.parametrize("name", ["张三", "Ada Lovelace"])
def test_login_uses_sso_display_name_for_both_names_and_preserves_local_avatar(
    provider, persisted_users, monkeypatch, returning, name
):
    avatar = "https://plane.example.test/local-avatar.png" if returning else ""
    avatar_asset_id = uuid4() if returning else None
    existing = (
        User(
            email=provider.profile["email"],
            username="existing-user",
            display_name="Old local nickname",
            first_name="Old given name",
            last_name="Old family name",
            avatar=avatar,
            avatar_asset_id=avatar_asset_id,
        )
        if returning
        else None
    )
    query = MagicMock()
    query.first.return_value = existing
    monkeypatch.setattr(User.objects, "filter", MagicMock(return_value=query))
    provider.profile["name"] = f"  {name}  "
    provider.set_user_data()

    user = provider.complete_login_or_signup()

    if returning:
        assert user is existing
    assert user.display_name == name
    assert user.full_name == name
    assert user.first_name == name
    assert user.last_name == ""
    assert persisted_users[-1] == (name, name, avatar, avatar_asset_id)
    provider.download_and_upload_avatar.assert_not_called()
    provider.delete_old_avatar.assert_not_called()

    # A later SSO rename also replaces local edits on the next login.
    user.display_name = "Locally edited nickname"
    user.first_name = "Locally edited given name"
    user.last_name = "Locally edited family name"
    query.first.return_value = user
    provider.profile["name"] = "Updated SSO display name"
    provider.set_user_data()
    provider.complete_login_or_signup()

    assert persisted_users[-1] == ("Updated SSO display name", "Updated SSO display name", avatar, avatar_asset_id)
    provider.download_and_upload_avatar.assert_not_called()
    provider.delete_old_avatar.assert_not_called()


@pytest.mark.parametrize(
    "name_claim", [{}, {"name": None}, {"name": ""}, {"name": " \t "}, {"name": 123}, {"name": {}}]
)
def test_unavailable_sso_display_name_preserves_existing_names(provider, persisted_users, monkeypatch, name_claim):
    provider.profile.pop("name")
    provider.profile.update(name_claim)
    user = User(
        email=provider.profile["email"],
        username="existing-user",
        display_name="Local nickname",
        first_name="Local given",
        last_name="Local family",
    )
    query = MagicMock()
    query.first.return_value = user
    monkeypatch.setattr(User.objects, "filter", MagicMock(return_value=query))
    provider.set_user_data()

    assert provider.complete_login_or_signup() is user

    assert persisted_users[-1][:2] == ("Local nickname", "Local given Local family")
    provider.download_and_upload_avatar.assert_not_called()


def test_signup_without_sso_display_name_keeps_email_fallback(provider, persisted_users, monkeypatch):
    provider.profile.pop("name")
    query = MagicMock()
    query.first.return_value = None
    monkeypatch.setattr(User.objects, "filter", MagicMock(return_value=query))
    provider.set_user_data()

    user = provider.complete_login_or_signup()

    assert user.display_name == "email-prefix"
    assert user.full_name == ""
    assert persisted_users[-1] == ("email-prefix", "", "", None)
    provider.download_and_upload_avatar.assert_not_called()
