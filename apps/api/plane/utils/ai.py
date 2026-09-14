# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from urllib.parse import urlsplit

from cryptography.fernet import Fernet
from django.conf import settings
from rest_framework.exceptions import AuthenticationFailed, ValidationError

from plane.license.utils.encryption import derive_key

AGENT_TOKEN_LABEL = "Plane AI (temporary)"
DEFAULT_AI_SETTINGS = {
    "provider": "openai",
    "base_url": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "has_api_key": False,
    "supports_images": False,
}


def validate_model_url(value):
    """Normalize a user-selected gateway, including local and enterprise origins."""
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValidationError("Enter a valid model API base URL.")
    value = value.strip().rstrip("/")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise ValidationError("Enter a valid model API base URL.")
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or "?" in value
        or "#" in value
        or "\\" in value
        or any(ord(char) < 33 for char in value)
    ):
        raise ValidationError("Enter an HTTP(S) base URL without credentials, query parameters or fragments.")
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    default_port = 443 if parsed.scheme == "https" else 80
    origin = f"{parsed.scheme}://{host}" + (f":{port}" if port and port != default_port else "")
    return origin + parsed.path.rstrip("/")


def encrypt_model_key(value):
    # Unlike the legacy instance encryption helper, fail closed on errors.
    return Fernet(derive_key(settings.SECRET_KEY)).encrypt(value.encode()).decode()


def decrypt_model_key(value):
    return Fernet(derive_key(settings.SECRET_KEY)).decrypt(value.encode()).decode()


def enforce_agent_token_scope(api_token, request):
    """Temporary MCP credentials cannot escape the workspace of the chat."""
    if not api_token.is_service or api_token.label != AGENT_TOKEN_LABEL:
        return
    slug = (getattr(request, "parser_context", None) or {}).get("kwargs", {}).get("slug")
    # The MCP server also calls this identity endpoint during authentication.
    if request.path.rstrip("/") == "/api/v1/users/me":
        return
    if not api_token.workspace_id or slug != api_token.workspace.slug:
        raise AuthenticationFailed("This temporary token is restricted to its AI workspace.")
