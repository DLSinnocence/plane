# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import json
from unittest.mock import Mock

import httpx
import pytest

from plane.utils import ai_model_metadata, ai_models

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    "model_id",
    [
        "gpt-4o",
        "gpt-4.1",
        "openai/gpt-4o",
        "anthropic/claude-sonnet-4-5",
        "google/gemini-2.5-pro",
        "claude-sonnet-4-5",
        "gemini-2.5-pro",
        "gateway/anthropic/claude-sonnet-4-5",
        "gateway/google/gemini-2.5-pro",
    ],
)
def test_known_models_on_custom_openai_gateway_without_metadata_network(monkeypatch, model_id):
    requests = []

    def handler(request):
        requests.append(request)
        assert str(request.url) == "https://private.gateway/v1/models"
        assert request.headers["authorization"] == "Bearer private-secret"
        return httpx.Response(200, json={"data": [{"id": model_id}]})

    real_client = httpx.Client
    monkeypatch.setattr(
        ai_models.httpx, "Client", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw)
    )
    entry = ai_models.discover_models("openai", "https://private.gateway/v1", "private-secret")["models"][0]
    assert entry["id"] == model_id
    assert entry["name"] == model_id
    assert entry["vision"] is True
    assert entry["tools"] is True
    assert isinstance(entry["reasoning"], bool)
    assert entry["context_window"] > 0
    assert entry["metadata_source"] == "models.dev"
    assert len(requests) == 1  # No metadata host ever receives a request or secret.


@pytest.mark.parametrize(
    "model_id", ["gpt-4o-fictional", "GPT-4o", "private/gpt-4o", "gpt-4o:thinking", "not-claude-sonnet-4-5"]
)
def test_unknown_variants_are_not_guessed(model_id):
    result = ai_models.enriched_metadata({"id": model_id}, "https://gateway.test")
    assert result == {
        "vision": None,
        "tools": None,
        "reasoning": None,
        "context_window": None,
        "metadata_source": "custom",
    }


def test_registry_precedes_conflicting_upstream_metadata():
    result = ai_models.enriched_metadata(
        {"id": "gpt-4o", "capabilities": {"vision": False, "tools": False}, "reasoning": True, "context_window": 1},
        "https://gateway.test",
    )
    assert result == {
        "vision": True,
        "tools": True,
        "reasoning": False,
        "context_window": 128000,
        "metadata_source": "models.dev",
    }


def test_explicit_provider_fallback():
    result = ai_models.enriched_metadata(
        {
            "id": "our-custom-model",
            "modalities": {"input": ["text", "image"]},
            "tool_call": False,
            "reasoning": True,
            "limit": {"context": 8192},
        },
        "https://gateway.test",
    )
    assert result == {
        "vision": True,
        "tools": False,
        "reasoning": True,
        "context_window": 8192,
        "metadata_source": "provider",
    }


def test_invalid_upstream_values_do_not_claim_capabilities():
    result = ai_models.enriched_metadata(
        {"id": "our-custom-model", "vision": "true", "tool_call": 1, "reasoning": "false", "context_window": True},
        "https://gateway.test",
    )
    assert result["metadata_source"] == "custom"
    assert all(result[key] is None for key in ai_model_metadata.FIELDS)


def fake_registry(monkeypatch):
    registry = {
        "openai": {"api": None, "models": {"shared": [True, True, False, 100]}},
        "anthropic": {"api": None, "models": {"shared": [False, True, True, 200]}},
        "gateway": {"api": "https://native.test/v1", "models": {"shared": [False, False, False, 300]}},
        "other": {"api": "https://other.test", "models": {"alias": [True, True, None, None]}},
        "another": {"api": None, "models": {"alias": [True, True, None, None]}},
    }
    monkeypatch.setattr(ai_model_metadata, "_registry", lambda: registry)
    return registry


def test_native_endpoint_precedes_other_registry_aliases(monkeypatch):
    fake_registry(monkeypatch)
    result = ai_model_metadata.registry_metadata("shared", "https://native.test:443/custom/v1")
    assert result == {"vision": False, "tools": False, "reasoning": False, "context_window": 300}
    assert ai_model_metadata.registry_metadata("shared", "https://api.openai.com/v1")["context_window"] == 100
    assert ai_model_metadata.registry_metadata("shared", "https://api.anthropic.com")["context_window"] == 200


def test_conflicting_bare_aliases_are_unknown_but_namespaces_resolve(monkeypatch):
    fake_registry(monkeypatch)
    assert ai_model_metadata.registry_metadata("shared", "https://custom.test") is None
    assert ai_model_metadata.registry_metadata("openai/shared", "https://custom.test")["context_window"] == 100
    assert ai_model_metadata.registry_metadata("anthropic/shared", "https://custom.test")["context_window"] == 200
    assert ai_model_metadata.registry_metadata("alias", "https://custom.test")["vision"] is True


