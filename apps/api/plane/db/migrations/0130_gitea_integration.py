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
        (
            "id",
            models.UUIDField(
                db_index=True, default=uuid.uuid4, editable=False, primary_key=True, serialize=False, unique=True
            ),
        ),
        (
            "created_by",
            models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="%(class)s_created_by",
                to=settings.AUTH_USER_MODEL,
                verbose_name="Created By",
            ),
        ),
        (
            "updated_by",
            models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="%(class)s_updated_by",
                to=settings.AUTH_USER_MODEL,
                verbose_name="Last Modified By",
            ),
        ),
    ]


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0129_draftissue_state_assignees"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]
    operations = [
        migrations.CreateModel(
            name="GiteaIntegration",
            fields=audit_fields()
            + [
                ("secret", models.TextField(blank=True, default="")),
                ("enabled", models.BooleanField(default=False)),
                (
                    "workspace",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE, related_name="gitea_integration", to="db.workspace"
                    ),
                ),
            ],
            options={"db_table": "gitea_integrations"},
        ),
        migrations.CreateModel(
            name="GiteaCommit",
            fields=audit_fields()
            + [
                ("sha", models.CharField(max_length=64)),
                ("url", models.URLField(max_length=2048)),
                ("message", models.TextField()),
                ("title", models.TextField()),
                ("author_name", models.CharField(blank=True, default="", max_length=255)),
                ("committed_at", models.DateTimeField(blank=True, null=True)),
                ("repository_name", models.CharField(blank=True, default="", max_length=255)),
                ("branch", models.CharField(blank=True, default="", max_length=1024)),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, related_name="gitea_commits", to="db.workspace"
                    ),
                ),
            ],
            options={
                "db_table": "gitea_commits",
                "constraints": [
                    models.UniqueConstraint(fields=("workspace", "url"), name="gitea_commit_unique"),
                ],
            },
        ),
        migrations.CreateModel(
            name="GiteaCommitLink",
            fields=audit_fields()
            + [
                (
                    "commit",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, related_name="links", to="db.giteacommit"
                    ),
                ),
                (
                    "issue",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, related_name="gitea_commit_links", to="db.issue"
                    ),
                ),
            ],
            options={
                "db_table": "gitea_commit_links",
                "constraints": [
                    models.UniqueConstraint(fields=("commit", "issue"), name="gitea_commit_issue_unique"),
                ],
            },
        ),
    ]
