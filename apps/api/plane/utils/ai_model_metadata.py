# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""Offline capability lookup using the same Models.dev dataset as OpenCode.

Matching is case-sensitive. Prefer the endpoint's provider, then an explicit
Models.dev provider/model namespace, then exact IDs from native publishers,
then exact IDs whose metadata agrees across providers. One gateway namespace
may wrap an explicit provider/model ID (gateway/anthropic/claude-...). We never
strip arbitrary suffixes, dates, revisions, punctuation, or model variants.
"""

import json
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

REGISTRY_PATH = Path(__file__).with_name("data") / "models_dev.json"
MAX_REGISTRY_BYTES = 2 * 1024 * 1024
FIELDS = ("vision", "tools", "reasoning", "context_window")
# These providers rely on SDK defaults and omit `api` in Models.dev.
NATIVE_ORIGINS = {
    "openai": "https://api.openai.com",
    "anthropic": "https://api.anthropic.com",
    "google": "https://generativelanguage.googleapis.com",
    "mistral": "https://api.mistral.ai",
    "xai": "https://api.x.ai",
    "deepseek": "https://api.deepseek.com",
    "cohere": "https://api.cohere.com",
}


def _origin(url):
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            return None
        return parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)
    except (TypeError, ValueError, AttributeError):
        return None


def _valid_values(values):
    return (
        isinstance(values, list)
        and len(values) == len(FIELDS) + 1
        and isinstance(values[4], str)
        and all(value is None or isinstance(value, bool) for value in values[:3])
        and (values[3] is None or (type(values[3]) is int and values[3] > 0))
    )


@lru_cache(maxsize=1)
def _registry():
    # Bounded local read only. Corrupt/missing data must not break discovery.
    try:
        with REGISTRY_PATH.open("rb") as source:
            raw = source.read(MAX_REGISTRY_BYTES + 1)
        if len(raw) > MAX_REGISTRY_BYTES:
            return {}
        payload = json.loads(raw)
        providers = payload["providers"]
        if not isinstance(providers, dict):
            return {}
        for key, provider in providers.items():
            if (
                not isinstance(key, str)
                or not isinstance(provider, dict)
                or not isinstance(provider.get("models"), dict)
            ):
                return {}
            if any(not isinstance(mid, str) or not _valid_values(values) for mid, values in provider["models"].items()):
                return {}
        return providers
    except (OSError, ValueError, KeyError, TypeError, RecursionError):
        return {}


def _consensus(candidates, model_id, include_name):
    """Conflicting capabilities are unknown; display-name differences use the ID."""
    if candidates and all(candidate[:4] == candidates[0][:4] for candidate in candidates):
        result = dict(zip(FIELDS, candidates[0]))
        if include_name:
            names = {candidate[4] for candidate in candidates if len(candidate) > 4}
            result["name"] = next(iter(names)) if len(names) == 1 else model_id
        return result
    return None


def registry_metadata(model_id, base_url, *, include_name=False):
    providers = _registry()
    origin = _origin(base_url)
    native = []
    if origin:
        for provider_id, provider in providers.items():
            if origin == _origin(provider.get("api") or NATIVE_ORIGINS.get(provider_id)):
                models = provider["models"]
                value = models.get(model_id)
                if value is None and model_id.startswith(provider_id + "/"):
                    value = models.get(model_id[len(provider_id) + 1 :])
                if value is not None:
                    native.append(value)
    if native:
        return _consensus(native, model_id, include_name)

    # Explicit provider namespace, optionally wrapped in one custom gateway ID.
    parts = model_id.split("/")
    qualified = [parts]
    if len(parts) >= 3 and parts[0] not in providers:
        qualified.append(parts[1:])
    for pieces in qualified:
        if len(pieces) >= 2 and pieces[0] in providers:
            value = providers[pieces[0]]["models"].get("/".join(pieces[1:]))
            if value is not None:
                return _consensus([value], model_id, include_name)

    # Bare IDs from the originating vendors are authoritative on custom gateways;
    # `openai` as a transport argument is deliberately never used as a vendor hint.
    published = [
        provider["models"][model_id]
        for key, provider in providers.items()
        if key in NATIVE_ORIGINS and model_id in provider["models"]
    ]
    if published:
        return _consensus(published, model_id, include_name)
    return _consensus(
        [provider["models"][model_id] for provider in providers.values() if model_id in provider["models"]],
        model_id,
        include_name,
    )
