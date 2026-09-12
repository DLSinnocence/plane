# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import uuid

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


def audit_fields():
    return [
        ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Created At")),
        ("updated_at", models.DateTimeField(auto_now=True, verbose_name="Last Modified At")),
        ("deleted_at", models.DateTimeField(blank=True, null=True, verbose_name="Deleted At")),
        ("id", models.UUIDField(db_index=True, default=uuid.uuid4, editable=False, primary_key=True, serialize=False, unique=True)),
        ("created_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="%(class)s_created_by", to=settings.AUTH_USER_MODEL, verbose_name="Created By")),
        ("updated_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="%(class)s_updated_by", to=settings.AUTH_USER_MODEL, verbose_name="Last Modified By")),
    ]


class Migration(migrations.Migration):
    dependencies = [("db", "0125_issue_state_assignees"), migrations.swappable_dependency(settings.AUTH_USER_MODEL)]

    operations = [
        migrations.CreateModel(
            name="FeishuIntegration",
            fields=audit_fields() + [
                ("app_id", models.CharField(blank=True, default="", max_length=255)),
                ("app_secret", models.TextField(blank=True, default="")),
                ("enabled", models.BooleanField(default=False)),
                ("workspace", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name="feishu_integration", to="db.workspace")),
            ],
            options={"db_table": "feishu_integrations"},
        ),
        migrations.CreateModel(
            name="FeishuMemberBinding",
            fields=audit_fields() + [
                ("open_id", models.CharField(max_length=255)),
                ("integration", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="bindings", to="db.feishuintegration")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="feishu_bindings", to=settings.AUTH_USER_MODEL)),
            ],
            options={"db_table": "feishu_member_bindings", "constraints": [
                models.UniqueConstraint(fields=("integration", "user"), name="feishu_binding_user_unique"),
                models.UniqueConstraint(fields=("integration", "open_id"), name="feishu_binding_open_id_unique"),
            ]},
        ),
        migrations.CreateModel(
            name="FeishuMessage",
            fields=audit_fields() + [
                ("event_key", models.CharField(max_length=255)),
                ("card", models.JSONField(default=dict)),
                ("recipient_open_id", models.CharField(max_length=255)),
                ("app_id", models.CharField(max_length=255)),
                ("status", models.CharField(choices=[("pending", "Pending"), ("sending", "Sending"), ("sent", "Sent"), ("failed", "Failed"), ("skipped", "Skipped")], default="pending", max_length=16)),
                ("attempts", models.PositiveIntegerField(default=0)),
                ("last_error", models.CharField(blank=True, default="", max_length=100)),
                ("sent_at", models.DateTimeField(blank=True, null=True)),
                ("lease_expires_at", models.DateTimeField(blank=True, null=True)),
                ("claim_token", models.UUIDField(blank=True, null=True)),
                ("integration", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="messages", to="db.feishuintegration")),
                ("issue", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="feishu_messages", to="db.issue")),
                ("receiver", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="feishu_messages", to=settings.AUTH_USER_MODEL)),
            ],
            options={"db_table": "feishu_messages", "constraints": [
                models.UniqueConstraint(fields=("integration", "event_key", "receiver"), name="feishu_message_recipient_unique"),
            ]},
        ),
    ]
