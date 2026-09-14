# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
from datetime import timedelta
import json
from uuid import uuid4

from asgiref.sync import sync_to_async
from cryptography.fernet import InvalidToken
from django.conf import settings
from django.core.cache import cache
from django.http import StreamingHttpResponse
from django.utils import timezone
import httpx
from rest_framework.authentication import SessionAuthentication
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from plane.app.parsers import AIChatJSONParser
from plane.app.permissions import ROLE, allow_permission
from plane.app.serializers.ai import (
    AIModelsInputSerializer,
    AISettingsInputSerializer,
    AgentChatInputSerializer,
    PROVIDER_BASE_URLS,
)
from plane.app.views.base import BaseAPIView
from plane.db.models import APIToken, ProjectMember, UserAISettings, Workspace
from plane.utils.ai import (
    AGENT_TOKEN_LABEL,
    DEFAULT_AI_SETTINGS,
    decrypt_model_key,
    encrypt_model_key,
    validate_model_url,
)


from plane.utils.ai_models import DISCOVERY_ERROR, ModelDiscoveryError, discover_models


class PersonalAIModelsEndpoint(BaseAPIView):
    authentication_classes = [SessionAuthentication]

    def post(self, request):
        serializer = AIModelsInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        values = serializer.validated_data
        api_key = values.get("api_key", "")
        if not api_key:
            config = UserAISettings.objects.filter(user=request.user).first()
            if (
                config is None
                or not config.api_key_encrypted
                or config.provider != values["provider"]
                or validate_model_url(config.base_url) != values["base_url"]
            ):
                raise ValidationError({"api_key": "Enter an API key for this provider and base URL."})
            try:
                api_key = decrypt_model_key(config.api_key_encrypted)
            except (InvalidToken, ValueError):
                raise ValidationError({"api_key": "Your saved model key cannot be read. Enter it again."})
        try:
            data = discover_models(values["provider"], values["base_url"], api_key)
            response = Response(data)
        except ModelDiscoveryError:
            response = Response({"error": DISCOVERY_ERROR}, status=502)
        response["Cache-Control"] = "no-store"
        return response


class PersonalAISettingsEndpoint(BaseAPIView):
    # Mutations of credentials must enforce CSRF even though legacy app APIs do not.
    authentication_classes = [SessionAuthentication]

    def get(self, request):
        config = UserAISettings.objects.filter(user=request.user).first()
        data = dict(DEFAULT_AI_SETTINGS) if config is None else self.public_config(config)
        response = Response(data)
        response["Cache-Control"] = "no-store"
        return response

    @staticmethod
    def public_config(config):
        return {
            "provider": config.provider,
            "base_url": config.base_url,
            "model": config.model,
            "has_api_key": bool(config.api_key_encrypted),
            "supports_images": config.supports_images,
        }

    def patch(self, request):
        serializer = AISettingsInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        values = serializer.validated_data
        config = UserAISettings.objects.filter(user=request.user).first() or UserAISettings(user=request.user)
        api_key = values.pop("api_key", "")
        provider = values.get("provider", config.provider)
        if values.get("base_url") == "" or ("base_url" not in values and provider != config.provider):
            values["base_url"] = PROVIDER_BASE_URLS[provider]
        if (
            config.api_key_encrypted
            and not api_key
            and (
                values.get("provider", config.provider) != config.provider
                or values.get("base_url", validate_model_url(config.base_url)) != validate_model_url(config.base_url)
            )
        ):
            raise ValidationError({"api_key": "Enter an API key again when changing the provider or base URL."})
        for field in ("provider", "base_url", "model", "supports_images"):
            if field in values:
                setattr(config, field, values[field])
        validate_model_url(config.base_url)
        if api_key:
            config.api_key_encrypted = encrypt_model_key(api_key)
        if not config.api_key_encrypted:
            raise ValidationError({"api_key": "An API key is required."})
        config.save()
        response = Response(self.public_config(config))
        response["Cache-Control"] = "no-store"
        return response

    def delete(self, request):
        UserAISettings.objects.filter(user=request.user).delete()
        # Revoke any outstanding MCP authority immediately when settings are removed.
        APIToken.objects.filter(user=request.user, is_service=True, label=AGENT_TOKEN_LABEL).update(is_active=False)
        return Response(status=204)


def encode_event(event):
    return (json.dumps(event, ensure_ascii=False) + "\n").encode()


def cleanup_agent_token(token_id):
    APIToken.objects.filter(id=token_id).delete(soft=False)


def create_agent_token(user_id, workspace_id):
    APIToken.objects.filter(
        user_id=user_id, is_service=True, label=AGENT_TOKEN_LABEL, expired_at__lte=timezone.now()
    ).delete(soft=False)
    return APIToken.objects.create(
        user_id=user_id,
        workspace_id=workspace_id,
        is_service=True,
        label=AGENT_TOKEN_LABEL,
        expired_at=timezone.now() + timedelta(minutes=3),
    )


