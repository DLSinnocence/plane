# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.conf import settings
from django.db import models

from .base import BaseModel


class FeishuIntegration(BaseModel):
    workspace = models.OneToOneField("db.Workspace", on_delete=models.CASCADE, related_name="feishu_integration")
    app_id = models.CharField(max_length=255, blank=True, default="")
    # Ciphertext only. Never expose this field through an API serializer.
    app_secret = models.TextField(blank=True, default="")
    enabled = models.BooleanField(default=False)

    class Meta:
        db_table = "feishu_integrations"


class FeishuMessage(BaseModel):
    class Status(models.TextChoices):
        PENDING = "pending"
        SENDING = "sending"
        SENT = "sent"
        FAILED = "failed"
        SKIPPED = "skipped"

    integration = models.ForeignKey(FeishuIntegration, on_delete=models.CASCADE, related_name="messages")
    issue = models.ForeignKey(
        "db.Issue", null=True, blank=True, on_delete=models.SET_NULL, related_name="feishu_messages"
    )
    receiver = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="feishu_messages")
    event_key = models.CharField(max_length=255)
    card = models.JSONField(default=dict)
    recipient_open_id = models.CharField(max_length=255)
    recipient_mobile = models.CharField(max_length=32, blank=True, default="")
    app_id = models.CharField(max_length=255)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    attempts = models.PositiveIntegerField(default=0)
    last_error = models.CharField(max_length=100, blank=True, default="")
    sent_at = models.DateTimeField(null=True, blank=True)
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    claim_token = models.UUIDField(null=True, blank=True)

    class Meta:
        db_table = "feishu_messages"
        constraints = [
            models.UniqueConstraint(
                fields=["integration", "event_key", "receiver"], name="feishu_message_recipient_unique"
            )
        ]
