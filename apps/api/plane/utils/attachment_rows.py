# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""Shared row provisioning and completion for formal work item attachments.

Formal uploads and completion authorize the persisted issue under its row lock.
Provisioning is part of uploading; the issue lock serializes naming and the row cap.
"""

from django.db import transaction
from django.db.models import Max
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import APIException, PermissionDenied, ValidationError

from plane.db.models import FileAsset, Issue, IssueAttachmentSlot, User
from plane.utils.issue_permissions import has_project_admin_access, require_issue_write_access

MAX_ATTACHMENT_ROWS = 50


class AttachmentUploadUnavailable(APIException):
    status_code = 503
    default_detail = "Unable to prepare attachment upload. Please try again."


def presign_attachment_upload(storage, asset, file_type, size_limit):
    data = storage.generate_presigned_post(
        object_name=asset.asset.name,
        file_type=file_type,
        file_size=size_limit,
    )
    if not data:
        raise AttachmentUploadUnavailable()
    return data


def next_attachment_name(names):
    used = {name.casefold() for name in names}
    number = 1
    while True:
        name = "附件" if number == 1 else f"附件{number}"
        if name.casefold() not in used:
            return name
        number += 1


def lock_attachment_issue(workspace_id, project_id, issue_id):
    return get_object_or_404(
        Issue.objects.select_for_update(),
        pk=issue_id,
        is_draft=False,
        workspace_id=workspace_id,
        project_id=project_id,
        project__workspace_id=workspace_id,
        project__deleted_at__isnull=True,
        workspace__deleted_at__isnull=True,
    )


def provision_attachment_row(issue, creator_id):
    """The caller must hold the issue lock for this transaction."""
    rows = IssueAttachmentSlot.objects.filter(
        issue_id=issue.id,
        workspace_id=issue.workspace_id,
        project_id=issue.project_id,
    )
    if rows.count() >= MAX_ATTACHMENT_ROWS:
        raise ValidationError({"error": "A work item can have at most 50 attachment rows."})
    row = IssueAttachmentSlot(
        issue_id=issue.id,
        workspace_id=issue.workspace_id,
        project_id=issue.project_id,
        name=next_attachment_name(rows.values_list("name", flat=True)),
        sort_order=(rows.aggregate(value=Max("sort_order"))["value"] or 0) + 1,
        created_by_id=creator_id,
    )
    row.save(disable_auto_set_user=True)
    return row


def require_file_owner_or_admin(asset, user, message):
    if asset.created_by_id == user.id:
        return
    if has_project_admin_access(user, asset.project_id, asset.workspace_id):
        return
    raise PermissionDenied(message)


def is_work_item_attachment(asset):
    return bool(asset.attachment_slot_id or (
        asset.issue_id and asset.entity_type in (None, "", FileAsset.EntityTypeContext.ISSUE_ATTACHMENT)
    ))


def require_attachment_asset_write(asset, user):
    """Caller holds an atomic transaction; lock the issue before a bound asset."""
    if not is_work_item_attachment(asset):
        # Binding takes the same asset lock. If a concurrent bind already won,
        # retry instead of acquiring the issue lock in the reverse order.
        asset = get_object_or_404(FileAsset.objects.select_for_update(), pk=asset.pk)
        if is_work_item_attachment(asset):
            raise PermissionDenied("The attachment changed. Retry this request.")
        return asset
    issue = lock_attachment_issue(asset.workspace_id, asset.project_id, asset.issue_id)
    require_issue_write_access(user, issue)
    asset = get_object_or_404(
        FileAsset.objects.select_for_update(),
        pk=asset.pk, workspace_id=issue.workspace_id, project_id=issue.project_id,
        issue_id=issue.id, is_deleted=False,
    )
    require_file_owner_or_admin(asset, user, "Only the uploader or an admin can modify this attachment.")
    return asset


def require_replacement_permission(slot, user):
    for current in FileAsset.objects.filter(
        attachment_slot=slot,
        workspace_id=slot.workspace_id,
        project_id=slot.project_id,
        issue_id=slot.issue_id,
        entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
        is_uploaded=True,
        is_deleted=False,
    ):
        require_file_owner_or_admin(
            current,
            user,
            "Only the file uploader or a project admin can replace this attachment.",
        )


@transaction.atomic
def create_attachment_asset(*, reuse_pending=True, **kwargs):
    """Create any asset, provisioning a row only for a scoped formal attachment.

    HTTP callers wrap presigning in their outer transaction so storage failures
    roll back both the asset and its newly provisioned row.
    """
    if kwargs.get("entity_type") == FileAsset.EntityTypeContext.ISSUE_ATTACHMENT and kwargs.get("issue_id"):
        workspace_id = kwargs.get("workspace_id") or kwargs["workspace"].id
        issue = lock_attachment_issue(workspace_id, kwargs.get("project_id"), kwargs["issue_id"])
        creator_id = kwargs.get("created_by_id") or getattr(kwargs.get("created_by"), "id", None)
        user = kwargs.get("created_by") or get_object_or_404(User.objects, pk=creator_id)
        require_issue_write_access(user, issue)
        if not kwargs.get("attachment_slot"):
            # A retried presign for the same unconfirmed file reuses its row and ID.
            pending = (
                FileAsset.objects.filter(
                    workspace_id=issue.workspace_id,
                    project_id=issue.project_id,
                    issue_id=issue.id,
                    entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
                    created_by_id=creator_id,
                    attributes=kwargs.get("attributes", {}),
                    external_id=kwargs.get("external_id"),
                    external_source=kwargs.get("external_source"),
                    is_uploaded=False,
                    is_deleted=False,
                    attachment_slot__deleted_at__isnull=True,
                    attachment_slot__isnull=False,
                    attachment_slot__workspace_id=issue.workspace_id,
                    attachment_slot__project_id=issue.project_id,
                    attachment_slot__issue_id=issue.id,
                )
                .exclude(
                    attachment_slot_id__in=FileAsset.objects.filter(
                        issue_id=issue.id,
                        is_uploaded=True,
                        is_deleted=False,
                        attachment_slot__isnull=False,
                    ).values("attachment_slot_id")
                )
                .first()
            )
            if pending and reuse_pending:
                return pending
            kwargs["attachment_slot"] = provision_attachment_row(issue, creator_id)
    asset = FileAsset(**kwargs)
    asset.save(disable_auto_set_user=True)
    return asset


def attachment_slot_data(slot):
    return {"id": str(slot.id), "name": slot.name, "sort_order": slot.sort_order}


def attachment_completion_data(asset):
    return {
        "attachment_slot_id": str(asset.attachment_slot_id),
        "attachment_slot": attachment_slot_data(asset.attachment_slot),
        "deleted_attachment_ids": asset.deleted_attachment_ids,
    }


@transaction.atomic
def complete_attachment_asset(asset, user):
    """Complete once, retaining the replaced asset as a soft-deleted audit row."""
    issue = lock_attachment_issue(asset.workspace_id, asset.project_id, asset.issue_id)
    require_issue_write_access(user, issue)
    asset = get_object_or_404(
        FileAsset.objects.select_for_update(),
        pk=asset.pk,
        workspace_id=issue.workspace_id,
        project_id=issue.project_id,
        issue_id=issue.id,
        is_deleted=False,
        entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
    )
    require_file_owner_or_admin(asset, user, "Only the uploader or a project admin can complete this upload.")
    had_slot = bool(asset.attachment_slot_id)
    if asset.attachment_slot_id:
        slot = get_object_or_404(
            IssueAttachmentSlot.objects.select_for_update(),
            pk=asset.attachment_slot_id,
            workspace_id=issue.workspace_id,
            project_id=issue.project_id,
            issue_id=issue.id,
        )
    else:
        slot = provision_attachment_row(issue, asset.created_by_id)
    asset.attachment_slot = slot
    asset.deleted_attachment_ids = []
    if asset.is_uploaded:
        if not had_slot:
            asset.save(update_fields=["attachment_slot"], disable_auto_set_user=True)
        return asset, False
    require_replacement_permission(slot, user)
    replaced = FileAsset.objects.filter(
        attachment_slot=slot,
        workspace_id=issue.workspace_id,
        project_id=issue.project_id,
        issue_id=issue.id,
        entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
        is_uploaded=True,
        is_deleted=False,
    ).exclude(pk=asset.pk)
    asset.deleted_attachment_ids = [str(pk) for pk in replaced.values_list("pk", flat=True)]
    replaced.update(is_deleted=True, deleted_at=timezone.now())
    asset.is_uploaded = True
    asset.save(update_fields=["attachment_slot", "is_uploaded", "updated_at"], disable_auto_set_user=True)
    return asset, True