async def stream_agent_turn(payload, workspace_id):
    """An ASGI-native stream: no transcript storage or blocking HTTP in the event loop."""
    lock_key = f"plane-ai-turn:{payload['user_id']}"
    lock_value = uuid4().hex
    lock_acquisition = asyncio.create_task(sync_to_async(cache.add)(lock_key, lock_value, timeout=150))
    token_creation = None
    try:
        if not await asyncio.shield(lock_acquisition):
            yield encode_event({"type": "error", "message": "Another AI request is running. Wait for it to finish."})
            yield encode_event({"type": "done", "reason": "error"})
            return
        token_creation = asyncio.create_task(sync_to_async(create_agent_token)(payload["user_id"], workspace_id))
        token = await asyncio.shield(token_creation)
        payload["plane_api_token"] = token.token
        # This first frame also makes disconnect observable before connecting upstream.
        yield b"\n"
        async with asyncio.timeout(135):
            async with httpx.AsyncClient(timeout=httpx.Timeout(20, connect=10), trust_env=False) as client:
                async with client.stream(
                    "POST",
                    f"{settings.LIVE_URL.rstrip('/')}/ai/chat",
                    headers={"X-Plane-AI-Secret": settings.LIVE_SERVER_SECRET_KEY},
                    json=payload,
                ) as upstream:
                    if upstream.status_code != 200:
                        yield encode_event(
                            {"type": "error", "message": "The AI service is unavailable. Please try again later."}
                        )
                        yield encode_event({"type": "done", "reason": "error"})
                        return
                    async for chunk in upstream.aiter_bytes():
                        yield chunk
    except (httpx.HTTPError, TimeoutError):
        # Never forward provider responses, URLs, keys, or upstream error bodies.
        yield encode_event(
            {
                "type": "error",
                "message": "The AI connection was interrupted. Check the work items before retrying an operation.",
            }
        )
        yield encode_event({"type": "done", "reason": "error"})
    except Exception:
        yield encode_event(
            {"type": "error", "message": "The AI service could not start this request. Please try again later."}
        )
        yield encode_event({"type": "done", "reason": "error"})
    finally:
        # A cancelled await cannot stop the ORM thread. Keep its task and wait
        # for the issued token before revoking it, even on an early disconnect.
        async def cleanup():
            try:
                acquired = await lock_acquisition
            except Exception:
                return
            if not acquired:
                return
            try:
                if token_creation is not None:
                    try:
                        issued_token = await token_creation
                    except Exception:
                        # Setup failed before a token was returned; the stream has
                        # already emitted a generic error without private details.
                        return
                    await sync_to_async(cleanup_agent_token)(issued_token.id)
            finally:
                if await sync_to_async(cache.get)(lock_key) == lock_value:
                    await sync_to_async(cache.delete)(lock_key)

        await asyncio.shield(cleanup())


class WorkspaceAgentChatEndpoint(BaseAPIView):
    authentication_classes = [SessionAuthentication]
    parser_classes = [AIChatJSONParser]

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def post(self, request, slug):
        serializer = AgentChatInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        if not settings.LIVE_URL or not settings.LIVE_SERVER_SECRET_KEY:
            return Response({"error": "The AI service is not configured on this instance."}, status=503)
        config = UserAISettings.objects.filter(user=request.user).first()
        if config is None or not config.api_key_encrypted:
            return Response({"error": "Configure your model in personal AI settings first."}, status=400)
        validate_model_url(config.base_url)
        if not config.supports_images and any(message.get("images") for message in data["messages"]):
            return Response(
                {"error": "Enable image support for your selected model in personal AI settings first."}, status=400
            )
        project_id = data.get("project_id")
        if (
            project_id
            and not ProjectMember.objects.filter(
                project_id=project_id, workspace__slug=slug, member=request.user, is_active=True
            ).exists()
        ):
            return Response({"error": "You do not have access to this project."}, status=403)
        try:
            model_key = decrypt_model_key(config.api_key_encrypted)
        except (InvalidToken, ValueError):
            return Response({"error": "Your saved model key cannot be read. Save it again in AI settings."}, status=400)
        workspace = Workspace.objects.get(slug=slug)
        payload = {
            "user_id": str(request.user.id),
            "workspace_slug": slug,
            "project_id": str(project_id) if project_id else None,
            "messages": data["messages"],
            "model_config": {
                "provider": config.provider,
                "base_url": config.base_url,
                "model": config.model,
                "api_key": model_key,
                "supports_images": config.supports_images,
            },
        }
        response = StreamingHttpResponse(stream_agent_turn(payload, workspace.id), content_type="application/x-ndjson")
        response["Cache-Control"] = "no-store, no-transform"
        response["X-Accel-Buffering"] = "no"
        return response