@pytest.mark.parametrize(
    "base",
    [
        "https://api.openai.com.evil.test",
        "http://api.openai.com",
        "https://api.openai.com:8443",
        "https://api.openai.com@evil.test",
    ],
)
def test_origin_matching_does_not_trust_lookalikes(monkeypatch, base):
    fake_registry(monkeypatch)
    assert ai_model_metadata.registry_metadata("shared", base) is None


def test_missing_registry_fields_can_use_upstream_evidence(monkeypatch):
    fake_registry(monkeypatch)
    result = ai_models.enriched_metadata(
        {"id": "alias", "reasoning": True, "context_window": 42}, "https://custom.test"
    )
    assert result == {
        "vision": True,
        "tools": True,
        "reasoning": True,
        "context_window": 42,
        "metadata_source": "models.dev",
    }


@pytest.mark.parametrize(
    "content", [None, "bad json", "[]", '{"providers": []}', '{"providers":{"bad":{"models":{"id":[1,2,3,4]}}}}']
)
def test_missing_or_corrupt_registry_falls_back_offline(monkeypatch, tmp_path, content):
    path = tmp_path / "registry.json"
    if content is not None:
        path.write_text(content)
    monkeypatch.setattr(ai_model_metadata, "REGISTRY_PATH", path)
    ai_model_metadata._registry.cache_clear()
    try:
        result = ai_models.enriched_metadata({"id": "gpt-4o", "capabilities": {"tools": True}}, "https://gateway.test")
        assert result["metadata_source"] == "provider"
        assert result["vision"] is None
        assert result["tools"] is True
    finally:
        ai_model_metadata._registry.cache_clear()


def test_registry_read_is_bounded(monkeypatch):
    source = Mock()
    source.open.return_value.__enter__ = Mock(return_value=source)
    source.open.return_value.__exit__ = Mock(return_value=False)
    source.read.return_value = b"x" * (ai_model_metadata.MAX_REGISTRY_BYTES + 1)
    monkeypatch.setattr(ai_model_metadata, "REGISTRY_PATH", source)
    ai_model_metadata._registry.cache_clear()
    try:
        assert ai_model_metadata._registry() == {}
        source.read.assert_called_once_with(ai_model_metadata.MAX_REGISTRY_BYTES + 1)
    finally:
        ai_model_metadata._registry.cache_clear()


def test_snapshot_schema_and_size():
    raw = ai_model_metadata.REGISTRY_PATH.read_bytes()
    snapshot = json.loads(raw)
    assert len(raw) <= ai_model_metadata.MAX_REGISTRY_BYTES
    assert snapshot["source"] == "https://models.dev/api.json"
    assert snapshot["fields"] == [*ai_model_metadata.FIELDS, "name"]
    assert len(snapshot["source_sha256"]) == 64
    assert ai_model_metadata._registry()
    assert "env" not in snapshot["providers"]["openai"]


def test_saved_selection_lookup_is_offline_and_returns_registry_name(monkeypatch):
    network = Mock(side_effect=AssertionError("Saved model lookup must not use HTTP"))
    monkeypatch.setattr(ai_models.httpx, "Client", network)
    assert ai_models.lookup_model_metadata("openai", "https://private.gateway/v1", "openai/gpt-4o") == {
        "name": "GPT-4o",
        "vision": True,
        "tools": True,
        "reasoning": False,
        "context_window": 128000,
        "metadata_source": "models.dev",
    }
    network.assert_not_called()


@pytest.mark.parametrize("model_id", [None, "", "unknown-custom-model", "gpt-4o:fiction", 42, "x" * 201])
def test_saved_selection_unknown_or_unset_returns_none(model_id):
    assert ai_models.lookup_model_metadata("openai", "https://gateway.test", model_id) is None


def test_saved_selection_protocol_does_not_override_vendor(monkeypatch):
    fake_registry(monkeypatch)
    assert ai_models.lookup_model_metadata("openai", "https://api.anthropic.com", "shared")["context_window"] == 200
    assert ai_models.lookup_model_metadata("openai", "https://custom.test", "shared") is None


def test_display_name_difference_does_not_create_capability_ambiguity(monkeypatch):
    registry = fake_registry(monkeypatch)
    registry["other"]["models"]["alias"].append("First label")
    registry["another"]["models"]["alias"].append("Second label")
    result = ai_models.lookup_model_metadata("openai", "https://custom.test", "alias")
    assert result["name"] == "alias"
    assert result["vision"] is True
    assert result["metadata_source"] == "models.dev"
