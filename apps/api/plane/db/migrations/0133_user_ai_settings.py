# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0132_unify_issue_attachment_rows"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="UserAISettings",
            fields=[
                (
                    "user",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        primary_key=True,
                        related_name="ai_settings",
                        serialize=False,
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                ("provider", models.CharField(default="openai", max_length=20)),
                ("base_url", models.URLField(default="https://api.openai.com/v1", max_length=500)),
                ("model", models.CharField(default="gpt-4o-mini", max_length=200)),
                ("api_key_encrypted", models.TextField(blank=True, default="")),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"db_table": "user_ai_settings"},
        ),
    ]
