# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import base64
import binascii

from rest_framework import serializers

from plane.utils.ai import validate_model_url

PROVIDER_BASE_URLS = {"openai": "https://api.openai.com/v1", "anthropic": "https://api.anthropic.com"}
MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_IMAGE_BASE64 = 4 * ((MAX_IMAGE_BYTES + 2) // 3)


class ModelBaseURLField(serializers.CharField):
    def __init__(self, **kwargs):
        super().__init__(max_length=500, allow_blank=True, trim_whitespace=False, **kwargs)

    def to_internal_value(self, data):
        value = super().to_internal_value(data)
        # Check before stripping: urlsplit silently removes some control characters.
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise serializers.ValidationError("Enter a valid model API base URL.")
        return validate_model_url(value) if value.strip() else ""


class AISettingsInputSerializer(serializers.Serializer):
    provider = serializers.ChoiceField(choices=["openai", "anthropic"], required=False)
    base_url = ModelBaseURLField(required=False)
    model = serializers.CharField(max_length=200, required=False)
    supports_images = serializers.BooleanField(required=False)
    api_key = serializers.CharField(max_length=4096, required=False, allow_blank=True, write_only=True)


class AIModelsInputSerializer(serializers.Serializer):
    provider = serializers.ChoiceField(choices=["openai", "anthropic"])
    base_url = ModelBaseURLField()
    api_key = serializers.CharField(max_length=4096, required=False, allow_blank=True, write_only=True)

    def validate(self, attrs):
        attrs["base_url"] = attrs["base_url"] or PROVIDER_BASE_URLS[attrs["provider"]]
        return attrs


class WorkspaceAIProviderInputSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80, required=False)
    provider = serializers.ChoiceField(choices=["openai", "anthropic"], required=False)
    base_url = ModelBaseURLField(required=False)
    api_key = serializers.CharField(max_length=4096, required=False, allow_blank=True, write_only=True)
    is_enabled = serializers.BooleanField(required=False)

    def validate_name(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Enter a provider name.")
        return value


class WorkspaceAIModelInputSerializer(serializers.Serializer):
    model = serializers.CharField(max_length=200, required=False)
    supports_images = serializers.BooleanField(required=False)
    is_enabled = serializers.BooleanField(required=False)
    is_default = serializers.BooleanField(required=False)

    def validate_model(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Enter a model name.")
        return value


class WorkspaceAIModelsDiscoveryInputSerializer(AIModelsInputSerializer):
    provider_id = serializers.UUIDField(required=False)


class AgentImageSerializer(serializers.Serializer):
    data = serializers.CharField(max_length=MAX_IMAGE_BASE64, trim_whitespace=False)
    mime_type = serializers.ChoiceField(choices=["image/png", "image/jpeg", "image/webp"])
    name = serializers.CharField(max_length=255, required=False, allow_blank=True)

    def validate(self, attrs):
        try:
            decoded = base64.b64decode(attrs["data"], validate=True)
        except (ValueError, binascii.Error):
            raise serializers.ValidationError("Images must contain valid base64 data.")
        if not decoded or len(decoded) > MAX_IMAGE_BYTES:
            raise serializers.ValidationError("Each image must be at most 2 MiB.")
        # Re-encoding rejects noncanonical padding and nonzero trailing padding bits.
        if base64.b64encode(decoded).decode("ascii") != attrs["data"]:
            raise serializers.ValidationError("Images must contain valid base64 data.")
        signatures = {
            "image/png": decoded.startswith(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg": decoded.startswith(b"\xff\xd8\xff"),
            "image/webp": decoded.startswith(b"RIFF") and decoded[8:12] == b"WEBP",
        }
        if not signatures[attrs["mime_type"]]:
            raise serializers.ValidationError("Image data does not match its MIME type.")
        return attrs


class AgentMessageSerializer(serializers.Serializer):
    role = serializers.ChoiceField(choices=["user", "assistant"])
    content = serializers.CharField(max_length=16000, allow_blank=True)
    images = AgentImageSerializer(many=True, required=False, max_length=3)

    def validate(self, attrs):
        if attrs["role"] != "user" and "images" in attrs:
            raise serializers.ValidationError("Only user messages may include images.")
        if not attrs["content"] and not attrs.get("images"):
            raise serializers.ValidationError("Enter a message or attach an image.")
        return attrs


class AgentChatInputSerializer(serializers.Serializer):
    messages = AgentMessageSerializer(many=True, allow_empty=False, max_length=40)
    project_id = serializers.UUIDField(required=False, allow_null=True)

    def validate_messages(self, value):
        if sum(len(message["content"]) for message in value) > 60000:
            raise serializers.ValidationError("The conversation is too long. Start a new chat.")
        # Three images of <=2 MiB also bounds decoded bytes to 6 MiB overall.
        if sum(len(message.get("images", [])) for message in value) > 3:
            raise serializers.ValidationError("Attach at most 3 images across the conversation (6 MiB total).")
        if value[-1]["role"] != "user":
            raise serializers.ValidationError("The last message must be from the user.")
        return value
