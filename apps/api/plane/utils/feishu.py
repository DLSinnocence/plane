# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""Restricted Feishu transport. Provider bodies and credentials never enter errors."""

import json
import re
import uuid
from urllib.parse import quote, urlsplit

import requests
from cryptography.fernet import Fernet
from django.conf import settings

from plane.license.utils.encryption import derive_key
from plane.utils.phone import normalize_phone_number

TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id"
CONTACT_URL = "https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id"
TOKEN_EXPIRED_CODES = {99991661, 99991663, 99991664, 99991668}
TRANSIENT_CODES = {99991400, 99991401, 99991402, 99991403}


class FeishuError(Exception):
    def __init__(self, reason, retryable=False, token_expired=False):
        self.reason = reason
        self.retryable = retryable
        self.token_expired = token_expired
        super().__init__(reason)


def configured_app_url():
    """Use server configuration only; never trust request Host or Origin."""
    base = getattr(settings, "APP_BASE_URL", "") or getattr(settings, "WEB_URL", "") or ""
    try:
        if not isinstance(base, str) or any(character.isspace() or ord(character) < 32 for character in base):
            raise ValueError
        parsed = urlsplit(base)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or "\\" in base
        ):
            raise ValueError
        parsed.port  # Reject invalid or out-of-range ports.
        return base.rstrip("/")
    except (ValueError, TypeError):
        raise FeishuError("invalid_application_url") from None


def encrypt_secret(secret):
    # Reuse Plane's key derivation without its fail-open/logging wrappers.
    try:
        if not secret:
            raise ValueError
        result = Fernet(derive_key(settings.SECRET_KEY)).encrypt(secret.encode()).decode()
        if not result:
            raise ValueError
        return result
    except Exception:
        raise FeishuError("secret_encryption_failed") from None


def decrypt_secret(ciphertext):
    try:
        if not ciphertext:
            raise ValueError
        result = Fernet(derive_key(settings.SECRET_KEY)).decrypt(ciphertext.encode()).decode()
        if not result:
            raise ValueError
        return result
    except Exception:
        raise FeishuError("secret_decryption_failed") from None


def valid_open_id(value):
    return isinstance(value, str) and bool(re.fullmatch(r"ou_[A-Za-z0-9_-]{1,252}", value))


