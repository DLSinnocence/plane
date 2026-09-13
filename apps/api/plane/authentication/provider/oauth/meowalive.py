# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import os
from datetime import datetime, timedelta, timezone

from plane.authentication.adapter.error import AUTHENTICATION_ERROR_CODES, AuthenticationException
from plane.authentication.adapter.oauth import OauthAdapter
from plane.utils.phone import normalize_phone_number
from plane.license.utils.instance_value import get_configuration_value

from .oidc import MeowAliveOIDCClient, OIDCError, OIDCUnverifiedEmail


class MeowAliveOAuthProvider(OauthAdapter):
    provider = "meowalive"
    scope = "openid profile email phone"

    def __init__(self, request, *, state, nonce, code_verifier, redirect_uri, code=None, callback=None):
        enabled, issuer, client_id, client_secret = get_configuration_value(
            [
                {"key": "IS_MEOWALIVE_ENABLED", "default": os.environ.get("IS_MEOWALIVE_ENABLED", "0")},
                {
                    "key": "MEOWALIVE_ISSUER_URL",
                    "default": os.environ.get("MEOWALIVE_ISSUER_URL", "https://sso.meowalive.com"),
                },
                {"key": "MEOWALIVE_CLIENT_ID", "default": os.environ.get("MEOWALIVE_CLIENT_ID", "")},
                {"key": "MEOWALIVE_CLIENT_SECRET", "default": os.environ.get("MEOWALIVE_CLIENT_SECRET", "")},
            ]
        )
        if enabled != "1" or not all(
            isinstance(value, str) and value.strip() for value in (issuer, client_id, client_secret)
        ):
            raise AuthenticationException(
                error_code=AUTHENTICATION_ERROR_CODES["MEOWALIVE_NOT_CONFIGURED"],
                error_message="MEOWALIVE_NOT_CONFIGURED",
            )
        self.nonce = nonce
        self.code_verifier = code_verifier
        self.profile = None
        try:
            self.oidc = MeowAliveOIDCClient(issuer, client_id, client_secret)
            auth_url = self.oidc.authorization_url(
                state=state, nonce=nonce, code_verifier=code_verifier, redirect_uri=redirect_uri
            )
        except OIDCError:
            raise AuthenticationException(
                error_code=AUTHENTICATION_ERROR_CODES["MEOWALIVE_OAUTH_PROVIDER_ERROR"],
                error_message="MEOWALIVE_OAUTH_PROVIDER_ERROR",
            ) from None
        super().__init__(
            request=request,
            provider=self.provider,
            client_id=client_id,
            scope=self.scope,
            redirect_uri=redirect_uri,
            auth_url=auth_url,
            token_url=self.oidc.metadata["token_endpoint"],
            userinfo_url=self.oidc.metadata["userinfo_endpoint"],
            client_secret=client_secret,
            code=code,
            callback=callback,
        )

    def set_token_data(self):
        try:
            tokens, self.profile = self.oidc.authenticate(
                code=self.code,
                nonce=self.nonce,
                code_verifier=self.code_verifier,
                redirect_uri=self.redirect_uri,
            )
            expires_in = tokens.get("expires_in")
            expires_at = (
                datetime.now(timezone.utc) + timedelta(seconds=int(expires_in)) if expires_in is not None else None
            )
        except OIDCUnverifiedEmail:
            raise AuthenticationException(
                error_code=AUTHENTICATION_ERROR_CODES["OAUTH_PROVIDER_UNVERIFIED_EMAIL"],
                error_message="OAUTH_PROVIDER_UNVERIFIED_EMAIL",
            ) from None
        except (OIDCError, ValueError, TypeError, OverflowError):
            self.logger.warning("MeowAlive OIDC authentication failed")
            raise AuthenticationException(
                error_code=AUTHENTICATION_ERROR_CODES["MEOWALIVE_OAUTH_PROVIDER_ERROR"],
                error_message="MEOWALIVE_OAUTH_PROVIDER_ERROR",
            ) from None
        super().set_token_data(
            {
                "access_token": tokens["access_token"],
                "refresh_token": tokens.get("refresh_token"),
                "access_token_expired_at": expires_at,
                "refresh_token_expired_at": None,
                "id_token": tokens["id_token"],
            }
        )

    def get_display_name(self):
        # Casdoor exposes its display name as the OIDC UserInfo `name` claim.
        name = (self.profile or {}).get("name")
        return name.strip() if isinstance(name, str) else ""

    def save_user_data(self, user):
        display_name = self.get_display_name()
        if display_name:
            user.display_name = display_name
            # Store the complete name without appending a separate family name.
            user.first_name = display_name
            user.last_name = ""

        # The configured SSO issuer is trusted when phone verification is absent.
        # Explicit verification must be boolean true; malformed flags fail closed.
        # Clear unavailable numbers on every login to avoid stale recipients.
        profile = self.profile or {}
        if any(key in profile and profile[key] is not True for key in ("phone_number_verified", "phoneVerified")):
            user.mobile_number = ""
        elif "phone_number" in profile:
            user.mobile_number = normalize_phone_number(profile["phone_number"])
        else:
            user.mobile_number = normalize_phone_number(profile.get("phone"), profile.get("phoneCountryCode"))
        return super().save_user_data(user)

    def set_user_data(self):
        display_name = self.get_display_name()
        # Avatars are managed locally; do not map the SSO picture claim.
        super().set_user_data(
            {
                "email": self.profile["email"],
                "user": {
                    "provider_id": self.profile["sub"],
                    "email": self.profile["email"],
                    "display_name": display_name,
                    "first_name": display_name,
                    "last_name": "",
                    "is_password_autoset": True,
                },
            }
        )
