# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.db import models
from django.db.models.functions import Lower

from .base import BaseModel
from .project import ProjectBaseModel


class AttachmentTemplate(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="attachment_templates")
    name = models.CharField(max_length=100)
    slots = models.JSONField(default=list)

    class Meta:
        db_table = "attachment_templates"
        ordering = ("name", "id")
        constraints = [
            models.UniqueConstraint(
                Lower("name"),
                "workspace",
                condition=models.Q(deleted_at__isnull=True),
                name="attachment_template_workspace_name_unique",
            )
        ]


class IssueAttachmentSlot(ProjectBaseModel):
    issue = models.ForeignKey("db.Issue", on_delete=models.CASCADE, related_name="attachment_slots")
    name = models.CharField(max_length=100)
    sort_order = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "issue_attachment_slots"
        ordering = ("sort_order", "created_at", "id")
        constraints = [
            models.UniqueConstraint(
                Lower("name"),
                "issue",
                condition=models.Q(deleted_at__isnull=True),
                name="attachment_slot_issue_name_unique",
            )
        ]
