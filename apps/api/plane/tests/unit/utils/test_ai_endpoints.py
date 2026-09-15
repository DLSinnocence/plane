# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest

from plane.utils.ai_endpoints import resolve_model_endpoint
from plane.utils.ai_models import discover_models

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    "provider,path,protocol,base,models",
    [
        ("openai", "", "openai-completions", "/v1", "/v1/models"),
        ("openai", "/", "openai-completions", "/v1", "/v1/models"),
        ("openai", "/v1/", "openai-completions", "/v1", "/v1/models"),
        ("openai", "/api/v1", "openai-completions", "/api/v1", "/api/v1/models"),
        ("openai", "/gateway", "openai-completions", "/gateway", "/gateway/models"),
        ("openai", "/v1/chat/completions", "openai-completions", "/v1", "/v1/models"),
        ("openai", "/chat/completions/", "openai-completions", "", "/models"),
        ("openai", "/proxy/chat/completions", "openai-completions", "/proxy", "/proxy/models"),
        ("openai", "/v1/responses", "openai-responses", "/v1", "/v1/models"),
        ("openai", "/responses", "openai-responses", "", "/models"),
        ("anthropic", "/proxy/v1/responses", "openai-responses", "/proxy/v1", "/proxy/v1/models"),
        ("anthropic", "/v1/chat/completions", "openai-completions", "/v1", "/v1/models"),
        ("openai", "/models", "openai-completions", "", "/models"),
        ("openai", "/v1/models", "openai-completions", "/v1", "/v1/models"),
        ("anthropic", "", "anthropic-messages", "", "/v1/models"),
        ("anthropic", "/v1", "anthropic-messages", "", "/v1/models"),
        ("anthropic", "/v1/models", "anthropic-messages", "", "/v1/models"),
        ("anthropic", "/v1/messages/", "anthropic-messages", "", "/v1/models"),
        ("anthropic", "/proxy", "anthropic-messages", "/proxy", "/proxy/v1/models"),
        ("anthropic", "/proxy/v1", "anthropic-messages", "/proxy", "/proxy/v1/models"),
        ("anthropic", "/proxy/v1/messages", "anthropic-messages", "/proxy", "/proxy/v1/models"),
        ("openai", "/proxy/v1/messages", "anthropic-messages", "/proxy", "/proxy/v1/models"),
        # The Anthropic SDK always supplies /v1/messages, even for an unversioned full URL.
        ("anthropic", "/messages", "anthropic-messages", "", "/v1/models"),
        ("anthropic", "/proxy/messages", "anthropic-messages", "/proxy", "/proxy/v1/models"),
    ],
)
def test_standard_paths_full_endpoints_and_custom_prefixes(provider, path, protocol, base, models):
    origin = "https://gateway.example:8443"
    endpoint = resolve_model_endpoint(provider, origin + path)
    assert endpoint.protocol == protocol
    assert endpoint.base_url == origin + base
    assert endpoint.models_url == origin + models


def test_local_ipv6_origin_gets_version_without_changing_host_or_port():
    endpoint = resolve_model_endpoint("openai", "http://[::1]:11434/")
    assert endpoint.base_url == "http://[::1]:11434/v1"
    assert endpoint.models_url == "http://[::1]:11434/v1/models"


@pytest.mark.parametrize(
    "provider,path,expected,anthropic",
    [
        ("openai", "", "/v1/models", False),
        ("openai", "/v1", "/v1/models", False),
        ("openai", "/v1/chat/completions", "/v1/models", False),
        ("openai", "/v1/responses", "/v1/models", False),
        ("openai", "/models", "/models", False),
        ("openai", "/proxy/openai", "/proxy/openai/models", False),
        ("anthropic", "", "/v1/models", True),
        ("anthropic", "/v1", "/v1/models", True),
        ("openai", "/proxy/v1/messages", "/proxy/v1/models", True),
        ("anthropic", "/proxy/v1/responses", "/proxy/v1/models", False),
    ],
)
def test_discovery_uses_resolved_path_and_protocol_over_real_http(provider, path, expected, anthropic):
    requests = []

    class Gateway(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append((self.path, self.headers.get("authorization"), self.headers.get("x-api-key")))
            correct = self.path == expected
            body = json.dumps({"data": [{"id": "local-custom-model"}]}).encode() if correct else b"<html>Gateway</html>"
            self.send_response(200)
            self.send_header("Content-Type", "application/json" if correct else "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
    thread = Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    try:
        result = discover_models(provider, f"http://127.0.0.1:{server.server_port}{path}", "local-test-key")
        assert [model["id"] for model in result["models"]] == ["local-custom-model"]
        assert requests == [
            (expected, None if anthropic else "Bearer local-test-key", "local-test-key" if anthropic else None)
        ]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)
