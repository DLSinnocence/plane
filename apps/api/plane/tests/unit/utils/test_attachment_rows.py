# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from types import SimpleNamespace
from unittest import mock
from uuid import uuid4

import pytest
from rest_framework.exceptions import PermissionDenied, ValidationError

from plane.utils import attachment_rows as rows

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    "names,expected",
    [
        ([], "附件"),
        (["附件"], "附件2"),
        (["附件", "附件2", "附件4"], "附件3"),
        (["Proof", "", "附件2"], "附件"),
        (["附件"] + [f"附件{i}" for i in range(2, 80)], "附件80"),
    ],
)
def test_next_name_fills_first_available_default(names, expected):
    assert rows.next_attachment_name(names) == expected


@pytest.mark.parametrize("owner,admin,allowed", [(True, False, True), (False, True, True), (False, False, False)])
def test_replacement_requires_delete_permission(owner, admin, allowed):
    user = SimpleNamespace(id=uuid4())
    asset = SimpleNamespace(created_by_id=user.id if owner else uuid4(), workspace_id=uuid4(), project_id=uuid4())
    with mock.patch.object(rows, "has_project_admin_access", return_value=admin) as memberships:
        if allowed:
            rows.require_file_owner_or_admin(asset, user, "Denied")
        else:
            with pytest.raises(PermissionDenied, match="Denied"):
                rows.require_file_owner_or_admin(asset, user, "Denied")
        if not owner:
            memberships.assert_called_once_with(user, asset.project_id, asset.workspace_id)


def test_row_cap_prevents_new_creation_but_not_name_generation():
    issue = SimpleNamespace(id=uuid4(), workspace_id=uuid4(), project_id=uuid4())
    with (
        mock.patch.object(rows.IssueAttachmentSlot.objects, "filter") as query,
        mock.patch.object(rows.IssueAttachmentSlot.objects, "create") as create,
    ):
        query.return_value.count.return_value = 63
        with pytest.raises(ValidationError, match="at most 50"):
            rows.provision_attachment_row(issue, uuid4())
        create.assert_not_called()


@pytest.mark.parametrize("result", [None, {}])
def test_empty_presign_raises_instead_of_committing_phantom_row(result):
    storage = mock.Mock()
    storage.generate_presigned_post.return_value = result
    asset = SimpleNamespace(asset=SimpleNamespace(name="persisted/key.pdf"))
    with pytest.raises(rows.AttachmentUploadUnavailable) as error:
        rows.presign_attachment_upload(storage, asset, "application/pdf", 100)
    assert error.value.status_code == 503
    storage.generate_presigned_post.assert_called_once_with(
        object_name="persisted/key.pdf",
        file_type="application/pdf",
        file_size=100,
    )


def test_completion_soft_deletes_old_file_without_clearing_audit_link():
    user = SimpleNamespace(id=uuid4())
    issue = SimpleNamespace(id=uuid4(), workspace_id=uuid4(), project_id=uuid4())
    slot = SimpleNamespace(id=uuid4(), name="服务端名称", sort_order=7)
    asset = mock.Mock(
        pk=uuid4(),
        workspace_id=issue.workspace_id,
        project_id=issue.project_id,
        issue_id=issue.id,
        attachment_slot_id=slot.id,
        is_uploaded=False,
    )
    with (
        mock.patch.object(rows, "lock_attachment_issue", return_value=issue),
        mock.patch.object(rows, "require_issue_write_access"),
        mock.patch.object(rows, "get_object_or_404", side_effect=[asset, slot]),
        mock.patch.object(rows.FileAsset.objects, "select_for_update"),
        mock.patch.object(rows.IssueAttachmentSlot.objects, "select_for_update"),
        mock.patch.object(rows, "require_file_owner_or_admin") as uploader_permission,
        mock.patch.object(rows, "require_replacement_permission") as replace_permission,
        mock.patch.object(rows.FileAsset.objects, "filter") as old_files,
    ):
        deleted_id = uuid4()
        old_files.return_value.exclude.return_value.values_list.return_value = [deleted_id]
        result, completed = rows.complete_attachment_asset.__wrapped__(asset, user)
        assert rows.attachment_completion_data(result) == {
            "attachment_slot_id": str(slot.id), "deleted_attachment_ids": [str(deleted_id)],
            "attachment_slot": {"id": str(slot.id), "name": "服务端名称", "sort_order": 7},
        }
        assert completed and result.is_uploaded
        uploader_permission.assert_called_once()
        replace_permission.assert_called_once_with(slot, user)
        update = old_files.return_value.exclude.return_value.update.call_args.kwargs
        assert update["is_deleted"] is True and update["deleted_at"] is not None
        assert "attachment_slot" not in update
        assert old_files.call_args.kwargs["issue_id"] == issue.id
        assert old_files.call_args.kwargs["workspace_id"] == issue.workspace_id
        assert old_files.call_args.kwargs["project_id"] == issue.project_id


