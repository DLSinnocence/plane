# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import base64
import hashlib
import json
import time
from urllib.parse import parse_qs, urlsplit
from unittest.mock import MagicMock

import jwt
import pytest
import requests
from cryptography.hazmat.primitives.asymmetric import rsa

from plane.authentication.provider.oauth.oidc import MeowAliveOIDCClient, OIDCError, OIDCUnverifiedEmail

pytestmark = pytest.mark.unit
ISSUER = "https://sso.meowalive.com"
CALLBACK = "https://task.meowalive.com/auth/meowalive/callback/"


@pytest.fixture(scope="module")
def signing_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def oidc(monkeypatch, signing_key):
    metadata = {
        "issuer": ISSUER,
        "authorization_endpoint": f"{ISSUER}/login/oauth/authorize",
        "token_endpoint": f"{ISSUER}/api/login/oauth/access_token",
        "userinfo_endpoint": f"{ISSUER}/api/userinfo",
        "jwks_uri": f"{ISSUER}/.well-known/jwks",
        "response_types_supported": ["code"],
        "id_token_signing_alg_values_supported": ["RS256"],
        "token_endpoint_auth_methods_supported": ["client_secret_post"],
    }
    claims = {
        "iss": ISSUER,
        "sub": "casdoor-user-id",
        "aud": "plane-client",
        "iat": int(time.time()),
        "exp": int(time.time()) + 300,
        "nonce": "login-nonce",
        "email": "person@example.com",
        "email_verified": True,
    }
    public_key = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(signing_key.public_key()))
    public_key.update(kid="casdoor-signing-key", alg="RS256", use="sig")
    tokens = {"access_token": "access-token", "token_type": "Bearer", "expires_in": 300}
    profile = {"sub": claims["sub"], "email": claims["email"], "email_verified": True, "name": "Test User"}
    payloads = {
        f"{ISSUER}/.well-known/openid-configuration": metadata,
        metadata["jwks_uri"]: {"keys": [public_key]},
        metadata["token_endpoint"]: tokens,
        metadata["userinfo_endpoint"]: profile,
    }

    def send(method, url, **kwargs):
        if url == metadata["token_endpoint"]:
            tokens.setdefault(
                "id_token", jwt.encode(claims, signing_key, algorithm="RS256", headers={"kid": public_key["kid"]})
            )
        response = MagicMock()
        response.__enter__.return_value = response
        response.status_code = 200
        response.json.return_value = payloads[url]
        return response

    http = MagicMock(side_effect=send)
    monkeypatch.setattr("plane.authentication.provider.oauth.oidc.requests.request", http)
    return metadata, claims, tokens, profile, payloads, http


def client():
    return MeowAliveOIDCClient(ISSUER, "plane-client", "test-client-secret")


def authenticate(instance):
    return instance.authenticate(
        code="authorization-code", nonce="login-nonce", code_verifier="v" * 64, redirect_uri=CALLBACK
    )


def test_authorization_uses_code_nonce_and_pkce_without_secret(oidc):
    instance = client()
    url = instance.authorization_url(
        state="session-state", nonce="login-nonce", code_verifier="v" * 64, redirect_uri=CALLBACK
    )
    params = parse_qs(urlsplit(url).query)
    assert params["response_type"] == ["code"]
    assert params["scope"] == ["openid profile email phone"]
    assert params["state"] == ["session-state"]
    assert params["nonce"] == ["login-nonce"]
    assert params["redirect_uri"] == [CALLBACK]
    expected = base64.urlsafe_b64encode(hashlib.sha256(b"v" * 64).digest()).rstrip(b"=").decode()
    assert params["code_challenge"] == [expected]
    assert params["code_challenge_method"] == ["S256"]
    assert "client_secret" not in params


