# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from rest_framework import serializers

from plane.utils.ai import validate_model_url


class AISettingsInputSerializer(serializers.Serializer):
    provider = serializers.ChoiceField(choices=["openai", "anthropic"], required=False)
    base_url = serializers.CharField(max_length=500, required=False)
    model = serializers.CharField(max_length=200, required=False)
    api_key = serializers.CharField(max_length=4096, required=False, allow_blank=True, write_only=True)

    def validate_base_url(self, value):
        return validate_model_url(value)


class AgentMessageSerializer(serializers.Serializer):
    role = serializers.ChoiceField(choices=["user", "assistant"])
    content = serializers.CharField(max_length=16000)


class AgentChatInputSerializer(serializers.Serializer):
    messages = AgentMessageSerializer(many=True, allow_empty=False)
    project_id = serializers.UUIDField(required=False, allow_null=True)

    def validate_messages(self, value):
        if len(value) > 40 or sum(len(message["content"]) for message in value) > 60000:
            raise serializers.ValidationError("The conversation is too long. Start a new chat.")
        if value[-1]["role"] != "user":
            raise serializers.ValidationError("The last message must be from the user.")
        return value