def test_repeat_completion_does_not_replace_or_publish_again():
    issue = SimpleNamespace(id=uuid4(), workspace_id=uuid4(), project_id=uuid4())
    asset = mock.Mock(
        pk=uuid4(),
        workspace_id=issue.workspace_id,
        project_id=issue.project_id,
        issue_id=issue.id,
        attachment_slot_id=uuid4(),
        is_uploaded=True,
    )
    slot = SimpleNamespace(id=asset.attachment_slot_id, name="改名后", sort_order=9)
    with (
        mock.patch.object(rows, "lock_attachment_issue", return_value=issue),
        mock.patch.object(rows, "require_issue_write_access"),
        mock.patch.object(rows, "get_object_or_404", side_effect=[asset, slot]),
        mock.patch.object(rows.FileAsset.objects, "select_for_update"),
        mock.patch.object(rows.IssueAttachmentSlot.objects, "select_for_update"),
        mock.patch.object(rows, "require_file_owner_or_admin"),
        mock.patch.object(rows, "require_replacement_permission") as permission,
        mock.patch.object(rows.FileAsset.objects, "filter") as old_files,
    ):
        assert rows.complete_attachment_asset.__wrapped__(asset, mock.Mock()) == (asset, False)
        assert rows.attachment_completion_data(asset) == {
            "attachment_slot_id": str(asset.attachment_slot_id), "deleted_attachment_ids": [],
            "attachment_slot": {"id": str(slot.id), "name": "改名后", "sort_order": 9},
        }
        old_files.assert_not_called()
        permission.assert_not_called()
        asset.save.assert_not_called()


@pytest.mark.parametrize("operation", ["create", "complete", "delete"])
def test_denied_issue_write_stops_before_any_attachment_mutation(operation):
    issue = SimpleNamespace(id=uuid4(), workspace_id=uuid4(), project_id=uuid4())
    user = SimpleNamespace(id=uuid4())
    asset = mock.Mock(
        issue_id=issue.id, project_id=issue.project_id, workspace_id=issue.workspace_id,
        entity_type=rows.FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
    )
    with (
        mock.patch.object(rows, "lock_attachment_issue", return_value=issue) as lock,
        mock.patch.object(rows, "require_issue_write_access", side_effect=PermissionDenied("Revoked")) as permission,
        mock.patch.object(rows, "provision_attachment_row") as provision,
        mock.patch.object(rows.FileAsset.objects, "select_for_update") as assets,
        mock.patch.object(rows.FileAsset.objects, "filter") as files,
    ):
        with pytest.raises(PermissionDenied, match="Revoked"):
            if operation == "create":
                rows.create_attachment_asset.__wrapped__(
                    workspace_id=issue.workspace_id, project_id=issue.project_id, issue_id=issue.id,
                    created_by=user, entity_type=rows.FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
                )
            elif operation == "complete":
                rows.complete_attachment_asset.__wrapped__(asset, user)
            else:
                rows.require_attachment_asset_write(asset, user)
        lock.assert_called_once_with(issue.workspace_id, issue.project_id, issue.id)
        permission.assert_called_once_with(user, issue)
        provision.assert_not_called()
        assets.assert_not_called()
        files.assert_not_called()
        asset.save.assert_not_called()


def test_generic_delete_rechecks_locked_file_owner():
    user = SimpleNamespace(id=uuid4())
    issue = SimpleNamespace(id=uuid4(), workspace_id=uuid4(), project_id=uuid4())
    stale = mock.Mock(issue_id=issue.id, project_id=issue.project_id, workspace_id=issue.workspace_id)
    persisted = mock.Mock(created_by_id=uuid4(), project_id=issue.project_id, workspace_id=issue.workspace_id)
    with (
        mock.patch.object(rows, "lock_attachment_issue", return_value=issue),
        mock.patch.object(rows, "require_issue_write_access"),
        mock.patch.object(rows.FileAsset.objects, "select_for_update"),
        mock.patch.object(rows, "get_object_or_404", return_value=persisted),
        mock.patch.object(rows, "has_project_admin_access", return_value=False),
    ):
        with pytest.raises(PermissionDenied):
            rows.require_attachment_asset_write(stale, user)
        persisted.save.assert_not_called()


def test_generic_write_rejects_concurrent_binding_before_mutation():
    stale = SimpleNamespace(pk=uuid4(), attachment_slot_id=None, issue_id=None, entity_type="ISSUE_ATTACHMENT")
    bound = SimpleNamespace(attachment_slot_id=uuid4(), issue_id=uuid4(), entity_type="ISSUE_ATTACHMENT")
    with (
        mock.patch.object(rows.FileAsset.objects, "select_for_update") as files,
        mock.patch.object(rows, "get_object_or_404", return_value=bound),
        mock.patch.object(rows, "lock_attachment_issue") as issue_lock,
    ):
        with pytest.raises(PermissionDenied, match="changed"):
            rows.require_attachment_asset_write(stale, mock.Mock())
        files.assert_called_once()
        # Never take asset -> issue locks, which would deadlock normal binding.
        issue_lock.assert_not_called()