class FeishuClient:
    def __init__(self, app_id, app_secret):
        self.app_id = app_id
        self.app_secret = app_secret
        self._access_token = None
        self._display_names = {}
        self._resolved_mobiles = {}

    def _post(self, url, **kwargs):
        if url not in {TOKEN_URL, MESSAGE_URL, CONTACT_URL}:
            raise FeishuError("invalid_provider_response")
        try:
            response = requests.post(url, timeout=(3.05, 10), allow_redirects=False, **kwargs)
        except requests.RequestException:
            raise FeishuError("network_error", retryable=True) from None
        return self._response_data(response)

    @staticmethod
    def _response_data(response):
        if response.status_code == 429 or 500 <= response.status_code < 600:
            raise FeishuError("provider_unavailable", retryable=True)
        if not 200 <= response.status_code < 300:
            raise FeishuError("provider_http_error", token_expired=response.status_code == 401)
        try:
            data = response.json()
        except (ValueError, TypeError):
            raise FeishuError("invalid_provider_response") from None
        if not isinstance(data, dict) or type(data.get("code")) is not int:
            raise FeishuError("invalid_provider_response")
        code = data["code"]
        if code != 0:
            raise FeishuError(
                "provider_rejected", retryable=code in TRANSIENT_CODES, token_expired=code in TOKEN_EXPIRED_CODES
            )
        return data

    def _token(self):
        data = self._post(TOKEN_URL, json={"app_id": self.app_id, "app_secret": self.app_secret})
        token = data.get("tenant_access_token")
        if not isinstance(token, str) or not token:
            raise FeishuError("invalid_provider_response")
        return token

    def _authorized_post(self, url, payload):
        if not self._access_token:
            self._access_token = self._token()
        for refresh in range(2):
            try:
                return self._post(url, headers={"Authorization": f"Bearer {self._access_token}"}, json=payload)
            except FeishuError as exc:
                if exc.token_expired and refresh == 0:
                    self._access_token = self._token()
                    continue
                raise

    def _get_user(self, open_id):
        if not valid_open_id(open_id):
            raise FeishuError("invalid_provider_response")
        url = f"https://open.feishu.cn/open-apis/contact/v3/users/{quote(open_id, safe='')}?user_id_type=open_id"
        try:
            response = requests.get(
                url,
                headers={
                    "Authorization": f"Bearer {self._access_token}",
                    "Content-Type": "application/json; charset=utf-8",
                },
                timeout=(3.05, 10),
                allow_redirects=False,
            )
        except requests.RequestException:
            raise FeishuError("network_error", retryable=True) from None
        return self._response_data(response)

    def get_display_name(self, open_id) -> str:
        """Return the official Feishu nickname, name, or English name for an open ID.

        Cache successful lookups only for this client instance. Missing contact
        permissions or unavailable names raise a sanitized FeishuError.
        """
        if not valid_open_id(open_id):
            raise FeishuError("invalid_provider_response")
        if open_id in self._display_names:
            return self._display_names[open_id]
        if not self._access_token:
            self._access_token = self._token()
        for refresh in range(2):
            try:
                data = self._get_user(open_id)
                break
            except FeishuError as exc:
                if exc.token_expired and refresh == 0:
                    self._access_token = self._token()
                    continue
                raise
        body = data.get("data")
        user = body.get("user") if isinstance(body, dict) else None
        if not isinstance(user, dict):
            raise FeishuError("user_name_unavailable")
        if "open_id" in user and user["open_id"] != open_id:
            raise FeishuError("invalid_provider_response")
        for field in ("nickname", "name", "en_name"):
            value = user.get(field)
            if isinstance(value, str) and value.strip():
                self._display_names[open_id] = value.strip()
                return self._display_names[open_id]
        raise FeishuError("user_name_unavailable")

    def resolve_mobile(self, mobile):
        normalized = normalize_phone_number(mobile)
        if not mobile:
            raise FeishuError("phone_missing")
        if not normalized or normalized != mobile:
            raise FeishuError("phone_invalid")
        if normalized in self._resolved_mobiles:
            return self._resolved_mobiles[normalized]
        data = self._authorized_post(CONTACT_URL, {"mobiles": [normalized], "include_resigned": False})
        body = data.get("data")
        if not isinstance(body, dict) or not isinstance(body.get("user_list"), list):
            raise FeishuError("invalid_provider_response")
        candidates = []
        mismatched = False
        for user in body["user_list"]:
            if not isinstance(user, dict):
                raise FeishuError("invalid_provider_response")
            if "mobile" in user and normalize_phone_number(user["mobile"]) != normalized:
                mismatched = True
                continue
            candidates.append(user)
        if not candidates:
            raise FeishuError("phone_conflict" if mismatched else "phone_not_found")
        open_ids = set()
        for user in candidates:
            status = user.get("status", {})
            if not isinstance(status, dict):
                raise FeishuError("invalid_provider_response")
            for flag in ("is_frozen", "is_resigned", "is_exited", "is_unjoin", "is_activated"):
                if flag in status and type(status[flag]) is not bool:
                    raise FeishuError("invalid_provider_response")
            if (
                any(status.get(flag, False) for flag in ("is_frozen", "is_resigned", "is_exited", "is_unjoin"))
                or status.get("is_activated") is False
            ):
                raise FeishuError("phone_inactive")
            open_id = user.get("user_id")
            if not open_id:
                continue
            if not valid_open_id(open_id):
                raise FeishuError("invalid_provider_response")
            open_ids.add(open_id)
        if len(open_ids) > 1:
            raise FeishuError("phone_ambiguous")
        if not open_ids:
            raise FeishuError("phone_not_found")
        open_id = open_ids.pop()
        self._resolved_mobiles[normalized] = open_id
        return open_id

    def send_card(self, open_id, card, message_id):
        if not valid_open_id(open_id):
            raise FeishuError("invalid_provider_response")
        payload = {
            "receive_id": open_id,
            "msg_type": "interactive",
            "content": json.dumps(card, ensure_ascii=False),
            "uuid": str(uuid.UUID(str(message_id))),
        }
        self._authorized_post(MESSAGE_URL, payload)
