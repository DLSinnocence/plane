# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The OIDC authorization-code flow used by MeowAlive's Casdoor service."""

import base64
import hashlib
import secrets
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import jwt
import requests


class OIDCError(Exception):
    """A provider response could not be authenticated or used safely."""


class OIDCUnverifiedEmail(OIDCError):
    """Email-based account linking requires an explicitly verified email."""


def https_origin(url):
    try:
        if (
            not isinstance(url, str)
            or "\\" in url
            or "#" in url
            or any(ord(char) <= 32 or ord(char) == 127 for char in url)
        ):
            raise ValueError
        parsed = urlsplit(url)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
        ):
            raise ValueError
        return parsed.hostname.lower(), parsed.port or 443
    except (TypeError, ValueError) as exc:
        raise OIDCError("An HTTPS provider URL without credentials or fragments is required") from exc


class MeowAliveOIDCClient:
    timeout = (5, 15)

    def __init__(self, issuer, client_id, client_secret):
        self.issuer = issuer.rstrip("/")
        self.origin = https_origin(self.issuer)
        if "?" in self.issuer:
            raise OIDCError("The issuer must not contain a query string")
        self.client_id = client_id
        self.client_secret = client_secret
        self.metadata = self._json("GET", f"{self.issuer}/.well-known/openid-configuration")
        if self.metadata.get("issuer") != self.issuer:
            raise OIDCError("Discovery issuer does not match the configured issuer")
        for key in ("authorization_endpoint", "token_endpoint", "userinfo_endpoint", "jwks_uri"):
            endpoint = self.metadata.get(key)
            if not isinstance(endpoint, str) or https_origin(endpoint) != self.origin:
                raise OIDCError("OIDC endpoints must use the configured provider's HTTPS origin")
        response_types = self.metadata.get("response_types_supported")
        signing_algorithms = self.metadata.get("id_token_signing_alg_values_supported")
        if not isinstance(response_types, list) or "code" not in response_types:
            raise OIDCError("The provider must support the authorization-code flow")
        if not isinstance(signing_algorithms, list) or "RS256" not in signing_algorithms:
            raise OIDCError("The provider must support RS256 ID tokens")

    def _json(self, method, url, **kwargs):
        # Never follow redirects with a client secret or access token. TLS
        # verification stays enabled, including for self-hosted Casdoor services.
        try:
            response = requests.request(method, url, timeout=self.timeout, allow_redirects=False, **kwargs)
            with response:
                if response.status_code != 200:
                    raise OIDCError("The OIDC endpoint returned an unsuccessful response")
                payload = response.json()
            if not isinstance(payload, dict):
                raise OIDCError("The OIDC endpoint did not return a JSON object")
            return payload
        except (requests.RequestException, ValueError) as exc:
            raise OIDCError("The OIDC endpoint could not be reached or returned invalid JSON") from exc

    def authorization_url(self, *, state, nonce, code_verifier, redirect_uri):
        challenge = base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode("ascii")).digest())
        endpoint = urlsplit(self.metadata["authorization_endpoint"])
        params = dict(parse_qsl(endpoint.query))
        params.update(
            client_id=self.client_id,
            response_type="code",
            scope="openid profile email",
            redirect_uri=redirect_uri,
            state=state,
            nonce=nonce,
            code_challenge=challenge.rstrip(b"=").decode("ascii"),
            code_challenge_method="S256",
        )
        return urlunsplit(endpoint._replace(query=urlencode(params)))

    def _verify_id_token(self, token, nonce, access_token):
        try:
            header = jwt.get_unverified_header(token)
            if header.get("alg") != "RS256" or not header.get("kid"):
                raise OIDCError("An RS256 ID token with a signing key ID is required")
            jwks = self._json("GET", self.metadata["jwks_uri"])
            keys = [
                key
                for key in jwks.get("keys", [])
                if isinstance(key, dict)
                and key.get("kid") == header["kid"]
                and key.get("kty") == "RSA"
                and key.get("use", "sig") == "sig"
                and key.get("alg", "RS256") == "RS256"
                and "verify" in key.get("key_ops", ["verify"])
            ]
            if len(keys) != 1:
                raise OIDCError("The ID token signing key is missing or ambiguous")
            key = jwt.PyJWK.from_dict(keys[0], algorithm="RS256")
            claims = jwt.decode(
                token,
                key.key,
                algorithms=["RS256"],
                audience=self.client_id,
                issuer=self.issuer,
                leeway=30,
                options={"require": ["iss", "sub", "aud", "exp", "iat", "nonce"]},
            )
            if not isinstance(claims["sub"], str) or not claims["sub"]:
                raise OIDCError("The ID token subject is missing")
            token_nonce = claims.get("nonce")
            if not isinstance(token_nonce, str) or not secrets.compare_digest(token_nonce, nonce):
                raise OIDCError("The ID token nonce does not match this login")
            audience = claims["aud"]
            if (isinstance(audience, list) and len(audience) > 1) or "azp" in claims:
                if claims.get("azp") != self.client_id:
                    raise OIDCError("The ID token authorized party does not match this client")
            if "at_hash" in claims:
                digest = hashlib.sha256(access_token.encode("ascii")).digest()
                expected = base64.urlsafe_b64encode(digest[: len(digest) // 2]).rstrip(b"=").decode("ascii")
                if not isinstance(claims["at_hash"], str) or not secrets.compare_digest(claims["at_hash"], expected):
                    raise OIDCError("The ID token is not bound to the access token")
            return claims
        except (jwt.PyJWTError, ValueError, TypeError, KeyError) as exc:
            raise OIDCError("The ID token could not be verified") from exc

    def authenticate(self, *, code, nonce, code_verifier, redirect_uri):
        data = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "code_verifier": code_verifier,
            "client_id": self.client_id,
        }
        methods = self.metadata.get("token_endpoint_auth_methods_supported", ["client_secret_basic"])
        kwargs = {}
        if "client_secret_post" in methods:
            data["client_secret"] = self.client_secret
        elif "client_secret_basic" in methods:
            kwargs["auth"] = (self.client_id, self.client_secret)
        else:
            raise OIDCError("The provider must support confidential clients")
        tokens = self._json(
            "POST", self.metadata["token_endpoint"], data=data, headers={"Accept": "application/json"}, **kwargs
        )
        access_token = tokens.get("access_token")
        id_token = tokens.get("id_token")
        if (
            not isinstance(access_token, str)
            or not access_token
            or not isinstance(id_token, str)
            or not id_token
            or str(tokens.get("token_type", "")).lower() != "bearer"
        ):
            raise OIDCError("The token response must contain an ID token and a Bearer access token")
        claims = self._verify_id_token(id_token, nonce, access_token)
        profile = self._json(
            "GET", self.metadata["userinfo_endpoint"], headers={"Authorization": f"Bearer {access_token}"}
        )
        if profile.get("sub") != claims["sub"]:
            raise OIDCError("UserInfo and the ID token have different subjects")
        email = profile.get("email")
        if not isinstance(email, str) or not email.strip():
            raise OIDCUnverifiedEmail("A verified email address is required")
        # Some Casdoor applications expose verification only in the signed ID
        # token. Never use it to attest a different email returned by UserInfo.
        if "email_verified" in profile:
            verified = profile["email_verified"] is True
        else:
            verified = claims.get("email_verified") is True and claims.get("email") == email
        if not verified:
            raise OIDCUnverifiedEmail("The provider did not verify the user's email address")
        return tokens, profile
