# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import secrets
import time
from urllib.parse import urlencode, urljoin

from django.http import HttpResponseRedirect
from django.views import View

from plane.authentication.adapter.error import AUTHENTICATION_ERROR_CODES, AuthenticationException
from plane.authentication.provider.oauth.meowalive import MeowAliveOAuthProvider
from plane.authentication.utils.host import base_host
from plane.authentication.utils.login import user_login
from plane.authentication.utils.redirection_path import get_redirection_path
from plane.authentication.utils.user_auth_workflow import post_user_auth_workflow
from plane.license.models import Instance
from plane.utils.path_validator import validate_next_path


class MeowAliveView(View):
    is_space = False
    transaction_lifetime = 600

    @property
    def session_key(self):
        return "meowalive_oauth_space" if self.is_space else "meowalive_oauth_app"

    def origin(self, request):
        return base_host(request=request, is_app=not self.is_space, is_space=self.is_space)

    def error_redirect(self, request, error="MEOWALIVE_OAUTH_PROVIDER_ERROR", next_path=None):
        params = {
            "error_code": AUTHENTICATION_ERROR_CODES[error],
            "error_message": error,
        }
        if next_path:
            params["next_path"] = str(validate_next_path(next_path))
        return HttpResponseRedirect(f"{self.origin(request)}?{urlencode(params)}")

    def instance_ready(self):
        instance = Instance.objects.first()
        return instance is not None and instance.is_setup_done


class MeowAliveOauthInitiateEndpoint(MeowAliveView):
    def get(self, request):
        next_path = request.GET.get("next_path")
        next_path = str(validate_next_path(next_path)) if next_path else None
        # Separate app/space state and replace the entire previous transaction,
        # including next_path, so a fresh login cannot inherit a stale redirect.
        request.session.pop(self.session_key, None)
        if not self.instance_ready():
            return self.error_redirect(request, "INSTANCE_NOT_CONFIGURED", next_path)
        callback_path = "/auth/spaces/meowalive/callback/" if self.is_space else "/auth/meowalive/callback/"
        transaction = {
            "state": secrets.token_urlsafe(32),
            "nonce": secrets.token_urlsafe(32),
            "code_verifier": secrets.token_urlsafe(64),
            "redirect_uri": request.build_absolute_uri(callback_path),
            "created_at": time.time(),
            "next_path": next_path,
        }
        try:
            provider = MeowAliveOAuthProvider(
                request=request,
                state=transaction["state"],
                nonce=transaction["nonce"],
                code_verifier=transaction["code_verifier"],
                redirect_uri=transaction["redirect_uri"],
            )
        except AuthenticationException as exc:
            return self.error_redirect(request, exc.error_message, next_path)
        request.session[self.session_key] = transaction
        return HttpResponseRedirect(provider.get_auth_url())


class MeowAliveCallbackEndpoint(MeowAliveView):
    def get(self, request):
        # A callback consumes its state even on denial, expiry, or failure.
        transaction = request.session.pop(self.session_key, None)
        if not isinstance(transaction, dict):
            return self.error_redirect(request)
        next_path = transaction.get("next_path")
        state = request.GET.get("state", "")
        expected = transaction.get("state")
        try:
            valid_state = (
                bool(state)
                and isinstance(expected, str)
                and secrets.compare_digest(state, expected)
                and 0 <= time.time() - transaction["created_at"] <= self.transaction_lifetime
                and all(transaction.get(key) for key in ("nonce", "code_verifier", "redirect_uri"))
            )
        except (KeyError, TypeError, ValueError):
            valid_state = False
        code = request.GET.get("code")
        if not valid_state or not code or request.GET.get("error"):
            return self.error_redirect(request, next_path=next_path)
        if not self.instance_ready():
            return self.error_redirect(request, "INSTANCE_NOT_CONFIGURED", next_path)
        try:
            provider = MeowAliveOAuthProvider(
                request=request,
                code=code,
                state=expected,
                nonce=transaction["nonce"],
                code_verifier=transaction["code_verifier"],
                redirect_uri=transaction["redirect_uri"],
                callback=None if self.is_space else post_user_auth_workflow,
            )
            user = provider.authenticate()
            user_login(request=request, user=user, is_app=not self.is_space, is_space=self.is_space)
            if self.is_space:
                path = str(validate_next_path(next_path)).lstrip("/") if next_path else ""
                url = urljoin(self.origin(request).rstrip("/") + "/", path)
            else:
                path = str(validate_next_path(next_path)) if next_path else get_redirection_path(user=user)
                url = urljoin(self.origin(request).rstrip("/") + "/", path)
            return HttpResponseRedirect(url)
        except AuthenticationException as exc:
            # Preserve existing signup/account-disabled errors from the adapter.
            return self.error_redirect(request, exc.error_message, next_path)
