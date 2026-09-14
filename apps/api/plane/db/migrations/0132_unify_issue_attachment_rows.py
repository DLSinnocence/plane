# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.db import migrations
from django.db.models import F


def unify_attachment_rows(apps, schema_editor):
    Asset = apps.get_model("db", "FileAsset")
    Slot = apps.get_model("db", "IssueAttachmentSlot")
    alias = schema_editor.connection.alias
    assets = (
        Asset.objects.using(alias)
        .filter(
            is_uploaded=True,
            is_deleted=False,
            deleted_at__isnull=True,
            entity_type="ISSUE_ATTACHMENT",
            issue_id__isnull=False,
            draft_issue_id__isnull=True,
            issue__is_draft=False,
            issue__deleted_at__isnull=True,
            project__deleted_at__isnull=True,
            workspace__deleted_at__isnull=True,
            issue__project_id=F("project_id"),
            issue__workspace_id=F("workspace_id"),
            project__workspace_id=F("workspace_id"),
        )
        .order_by("issue_id", "created_at", "id")
    )
    current_issue = None
    names = set()
    next_order = 0
    valid_slots = set()
    for asset in assets.iterator(chunk_size=1000):
        if current_issue != asset.issue_id:
            current_issue = asset.issue_id
            rows = list(
                Slot.objects.using(alias)
                .filter(
                    issue_id=asset.issue_id,
                    deleted_at__isnull=True,
                )
                .values("id", "name", "sort_order", "workspace_id", "project_id")
            )
            names = {row["name"].casefold() for row in rows}
            next_order = max((row["sort_order"] for row in rows), default=-1) + 1
            valid_slots = {
                row["id"]
                for row in rows
                if row["workspace_id"] == asset.workspace_id and row["project_id"] == asset.project_id
            }
        if asset.attachment_slot_id in valid_slots:
            continue
        number = 1
        name = "附件"
        while name.casefold() in names:
            number += 1
            name = f"附件{number}"
        # Preserve active files even if their historical slot was soft-deleted or
        # scoped incorrectly. Migration deliberately has no 50-row creation cap.
        row = Slot.objects.using(alias).create(
            issue_id=asset.issue_id,
            workspace_id=asset.workspace_id,
            project_id=asset.project_id,
            created_by_id=asset.created_by_id,
            updated_by_id=asset.updated_by_id,
            name=name,
            sort_order=next_order,
        )
        Asset.objects.using(alias).filter(pk=asset.pk).update(attachment_slot_id=row.id)
        valid_slots.add(row.id)
        names.add(name.casefold())
        next_order += 1


class Migration(migrations.Migration):
    dependencies = [("db", "0131_merge_gitea_attachments")]
    operations = [migrations.RunPython(unify_attachment_rows, migrations.RunPython.noop)]
