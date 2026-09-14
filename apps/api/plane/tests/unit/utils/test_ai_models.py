# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import base64
from unittest.mock import Mock

import httpx
import pytest
from rest_framework.test import APIRequestFactory, force_authenticate

from plane.app.serializers.ai import AIModelsInputSerializer, AgentChatInputSerializer, MAX_IMAGE_BYTES
from plane.app.views.ai import PersonalAIModelsEndpoint
from plane.db.models import User
from plane.utils import ai_models

pytestmark = pytest.mark.unit


def mock_gateway(monkeypatch, handler):
    real_client = httpx.Client
    factory = Mock(side_effect=lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    monkeypatch.setattr(ai_models.httpx, "Client", factory)
    return factory


@pytest.mark.parametrize(
    "provider,base,expected",
    [
        ("openai", "http://localhost:1234/v1", "http://localhost:1234/v1/models"),
        ("anthropic", "https://gateway.internal", "https://gateway.internal/v1/models"),
        ("anthropic", "https://gateway.internal/v1", "https://gateway.internal/v1/models"),
    ],
)
def test_discovery_protocol_and_plain_unknown_models(monkeypatch, provider, base, expected):
    def handler(request):
        assert str(request.url) == expected
        if provider == "openai":
            assert request.headers["authorization"] == "Bearer secret"
            assert "x-api-key" not in request.headers
        else:
            assert request.headers["x-api-key"] == "secret"
            assert request.headers["anthropic-version"] == "2023-06-01"
            assert "authorization" not in request.headers
        return httpx.Response(200, json={"data": [{"id": "gpt-4o-vision-tools", "display_name": "Friendly"}]})

    factory = mock_gateway(monkeypatch, handler)
    assert ai_models.discover_models(provider, base, "secret") == {
        "models": [{"id": "gpt-4o-vision-tools", "name": "Friendly", "vision": None, "tools": None}],
        "truncated": False,
    }
    assert factory.call_args.kwargs["trust_env"] is False
    assert factory.call_args.kwargs["follow_redirects"] is False


@pytest.mark.parametrize(
    "metadata,expected",
    [
        ({"architecture": {"input_modalities": ["text", "image"]}}, (True, None)),
        ({"input_modalities": ["text"]}, (False, None)),
        ({"modalities": {"input": ["image"], "output": ["text"]}}, (True, None)),
        ({"modalities": ["text", "image"]}, (True, None)),
        ({"capabilities": {"vision": False, "function_calling": True}}, (False, True)),
        ({"capabilities": ["vision", "tools"]}, (True, True)),
        ({"capabilities": {"tools": "true"}}, (None, None)),
        ({"id": "claude-vision", "supported_parameters": ["tools"]}, (None, None)),
    ],
)
def test_capabilities_require_explicit_metadata(metadata, expected):
    assert ai_models.model_capabilities(metadata) == expected


def test_anthropic_pagination_caps_pages_and_never_follows_next_url(monkeypatch):
    calls = []

    def handler(request):
        calls.append(request)
        number = len(calls)
        assert request.url.host == "gateway.internal"
        if number > 1:
            assert request.url.params["after_id"] == str(number - 1)
        return httpx.Response(
            200,
            json={
                "data": [{"id": str(number)}],
                "has_more": True,
                "last_id": str(number),
                "next": "https://attacker.test/steal",
            },
        )

    mock_gateway(monkeypatch, handler)
    result = ai_models.discover_models("anthropic", "https://gateway.internal", "secret")
    assert len(calls) == 5
    assert len(result["models"]) == 5
    assert result["truncated"] is True


@pytest.mark.parametrize("count,truncated", [(1000, False), (1001, True)])
def test_catalogue_entry_cap(monkeypatch, count, truncated):
    mock_gateway(
        monkeypatch, lambda request: httpx.Response(200, json={"data": [{"id": str(i)} for i in range(count)]})
    )
    result = ai_models.discover_models("openai", "https://gateway.internal", "secret")
    assert len(result["models"]) == 1000
    assert result["truncated"] is truncated


@pytest.mark.parametrize(
    "payload",
    [
        None,
        {},
        {"data": []},
        {"data": [None]},
        {"data": [{"id": ""}]},
        {"data": [{"id": "ok"}], "has_more": True},
        {"data": [{"id": "ok"}], "has_more": "true"},
    ],
)
def test_malformed_catalogue_fails_safely(monkeypatch, payload):
    mock_gateway(monkeypatch, lambda request: httpx.Response(200, json=payload))
    with pytest.raises(ai_models.ModelDiscoveryError):
        ai_models.discover_models("openai", "http://localhost", "secret")


@pytest.mark.parametrize("status", [301, 302, 401, 403, 429, 500])
def test_status_errors_never_follow_redirects_or_expose_bodies(monkeypatch, status):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(status, text="secret private body", headers={"location": "https://attacker.test"})

    mock_gateway(monkeypatch, handler)
    with pytest.raises(ai_models.ModelDiscoveryError) as error:
        ai_models.discover_models("openai", "http://localhost", "secret")
    assert len(calls) == 1
    assert "secret" not in str(error.value)


@pytest.mark.parametrize("failure", [httpx.ConnectError, httpx.ReadTimeout])
def test_network_errors_are_redacted(monkeypatch, failure):
    def handler(request):
        raise failure("secret at private host")

    mock_gateway(monkeypatch, handler)
    with pytest.raises(ai_models.ModelDiscoveryError) as error:
        ai_models.discover_models("openai", "http://localhost", "secret")
    assert "secret" not in str(error.value)


def test_bounded_response_and_overall_timeout(monkeypatch):
    mock_gateway(monkeypatch, lambda request: httpx.Response(200, content=b"x" * (ai_models.MAX_CATALOGUE_BYTES + 1)))
    with pytest.raises(ai_models.ModelDiscoveryError):
        ai_models.discover_models("openai", "http://localhost", "secret")
    monkeypatch.setattr(ai_models.time, "monotonic", Mock(side_effect=[0, 21]))
    with pytest.raises(ai_models.ModelDiscoveryError):
        ai_models.discover_models("openai", "http://localhost", "secret")


@pytest.mark.parametrize(
    "provider,expected", [("openai", "https://api.openai.com/v1"), ("anthropic", "https://api.anthropic.com")]
)
def test_blank_base_defaults(provider, expected):
    serializer = AIModelsInputSerializer(data={"provider": provider, "base_url": "  "})
    assert serializer.is_valid(), serializer.errors
    assert serializer.validated_data["base_url"] == expected


@pytest.mark.parametrize(
    "url", ["https://gateway.test/\n", "\thttps://gateway.test", "https://gateway.test/#", "https://gateway.test/?"]
)
def test_discovery_rejects_ambiguous_url(url):
    serializer = AIModelsInputSerializer(data={"provider": "openai", "base_url": url})
    assert not serializer.is_valid()


def image(data=b"\x89PNG\r\n\x1a\n", mime="image/png"):
    return {"data": base64.b64encode(data).decode(), "mime_type": mime}


@pytest.mark.parametrize(
    "data,mime",
    [(b"\x89PNG\r\n\x1a\n", "image/png"), (b"\xff\xd8\xff", "image/jpeg"), (b"RIFF\x04\x00\x00\x00WEBP", "image/webp")],
)
def test_images_support_blank_user_text_and_valid_magic(data, mime):
    serializer = AgentChatInputSerializer(
        data={"messages": [{"role": "user", "content": "", "images": [image(data, mime)]}]}
    )
    assert serializer.is_valid(), serializer.errors


@pytest.mark.parametrize(
    "attachment",
    [
        image(b"bad"),
        image(mime="image/jpeg"),
        {"data": "!!!!", "mime_type": "image/png"},
        {"data": "aGVsbG8=\n", "mime_type": "image/png"},
        image(mime="image/gif"),
        image(b"\x89PNG\r\n\x1a\n" + b"x" * (MAX_IMAGE_BYTES - 7)),
    ],
)
def test_invalid_images_rejected(attachment):
    serializer = AgentChatInputSerializer(
        data={"messages": [{"role": "user", "content": "check", "images": [attachment]}]}
    )
    assert not serializer.is_valid()


def test_three_maximum_images_allowed_but_four_across_history_rejected():
    attachment = image(b"\x89PNG\r\n\x1a\n" + b"x" * (MAX_IMAGE_BYTES - 8))
    messages = [{"role": "user", "content": "", "images": [attachment]} for _ in range(3)]
    serializer = AgentChatInputSerializer(data={"messages": messages})
    assert serializer.is_valid(), serializer.errors
    serializer = AgentChatInputSerializer(data={"messages": messages + [messages[0]]})
    assert not serializer.is_valid()


@pytest.mark.parametrize("attachments", [[], [image()]])
def test_assistant_images_rejected(attachments):
    serializer = AgentChatInputSerializer(
        data={
            "messages": [
                {"role": "assistant", "content": "text", "images": attachments},
                {"role": "user", "content": "next"},
            ]
        }
    )
    assert not serializer.is_valid()


def test_discovery_endpoint_fixed_error(monkeypatch):
    monkeypatch.setattr("plane.app.views.ai.discover_models", Mock(side_effect=ai_models.ModelDiscoveryError("secret")))
    request = APIRequestFactory().post(
        "/api/users/me/ai-settings/models/", {"provider": "openai", "base_url": "", "api_key": "secret"}, format="json"
    )
    force_authenticate(request, user=User(email="test@example.com"))
    response = PersonalAIModelsEndpoint.as_view()(request)
    assert response.status_code == 502
    assert response.data == {"error": ai_models.DISCOVERY_ERROR}
    assert response["Cache-Control"] == "no-store"


def test_duplicate_entries_still_count_toward_catalogue_budget(monkeypatch):
    mock_gateway(monkeypatch, lambda request: httpx.Response(200, json={"data": [{"id": "same"}] * 1001}))
    result = ai_models.discover_models("openai", "https://gateway.internal", "secret")
    assert len(result["models"]) == 1
    assert result["truncated"] is True


def test_chat_json_parser_allows_images_but_bounds_raw_input():
    from io import BytesIO
    import json
    from rest_framework.exceptions import ParseError
    from plane.app.parsers import AIChatJSONParser

    parser = AIChatJSONParser()
    attachment = image(b"\x89PNG\r\n\x1a\n" + b"x" * (MAX_IMAGE_BYTES - 8))
    data = {"messages": [{"role": "user", "content": "x" * 16000, "images": [attachment] * 3}]}
    body = json.dumps(data).encode()
    assert len(body) > 8 * 1024 * 1024
    assert parser.parse(BytesIO(body)) == data
    stream = Mock()
    stream.read.return_value = b" " * (parser.max_body_bytes + 1)
    with pytest.raises(ParseError):
        parser.parse(stream)
    stream.read.assert_called_once_with(parser.max_body_bytes + 1)
