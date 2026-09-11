# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import time
from urllib.parse import parse_qs, urlsplit
from unittest.mock import MagicMock

import pytest

from plane.authentication.adapter.error import AuthenticationException
from plane.authentication.provider.oauth import meowalive as provider_module
from plane.authentication.provider.oauth.oidc import OIDCUnverifiedEmail
from plane.authentication.views.app import meowalive as views
from plane.authentication.views.space.meowalive import (
    MeowAliveCallbackSpaceEndpoint,
    MeowAliveOauthInitiateSpaceEndpoint,
)

pytestmark = pytest.mark.unit
HOST = "https://task.meowalive.com"


@pytest.fixture
def flow(monkeypatch, settings, rf):
    settings.WEB_URL = HOST
    settings.APP_BASE_URL = ""
    settings.SPACE_BASE_URL = ""
    settings.SPACE_BASE_PATH = "/spaces"
    monkeypatch.setattr(views.MeowAliveView, "instance_ready", lambda self: True)
    factory = MagicMock()
    factory.return_value.get_auth_url.return_value = "https://sso.meowalive.com/login/oauth/authorize?state=test"
    monkeypatch.setattr(views, "MeowAliveOAuthProvider", factory)
    login = MagicMock()
    monkeypatch.setattr(views, "user_login", login)
    monkeypatch.setattr(views, "get_redirection_path", lambda **kwargs: "/workspace/")

    def request(path, session=None, **query):
        req = rf.get(path, query, secure=True, HTTP_HOST="task.meowalive.com")
        req.session = session if session is not None else {}
        return req

    return request, factory, login


@pytest.mark.parametrize("space", [False, True])
def test_initiation_binds_state_nonce_pkce_and_correct_callback(flow, space):
    request, factory, _ = flow
    view = MeowAliveOauthInitiateSpaceEndpoint if space else views.MeowAliveOauthInitiateEndpoint
    req = request("/auth/meowalive/", next_path="/workspace/issues/")
    response = view.as_view()(req)
    key = "meowalive_oauth_space" if space else "meowalive_oauth_app"
    transaction = req.session[key]
    assert response.status_code == 302
    assert len(transaction["state"]) >= 32
    assert len(transaction["nonce"]) >= 32
    assert 43 <= len(transaction["code_verifier"]) <= 128
    assert transaction["state"] != transaction["nonce"]
    assert transaction["redirect_uri"] == HOST + (
        "/auth/spaces/meowalive/callback/" if space else "/auth/meowalive/callback/"
    )
    assert factory.call_args.kwargs["redirect_uri"] == transaction["redirect_uri"]


@pytest.mark.parametrize("space", [False, True])
def test_successful_callback_logs_in_and_consumes_state(flow, space):
    request, factory, login = flow
    initiate = MeowAliveOauthInitiateSpaceEndpoint if space else views.MeowAliveOauthInitiateEndpoint
    callback = MeowAliveCallbackSpaceEndpoint if space else views.MeowAliveCallbackEndpoint
    req = request("/auth/meowalive/")
    initiate.as_view()(req)
    key = "meowalive_oauth_space" if space else "meowalive_oauth_app"
    state = req.session[key]["state"]
    result = callback.as_view()(request("/callback/", req.session, state=state, code="authorization-code"))
    assert result.status_code == 302
    assert result.url == HOST + ("/spaces/" if space else "/workspace/")
    login.assert_called_once()
    assert login.call_args.kwargs["is_space"] is space
    assert login.call_args.kwargs["is_app"] is (not space)
    assert key not in req.session
    callback.as_view()(request("/callback/", req.session, state=state, code="authorization-code"))
    assert login.call_count == 1
    assert factory.return_value.authenticate.call_count == 1


