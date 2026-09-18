# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q


class UserAISettings(models.Model):
    """Personal model credentials retained for legacy API compatibility."""

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, primary_key=True, related_name="ai_settings"
    )
    provider = models.CharField(max_length=20, default="openai")
    base_url = models.URLField(max_length=500, default="https://api.openai.com/v1")
    model = models.CharField(max_length=200, default="gpt-4o-mini")
    supports_images = models.BooleanField(default=False)
    api_key_encrypted = models.TextField(blank=True, default="")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "user_ai_settings"


class WorkspaceAIProvider(models.Model):
    id = models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True)
    workspace = models.ForeignKey(
        "db.Workspace", on_delete=models.CASCADE, related_name="ai_provider_configs"
    )
    name = models.CharField(max_length=80)
    provider = models.CharField(max_length=20, choices=(("openai", "OpenAI"), ("anthropic", "Anthropic")))
    base_url = models.URLField(max_length=500)
    api_key_encrypted = models.TextField(blank=True, default="")
    is_enabled = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "workspace_ai_providers"
        ordering = ("created_at", "id")


class WorkspaceAIModel(models.Model):
    id = models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True)
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="ai_models")
    provider_config = models.ForeignKey(
        WorkspaceAIProvider, on_delete=models.CASCADE, related_name="models"
    )
    model = models.CharField(max_length=200)
    supports_images = models.BooleanField(default=False)
    is_enabled = models.BooleanField(default=True)
    is_default = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "workspace_ai_models"
        ordering = ("created_at", "id")
        constraints = [
            models.UniqueConstraint(
                fields=("provider_config", "model"), name="workspace_ai_provider_model_unique"
            ),
            models.UniqueConstraint(
                fields=("workspace",),
                condition=Q(is_default=True),
                name="workspace_ai_one_default_model",
            ),
        ]
