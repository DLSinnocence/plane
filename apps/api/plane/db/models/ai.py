# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.conf import settings
from django.db import models


class UserAISettings(models.Model):
    """Personal model credentials. Conversations are deliberately not stored."""

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
