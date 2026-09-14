# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""Bounded, ephemeral discovery for user-authorized model gateways."""

import json
import time

import httpx

MAX_MODEL_PAGES = 5
MAX_MODELS = 1000
MAX_CATALOGUE_BYTES = 4 * 1024 * 1024
DISCOVERY_TIMEOUT = 20
DISCOVERY_ERROR = "Could not fetch models. Check the provider, base URL and API key, then try again."


class ModelDiscoveryError(Exception):
    pass


def model_capabilities(model):
    """Only upstream metadata is evidence; model IDs never imply capabilities."""
    vision = tools = None
    architecture = model.get("architecture")
    sources = [model]
    if isinstance(architecture, dict):
        sources.append(architecture)
    for source in sources:
        for field in ("input_modalities", "modalities"):
            modalities = source.get(field)
            if isinstance(modalities, dict):
                modalities = modalities.get("input")
            if isinstance(modalities, list) and all(isinstance(item, str) for item in modalities):
                vision = "image" in modalities
    capabilities = model.get("capabilities")
    if isinstance(capabilities, dict):
        for key in ("vision", "images", "image", "supports_images"):
            if isinstance(capabilities.get(key), bool):
                vision = capabilities[key]
                break
        for key in ("tools", "tool_calling", "function_calling"):
            if isinstance(capabilities.get(key), bool):
                tools = capabilities[key]
                break
    elif isinstance(capabilities, list) and all(isinstance(item, str) for item in capabilities):
        vision = any(item in capabilities for item in ("vision", "image", "images"))
        tools = any(item in capabilities for item in ("tools", "tool_calling", "function_calling"))
    return vision, tools


def discover_models(provider, base_url, api_key):
    base = base_url.rstrip("/")
    if provider == "anthropic" and not base.endswith("/v1"):
        base += "/v1"
    headers = (
        {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
        if provider == "anthropic"
        else {"Authorization": f"Bearer {api_key}"}
    )
    models, seen, cursors = [], set(), set()
    params = {}
    bytes_read = entries_read = 0
    deadline = time.monotonic() + DISCOVERY_TIMEOUT
    try:
        with httpx.Client(timeout=httpx.Timeout(10, connect=5), trust_env=False, follow_redirects=False) as client:
            for page in range(MAX_MODEL_PAGES):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ModelDiscoveryError()
                with client.stream(
                    "GET", base + "/models", headers=headers, params=params, timeout=min(10, remaining)
                ) as response:
                    if response.status_code != 200:
                        raise ModelDiscoveryError()
                    body = bytearray()
                    for chunk in response.iter_bytes():
                        bytes_read += len(chunk)
                        if bytes_read > MAX_CATALOGUE_BYTES or time.monotonic() >= deadline:
                            raise ModelDiscoveryError()
                        body.extend(chunk)
                payload = json.loads(body)
                if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
                    raise ModelDiscoveryError()
                entries = payload["data"]
                if not entries:
                    raise ModelDiscoveryError()
                for index, item in enumerate(entries):
                    if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"].strip():
                        raise ModelDiscoveryError()
                    model_id = item["id"]
                    if len(model_id) > 200:
                        raise ModelDiscoveryError()
                    name = item.get("display_name") or item.get("name") or model_id
                    if not isinstance(name, str) or len(name) > 1000:
                        raise ModelDiscoveryError()
                    if model_id not in seen:
                        vision, tools = model_capabilities(item)
                        models.append({"id": model_id, "name": name, "vision": vision, "tools": tools})
                        seen.add(model_id)
                    entries_read += 1
                    if entries_read >= MAX_MODELS:
                        return {
                            "models": models,
                            "truncated": index < len(entries) - 1 or payload.get("has_more") is True,
                        }
                has_more = payload.get("has_more", False)
                if not isinstance(has_more, bool):
                    raise ModelDiscoveryError()
                if not has_more:
                    return {"models": models, "truncated": False}
                cursor = payload.get("last_id")
                if not isinstance(cursor, str) or not cursor or len(cursor) > 200 or cursor in cursors:
                    raise ModelDiscoveryError()
                cursors.add(cursor)
                params = {"after_id" if provider == "anthropic" else "after": cursor}
            return {"models": models, "truncated": True}
    except (httpx.HTTPError, httpx.InvalidURL, ValueError, TypeError, UnicodeError, RecursionError):
        raise ModelDiscoveryError() from None
