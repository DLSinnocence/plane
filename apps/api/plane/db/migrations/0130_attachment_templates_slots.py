# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import uuid

from django.conf import settings
from django.db import migrations, models
from django.db.models.functions import Lower
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
            name="AttachmentTemplate",
            fields=audit_fields()
            + [
                ("name", models.CharField(max_length=100)),
                ("slots", models.JSONField(default=list)),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="attachment_templates",
                        to="db.workspace",
                    ),
                ),
            ],
            options={
                "db_table": "attachment_templates",
                "ordering": ("name", "id"),
                "constraints": [
                    models.UniqueConstraint(
                        Lower("name"),
                        "workspace",
                        condition=models.Q(deleted_at__isnull=True),
                        name="attachment_template_workspace_name_unique",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="IssueAttachmentSlot",
            fields=audit_fields()
            + [
                ("name", models.CharField(max_length=100)),
                ("sort_order", models.PositiveIntegerField(default=0)),
                (
                    "issue",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, related_name="attachment_slots", to="db.issue"
                    ),
                ),
                (
                    "project",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, related_name="project_%(class)s", to="db.project"
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="workspace_%(class)s",
                        to="db.workspace",
                    ),
                ),
            ],
            options={
                "db_table": "issue_attachment_slots",
                "ordering": ("sort_order", "created_at", "id"),
                "constraints": [
                    models.UniqueConstraint(
                        Lower("name"),
                        "issue",
                        condition=models.Q(deleted_at__isnull=True),
                        name="attachment_slot_issue_name_unique",
                    ),
                ],
            },
        ),
        migrations.AddField(
            model_name="fileasset",
            name="attachment_slot",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="attachments",
                to="db.issueattachmentslot",
            ),
        ),
        migrations.AddConstraint(
            model_name="fileasset",
            constraint=models.UniqueConstraint(
                fields=("attachment_slot",),
                condition=models.Q(is_uploaded=True, is_deleted=False, deleted_at__isnull=True),
                name="attachment_slot_current_asset_unique",
            ),
        ),
    ]
