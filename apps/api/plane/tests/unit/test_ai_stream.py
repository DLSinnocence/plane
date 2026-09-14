# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
from contextlib import asynccontextmanager
from datetime import timedelta
import json
from types import SimpleNamespace
from threading import Event
from unittest.mock import Mock

import httpx
import pytest
from django.http import HttpResponse, StreamingHttpResponse
from django.test import RequestFactory
from django.utils import timezone
from rest_framework.test import APIRequestFactory

from plane.app.views import ai
from plane.db.models import User
from plane.middleware.logger import APITokenLogMiddleware
from plane.utils.ai import AGENT_TOKEN_LABEL

pytestmark = pytest.mark.unit


@pytest.fixture
def stream_boundary(monkeypatch, settings):
    """Replace DB/cache/network boundaries, preserving the real async generator."""
    settings.LIVE_URL = "http://live.internal/"
    settings.LIVE_SERVER_SECRET_KEY = "internal-secret"
    cache_values = {}
    cache = Mock()

    def add(key, value, timeout):
        if key in cache_values:
            return False
        cache_values[key] = value
        return True

    cache.add.side_effect = add
    cache.get.side_effect = cache_values.get
    cache.delete.side_effect = lambda key: cache_values.pop(key, None)
    monkeypatch.setattr(ai, "cache", cache)
    create = Mock(return_value=SimpleNamespace(id="token-id", token="temporary-secret"))
    cleanup = Mock()
    monkeypatch.setattr(ai, "create_agent_token", create)
    monkeypatch.setattr(ai, "cleanup_agent_token", cleanup)
    state = SimpleNamespace(
        cache=cache,
        cache_values=cache_values,
        create=create,
        cleanup=cleanup,
        status=200,
        error=None,
        wait=False,
        entered=None,
        chunks=[b'{"type":"done"}\n'],
    )

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        @asynccontextmanager
        async def stream(self, *args, **kwargs):
            state.request = (args, kwargs)
            if state.error:
                raise state.error

            async def chunks():
                if state.wait:
                    state.entered.set()
                    await asyncio.Event().wait()
                for chunk in state.chunks:
                    yield chunk

            yield SimpleNamespace(status_code=state.status, aiter_bytes=chunks)

    state.client = Mock(return_value=Client())
    monkeypatch.setattr(ai.httpx, "AsyncClient", state.client)
    return state


def payload():
    return {
        "user_id": "user-id",
        "workspace_slug": "alpha",
        "messages": [{"role": "user", "content": "hello"}],
        "model_config": {"api_key": "model-secret"},
    }


async def collect(stream):
    return [chunk async for chunk in stream]


def test_stream_never_started_creates_no_authority(stream_boundary):
    async def scenario():
        stream = ai.stream_agent_turn(payload(), "workspace-id")
        await stream.aclose()

    asyncio.run(scenario())
    stream_boundary.create.assert_not_called()
    stream_boundary.client.assert_not_called()
    stream_boundary.cache.add.assert_not_called()


def test_disconnect_after_initial_frame_revokes_without_contacting_upstream(stream_boundary):
    async def scenario():
        stream = ai.stream_agent_turn(payload(), "workspace-id")
        assert await anext(stream) == b"\n"
        stream_boundary.create.assert_called_once_with("user-id", "workspace-id")
        await stream.aclose()

    asyncio.run(scenario())
    stream_boundary.cleanup.assert_called_once_with("token-id")
    stream_boundary.client.assert_not_called()
    assert not stream_boundary.cache_values


def test_success_stream_forwards_only_server_assembled_credentials_and_cleans_up(stream_boundary):
    assert asyncio.run(collect(ai.stream_agent_turn(payload(), "workspace-id"))) == [b"\n", *stream_boundary.chunks]
    stream_boundary.cleanup.assert_called_once_with("token-id")
    assert not stream_boundary.cache_values
    args, kwargs = stream_boundary.request
    assert args == ("POST", "http://live.internal/ai/chat")
    assert kwargs["headers"] == {"X-Plane-AI-Secret": "internal-secret"}
    assert kwargs["json"]["plane_api_token"] == "temporary-secret"
    assert stream_boundary.client.call_args.kwargs["trust_env"] is False