def test_authentication_verifies_real_signature_and_verified_profile(oidc):
    *_, http = oidc
    tokens, profile = authenticate(client())
    assert tokens["access_token"] == "access-token"
    assert profile["sub"] == "casdoor-user-id"
    assert profile["email"] == "person@example.com"
    for call in http.call_args_list:
        assert call.kwargs["allow_redirects"] is False
        assert call.kwargs["timeout"] == (5, 15)
        assert call.kwargs.get("verify", True) is True
    token_call = next(call for call in http.call_args_list if call.args[0] == "POST")
    assert token_call.kwargs["data"]["code_verifier"] == "v" * 64
    assert token_call.kwargs["data"]["redirect_uri"] == CALLBACK
    assert token_call.kwargs["data"]["client_secret"] == "test-client-secret"


@pytest.mark.parametrize(
    "phone_claims",
    [
        {"phone_number": "+8613800138000", "phone_number_verified": True},
        {"phone": "13800138000", "phoneCountryCode": "CN", "phoneVerified": True},
        {"phone_number": "+8613800138000", "phone_number_verified": False},
    ],
)
def test_phone_fallback_uses_verified_signed_claims_only(oidc, phone_claims):
    oidc[1].update(phone_claims, given_name="Token-only name", picture="https://example.com/token-avatar")
    profile = authenticate(client())[1]
    for key, value in phone_claims.items():
        assert profile[key] == value
    assert "given_name" not in profile
    assert "picture" not in profile


@pytest.mark.parametrize("value", ["", None, "malformed", "+14155552671"])
@pytest.mark.parametrize("key", ["phone_number", "phone"])
def test_present_userinfo_phone_prevents_all_token_phone_fallback(oidc, key, value):
    oidc[1].update(phone_number="+8613800138000", phone_number_verified=True, phone="13800138000")
    oidc[3][key] = value
    profile = authenticate(client())[1]
    assert profile[key] == value
    assert "phone_number_verified" not in profile
    assert ("phone" if key == "phone_number" else "phone_number") not in profile


@pytest.mark.parametrize("key", ["phone_number_verified", "phoneVerified"])
def test_userinfo_verification_denial_survives_phone_fallback(oidc, key):
    oidc[3][key] = False
    oidc[1].update(phone_number="+8613800138000", phone_number_verified=True, phoneVerified=True)
    profile = authenticate(client())[1]
    assert profile[key] is False


@pytest.mark.parametrize("key", ["phone_number_verified", "phoneVerified"])
def test_signed_phone_verification_denial_survives_userinfo_flag(oidc, key):
    oidc[3][key] = True
    oidc[1].update(phone_number="+8613800138000")
    oidc[1][key] = False
    assert authenticate(client())[1][key] is False


@pytest.mark.parametrize("failure", ["unsigned", "subject"])
def test_token_phone_claims_do_not_bypass_identity_verification(oidc, failure):
    oidc[1].update(phone_number="+8613800138000", phone_number_verified=True)
    if failure == "unsigned":
        oidc[2]["id_token"] = jwt.encode(oidc[1], key=None, algorithm="none")
    else:
        oidc[3]["sub"] = "another-user"
    with pytest.raises(OIDCError):
        authenticate(client())


def test_no_phone_claims_remain_absent(oidc):
    profile = authenticate(client())[1]
    assert "phone" not in profile
    assert "phone_number" not in profile


def test_basic_client_authentication_when_discovery_omits_methods(oidc):
    metadata, *_, http = oidc
    metadata.pop("token_endpoint_auth_methods_supported")
    authenticate(client())
    call = next(call for call in http.call_args_list if call.args[0] == "POST")
    assert call.kwargs["auth"] == ("plane-client", "test-client-secret")
    assert "client_secret" not in call.kwargs["data"]


@pytest.mark.parametrize(
    "claim,value",
    [
        ("iss", "https://other.example.com"),
        ("aud", "another-client"),
        ("exp", 1),
        ("iat", 9999999999),
        ("nonce", "different-login"),
        ("sub", ""),
        ("azp", "another-client"),
        ("at_hash", "wrong-token-hash"),
    ],
)
def test_rejects_invalid_signed_identity_claims(oidc, claim, value):
    oidc[1][claim] = value
    with pytest.raises(OIDCError):
        authenticate(client())


