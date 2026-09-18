# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""Opt-in API → Live → real Pi/MCP integration against a local model fixture.

Run with PLANE_AI_TEST_LIVE_URL and PLANE_AI_TEST_MODEL_URL pointing to isolated
local test services. No production credentials or workspace data are used.
"""

import asyncio
import json
import os

import pytest

from plane.db.models import APIToken, WorkspaceAIModel, WorkspaceAIProvider
from plane.utils.ai import AGENT_TOKEN_LABEL, encrypt_model_key

pytestmark = [
    pytest.mark.contract,
    pytest.mark.django_db(transaction=True),
    pytest.mark.skipif(
        not os.environ.get("PLANE_AI_TEST_LIVE_URL"), reason="Local Live integration fixture not configured"
    ),
]


@pytest.fixture(autouse=True)
def local_agent_settings(settings, workspace):
    settings.AI_AGENT_URL = os.environ["PLANE_AI_TEST_LIVE_URL"]
    settings.LIVE_SERVER_SECRET_KEY = "local-agent-integration-secret"
    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
    provider = WorkspaceAIProvider.objects.create(
        workspace=workspace,
        name="Local integration",
        provider="openai",
        base_url=os.environ["PLANE_AI_TEST_MODEL_URL"],
        api_key_encrypted=encrypt_model_key("local-model-test-key"),
    )
    WorkspaceAIModel.objects.create(
        workspace=workspace,
        provider_config=provider,
        model="local-integration-model",
        is_default=True,
    )


async def events(response):
    chunks = [chunk async for chunk in response.streaming_content]
    return [json.loads(line) for line in b"".join(chunks).splitlines() if line.strip()]


def test_personal_chat_crosses_live_pi_and_real_mcp(session_client, workspace, create_user):
    response = session_client.post(
        f"/api/workspaces/{workspace.slug}/agent/chat/",
        {"messages": [{"role": "user", "content": "Check the assistant connection."}]},
        format="json",
    )
    assert response.status_code == 200
    result = asyncio.run(events(response))
    assert any(
        event.get("type") == "text" and "Connected through Pi and MCP" in event.get("text", "") for event in result
    )
    assert result[-1] == {"type": "done", "reason": "complete"}
    assert not APIToken.objects.filter(user=create_user, label=AGENT_TOKEN_LABEL).exists()
    assert "local-model-test-key" not in json.dumps(result)


def test_wrong_service_secret_is_a_retryable_setup_error(session_client, workspace, settings, create_user):
    settings.LIVE_SERVER_SECRET_KEY = "incorrect-service-secret"
    response = session_client.post(
        f"/api/workspaces/{workspace.slug}/agent/chat/",
        {"messages": [{"role": "user", "content": "Hello"}]},
        format="json",
    )
    result = asyncio.run(events(response))
    error = next(event for event in result if event.get("type") == "error")
    assert error["code"] == "ai_service_auth"
    assert error["may_have_changes"] is False
    assert not APIToken.objects.filter(user=create_user, label=AGENT_TOKEN_LABEL).exists()