@pytest.mark.parametrize("failure", ["status", "http", "timeout"])
def test_upstream_failures_are_sanitized_and_revoke_token(stream_boundary, failure):
    if failure == "status":
        stream_boundary.status = 503
        stream_boundary.chunks = [b"model-secret upstream diagnostic"]
    else:
        stream_boundary.error = (httpx.ConnectError if failure == "http" else TimeoutError)(
            "model-secret temporary-secret private URL"
        )
    chunks = asyncio.run(collect(ai.stream_agent_turn(payload(), "workspace-id")))
    events = [json.loads(chunk) for chunk in chunks if chunk.strip()]
    assert [event["type"] for event in events] == ["error", "done"]
    assert events[-1]["reason"] == "error"
    assert b"model-secret" not in b"".join(chunks)
    assert b"temporary-secret" not in b"".join(chunks)
    stream_boundary.cleanup.assert_called_once_with("token-id")
    assert not stream_boundary.cache_values


def test_disconnect_cancellation_during_upstream_read_revokes_token(stream_boundary):
    async def scenario():
        stream_boundary.wait = True
        stream_boundary.entered = asyncio.Event()
        task = asyncio.create_task(collect(ai.stream_agent_turn(payload(), "workspace-id")))
        await asyncio.wait_for(stream_boundary.entered.wait(), timeout=2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    stream_boundary.cleanup.assert_called_once_with("token-id")
    assert not stream_boundary.cache_values


def test_disconnect_while_lock_acquisition_is_in_flight_releases_owned_lock(stream_boundary):
    started, release, finished = Event(), Event(), Event()
    add = stream_boundary.cache.add.side_effect

    def slow_add(*args, **kwargs):
        started.set()
        assert release.wait(timeout=2), "test failed to release cache acquisition"
        result = add(*args, **kwargs)
        finished.set()
        return result

    stream_boundary.cache.add.side_effect = slow_add

    async def scenario():
        task = asyncio.create_task(collect(ai.stream_agent_turn(payload(), "workspace-id")))
        try:
            assert await asyncio.to_thread(started.wait, 2)
            task.cancel()
            await asyncio.sleep(0)
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=2)
        assert await asyncio.to_thread(finished.wait, 2)

    asyncio.run(scenario())
    assert not stream_boundary.cache_values
    stream_boundary.create.assert_not_called()
    stream_boundary.client.assert_not_called()


def test_disconnect_while_token_creation_is_in_flight_still_revokes_token(stream_boundary):
    started, release = Event(), Event()

    def slow_create(*args):
        started.set()
        assert release.wait(timeout=2), "test failed to release token creation"
        return SimpleNamespace(id="token-id", token="temporary-secret")

    stream_boundary.create.side_effect = slow_create

    async def scenario():
        task = asyncio.create_task(collect(ai.stream_agent_turn(payload(), "workspace-id")))
        try:
            assert await asyncio.to_thread(started.wait, 2)
            task.cancel()
            # Deliver disconnect while the synchronous DB operation is still running.
            await asyncio.sleep(0)
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=2)

    asyncio.run(scenario())
    stream_boundary.cleanup.assert_called_once_with("token-id")
    stream_boundary.client.assert_not_called()
    assert not stream_boundary.cache_values


def test_total_turn_deadline_cancels_stalled_upstream_and_revokes_token(stream_boundary, monkeypatch):
    real_timeout = asyncio.timeout
    budgets = []

    def short_timeout(seconds):
        budgets.append(seconds)
        return real_timeout(0.01)

    monkeypatch.setattr(ai.asyncio, "timeout", short_timeout)

    async def scenario():
        stream_boundary.wait = True
        stream_boundary.entered = asyncio.Event()
        return await asyncio.wait_for(collect(ai.stream_agent_turn(payload(), "workspace-id")), timeout=2)

    chunks = asyncio.run(scenario())
    assert budgets == [135]
    assert stream_boundary.entered.is_set()
    assert json.loads(chunks[-1]) == {"type": "done", "reason": "error"}
    stream_boundary.cleanup.assert_called_once_with("token-id")
    assert not stream_boundary.cache_values


@pytest.mark.parametrize(
    "endpoint,method,path,kwargs",
    [
        (ai.PersonalAIModelsEndpoint, "post", "/api/users/me/ai-settings/models/", {}),
        (ai.PersonalAISettingsEndpoint, "patch", "/api/users/me/ai-settings/", {}),
        (ai.PersonalAISettingsEndpoint, "delete", "/api/users/me/ai-settings/", {}),
        (ai.WorkspaceAgentChatEndpoint, "post", "/api/workspaces/alpha/agent/chat/", {"slug": "alpha"}),
    ],
)
def test_session_csrf_rejects_before_any_database_or_provider_access(endpoint, method, path, kwargs):
    # Supplying the middleware-authenticated user retains real SessionAuthentication;
    # DRF force_authenticate would silently bypass the CSRF check under test.
    request = getattr(APIRequestFactory(enforce_csrf_checks=True), method)(path, {}, format="json")
    request.user = User(email="csrf-test@example.com", is_active=True)
    response = endpoint.as_view()(request, **kwargs)
    assert response.status_code == 403
    assert "CSRF" in str(response.data)