@pytest.mark.parametrize(
    "failure", ["state", "missing_state", "empty_state", "expired", "future", "missing_code", "denied", "unicode_state"]
)
def test_invalid_callback_never_exchanges_code_or_logs_in(flow, failure):
    request, factory, login = flow
    req = request("/auth/meowalive/")
    views.MeowAliveOauthInitiateEndpoint.as_view()(req)
    transaction = req.session["meowalive_oauth_app"]
    query = {"state": transaction["state"], "code": "authorization-code"}
    if failure == "state":
        query["state"] = "attacker-state"
    elif failure == "missing_state":
        query.pop("state")
    elif failure == "empty_state":
        query["state"] = ""
    elif failure == "expired":
        transaction["created_at"] = time.time() - 601
    elif failure == "future":
        transaction["created_at"] = time.time() + 60
    elif failure == "missing_code":
        query.pop("code")
    elif failure == "denied":
        query["error"] = "access_denied"
    elif failure == "unicode_state":
        query["state"] = "猫"
    result = views.MeowAliveCallbackEndpoint.as_view()(request("/callback/", req.session, **query))
    assert parse_qs(urlsplit(result.url).query)["error_code"] == ["5126"]
    login.assert_not_called()
    factory.return_value.authenticate.assert_not_called()
    assert "meowalive_oauth_app" not in req.session


def test_space_state_cannot_be_used_on_app_callback(flow):
    request, factory, login = flow
    req = request("/auth/spaces/meowalive/")
    MeowAliveOauthInitiateSpaceEndpoint.as_view()(req)
    state = req.session["meowalive_oauth_space"]["state"]
    views.MeowAliveCallbackEndpoint.as_view()(request("/callback/", req.session, state=state, code="code"))
    login.assert_not_called()
    factory.return_value.authenticate.assert_not_called()


def test_new_login_does_not_inherit_old_next_path(flow):
    request, _, _ = flow
    req = request("/auth/meowalive/", next_path="/old-workspace/")
    views.MeowAliveOauthInitiateEndpoint.as_view()(req)
    old_state = req.session["meowalive_oauth_app"]["state"]
    views.MeowAliveOauthInitiateEndpoint.as_view()(request("/auth/meowalive/", req.session))
    assert req.session["meowalive_oauth_app"]["next_path"] is None
    assert req.session["meowalive_oauth_app"]["state"] != old_state


def test_external_next_path_stays_on_plane_origin(flow):
    request, _, _ = flow
    req = request("/auth/meowalive/", next_path="https://attacker.example.com/collect")
    views.MeowAliveOauthInitiateEndpoint.as_view()(req)
    state = req.session["meowalive_oauth_app"]["state"]
    result = views.MeowAliveCallbackEndpoint.as_view()(request("/callback/", req.session, state=state, code="code"))
    assert urlsplit(result.url).netloc == "task.meowalive.com"


@pytest.mark.parametrize(
    "enabled,client_id,secret", [("0", "client", "secret"), ("1", "", "secret"), ("1", "client", "")]
)
def test_disabled_or_unconfigured_provider_cannot_be_invoked_directly(monkeypatch, rf, enabled, client_id, secret):
    monkeypatch.setattr(
        provider_module, "get_configuration_value", lambda _: (enabled, "https://sso.meowalive.com", client_id, secret)
    )
    client = MagicMock()
    monkeypatch.setattr(provider_module, "MeowAliveOIDCClient", client)
    with pytest.raises(AuthenticationException) as error:
        provider_module.MeowAliveOAuthProvider(
            rf.get("/"),
            state="state",
            nonce="nonce",
            code_verifier="v" * 64,
            redirect_uri=HOST + "/auth/meowalive/callback/",
        )
    assert error.value.error_code == 5113
    client.assert_not_called()


def test_unverified_email_never_reaches_account_linking(monkeypatch, rf):
    monkeypatch.setattr(
        provider_module, "get_configuration_value", lambda _: ("1", "https://sso.meowalive.com", "client", "secret")
    )
    client = MagicMock()
    client.return_value.authenticate.side_effect = OIDCUnverifiedEmail("unverified")
    monkeypatch.setattr(provider_module, "MeowAliveOIDCClient", client)
    provider = provider_module.MeowAliveOAuthProvider(
        rf.get("/"),
        state="state",
        nonce="nonce",
        code_verifier="v" * 64,
        redirect_uri=HOST + "/auth/meowalive/callback/",
    )
    complete = MagicMock()
    monkeypatch.setattr(provider, "complete_login_or_signup", complete)
    with pytest.raises(AuthenticationException) as error:
        provider.authenticate()
    assert error.value.error_code == 5124
    complete.assert_not_called()
