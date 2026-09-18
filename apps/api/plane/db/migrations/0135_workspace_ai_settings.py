# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import uuid

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [("db", "0134_user_ai_settings_supports_images")]

    operations = [
        migrations.CreateModel(
            name="WorkspaceAIProvider",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("name", models.CharField(max_length=80)),
                (
                    "provider",
                    models.CharField(
                        choices=(("openai", "OpenAI"), ("anthropic", "Anthropic")), max_length=20
                    ),
                ),
                ("base_url", models.URLField(max_length=500)),
                ("api_key_encrypted", models.TextField(blank=True, default="")),
                ("is_enabled", models.BooleanField(default=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="ai_provider_configs",
                        to="db.workspace",
                    ),
                ),
            ],
            options={
                "db_table": "workspace_ai_providers",
                "ordering": ("created_at", "id"),
            },
        ),
        migrations.CreateModel(
            name="WorkspaceAIModel",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("model", models.CharField(max_length=200)),
                ("supports_images", models.BooleanField(default=False)),
                ("is_enabled", models.BooleanField(default=True)),
                ("is_default", models.BooleanField(default=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "provider_config",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="models",
                        to="db.workspaceaiprovider",
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="ai_models",
                        to="db.workspace",
                    ),
                ),
            ],
            options={
                "db_table": "workspace_ai_models",
                "ordering": ("created_at", "id"),
            },
        ),
        migrations.AddConstraint(
            model_name="workspaceaimodel",
            constraint=models.UniqueConstraint(
                fields=("provider_config", "model"), name="workspace_ai_provider_model_unique"
            ),
        ),
        migrations.AddConstraint(
            model_name="workspaceaimodel",
            constraint=models.UniqueConstraint(
                condition=models.Q(("is_default", True)),
                fields=("workspace",),
                name="workspace_ai_one_default_model",
            ),
        ),
    ]