@pytest.mark.parametrize("claim", ["iss", "aud", "exp", "iat", "sub", "nonce"])
def test_rejects_missing_required_claims(oidc, claim):
    oidc[1].pop(claim)
    with pytest.raises(OIDCError):
        authenticate(client())


def test_rejects_unsigned_token(oidc):
    oidc[2]["id_token"] = jwt.encode(oidc[1], key=None, algorithm="none")
    with pytest.raises(OIDCError):
        authenticate(client())


def test_rejects_a_forged_signature(oidc):
    attacker_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    oidc[2]["id_token"] = jwt.encode(oidc[1], attacker_key, algorithm="RS256", headers={"kid": "casdoor-signing-key"})
    with pytest.raises(OIDCError):
        authenticate(client())


def test_rejects_userinfo_for_another_subject(oidc):
    oidc[3]["sub"] = "another-user"
    with pytest.raises(OIDCError):
        authenticate(client())


@pytest.mark.parametrize("verification", [None, False, "true", 1])
def test_rejects_unverified_email_in_both_sources(oidc, verification):
    oidc[1]["email_verified"] = verification
    oidc[3]["email_verified"] = verification
    with pytest.raises(OIDCUnverifiedEmail):
        authenticate(client())


def test_explicitly_unverified_userinfo_is_not_overridden_by_signed_claims(oidc):
    oidc[3]["email_verified"] = False
    with pytest.raises(OIDCUnverifiedEmail):
        authenticate(client())


def test_accepts_verified_email_from_signed_id_token(oidc):
    oidc[3].pop("email_verified")
    assert authenticate(client())[1]["email"] == "person@example.com"


def test_signed_verification_cannot_attest_another_userinfo_email(oidc):
    oidc[3].pop("email_verified")
    oidc[3]["email"] = "victim@example.com"
    with pytest.raises(OIDCUnverifiedEmail):
        authenticate(client())


@pytest.mark.parametrize("key", ["authorization_endpoint", "token_endpoint", "userinfo_endpoint", "jwks_uri"])
def test_rejects_cross_origin_discovery_endpoints(oidc, key):
    oidc[0][key] = "https://attacker.example.com/collect"
    with pytest.raises(OIDCError):
        client()
    assert oidc[-1].call_count == 1


def test_rejects_mismatched_discovery_issuer(oidc):
    oidc[0]["issuer"] = "https://other.example.com"
    with pytest.raises(OIDCError):
        client()


@pytest.mark.parametrize(
    "issuer",
    [
        "http://sso.meowalive.com",
        "https://user:pass@sso.meowalive.com",
        "https://sso.meowalive.com?tenant=x",
        "https://sso.meowalive.com#fragment",
        "https://sso.meowalive.com?",
        "https://sso.meowalive.com#",
        "https://@sso.meowalive.com",
        "https:///sso.meowalive.com",
        "https://sso.meowalive.com\n",
    ],
)
def test_rejects_unsafe_issuer_before_network_access(oidc, issuer):
    with pytest.raises(OIDCError):
        MeowAliveOIDCClient(issuer, "client", "secret")
    oidc[-1].assert_not_called()


def test_network_failure_is_a_provider_error(oidc):
    oidc[-1].side_effect = requests.exceptions.SSLError("certificate verification failed")
    with pytest.raises(OIDCError):
        client()


def test_redirect_is_not_followed_even_if_it_returns_json(oidc):
    response = MagicMock()
    response.__enter__.return_value = response
    response.status_code = 302
    response.json.return_value = oidc[0]
    oidc[-1].side_effect = None
    oidc[-1].return_value = response
    with pytest.raises(OIDCError):
        client()
    response.json.assert_not_called()