def test_busy_user_cannot_create_second_token_or_release_first_lock(stream_boundary):
    stream_boundary.cache_values["plane-ai-turn:user-id"] = "existing-owner"
    events = [json.loads(chunk) for chunk in asyncio.run(collect(ai.stream_agent_turn(payload(), "workspace-id")))]
    assert [event["type"] for event in events] == ["error", "done"]
    stream_boundary.create.assert_not_called()
    stream_boundary.cleanup.assert_not_called()
    stream_boundary.cache.delete.assert_not_called()
    assert stream_boundary.cache_values["plane-ai-turn:user-id"] == "existing-owner"


def test_cleanup_does_not_delete_replacement_lock(stream_boundary):
    async def scenario():
        stream = ai.stream_agent_turn(payload(), "workspace-id")
        await anext(stream)
        stream_boundary.cache_values["plane-ai-turn:user-id"] = "replacement-owner"
        await stream.aclose()

    asyncio.run(scenario())
    stream_boundary.cleanup.assert_called_once_with("token-id")
    stream_boundary.cache.delete.assert_not_called()


def test_token_creation_failure_emits_safe_error_and_releases_lock(stream_boundary):
    stream_boundary.create.side_effect = RuntimeError("database unavailable: private-db-host model-secret")
    chunks = asyncio.run(collect(ai.stream_agent_turn(payload(), "workspace-id")))
    events = [json.loads(chunk) for chunk in chunks if chunk.strip()]
    assert [event["type"] for event in events] == ["error", "done"]
    assert events[-1]["reason"] == "error"
    assert b"private-db-host" not in b"".join(chunks)
    assert b"model-secret" not in b"".join(chunks)
    assert not stream_boundary.cache_values
    stream_boundary.cleanup.assert_not_called()
    stream_boundary.client.assert_not_called()


def test_temporary_token_expires_in_three_minutes_and_prunes_only_expired_ai_tokens(monkeypatch):
    now = timezone.now()
    monkeypatch.setattr(ai.timezone, "now", lambda: now)
    manager = Mock()
    monkeypatch.setattr(ai.APIToken, "objects", manager)
    assert ai.create_agent_token("user-id", "workspace-id") == manager.create.return_value
    manager.filter.assert_called_once_with(
        user_id="user-id", is_service=True, label=AGENT_TOKEN_LABEL, expired_at__lte=now
    )
    manager.filter.return_value.delete.assert_called_once_with(soft=False)
    manager.create.assert_called_once_with(
        user_id="user-id",
        workspace_id="workspace-id",
        is_service=True,
        label=AGENT_TOKEN_LABEL,
        expired_at=now + timedelta(minutes=3),
    )


def test_cleanup_hard_deletes_only_issued_token(monkeypatch):
    manager = Mock()
    monkeypatch.setattr(ai.APIToken, "objects", manager)
    ai.cleanup_agent_token("issued-id")
    manager.filter.assert_called_once_with(id="issued-id")
    manager.filter.return_value.delete.assert_called_once_with(soft=False)


@pytest.mark.parametrize(
    "path",
    [
        "/api/users/me/ai-settings",
        "/api/users/me/ai-settings/",
        "/api/users/me/ai-settings/models",
        "/api/users/me/ai-settings/models/",
        "/api/workspaces/team/agent/chat",
        "/api/workspaces/team/agent/chat/",
    ],
)
@pytest.mark.parametrize(
    "body",
    [
        b'{"api_key":"model-secret","messages":["private transcript"]}',
        b'{"api_key":"model-secret',
        b"api_key=model-secret",
    ],
)
@pytest.mark.parametrize("streaming", [False, True])
def test_ai_routes_never_log_request_or_response_even_with_malicious_api_key(monkeypatch, path, body, streaming):
    request = RequestFactory().post(
        path, data=body, content_type="application/json", HTTP_X_API_KEY="attacker-forces-logging"
    )
    response = StreamingHttpResponse(iter([b"private transcript"])) if streaming else HttpResponse(b"model-secret")
    logger = Mock()
    monkeypatch.setattr("plane.middleware.logger.process_logs", logger)
    middleware = APITokenLogMiddleware(Mock(return_value=response))
    assert middleware(request) is response
    # Pin direct invocation too: callers must not bypass the sensitive-route guard.
    middleware.process_request(request, response, body)
    logger.delay.assert_not_called()
    # No real request lifecycle is active in this unit test. Closing the response
    # would fire global database cleanup signals unrelated to the logger behavior.
