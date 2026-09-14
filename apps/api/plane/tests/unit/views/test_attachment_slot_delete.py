# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Run endpoint deletion decisions without a database; contracts cover transactions."""

from types import SimpleNamespace
from unittest import mock
from uuid import uuid4

import pytest
from rest_framework.exceptions import PermissionDenied

from plane.app.views import attachment as views

pytestmark = pytest.mark.unit


@pytest.fixture
def deletion():
    user = SimpleNamespace(id=uuid4())
    request = SimpleNamespace(user=user)
    issue = SimpleNamespace(id=uuid4(), project_id=uuid4(), workspace_id=uuid4())
    slot = SimpleNamespace(id=uuid4())
    slot.pk = slot.id
    files = mock.MagicMock()
    slots = mock.MagicMock()
    with (
        mock.patch.object(views, "require_slot_role") as role,
        mock.patch.object(views, "scoped_issue", return_value=issue) as lookup,
        mock.patch.object(views, "scoped_slots", return_value=slots),
        mock.patch.object(views, "get_object_or_404", return_value=slot),
        mock.patch.object(views.FileAsset.objects, "select_for_update") as locked_files,
        mock.patch.object(views.IssueAttachmentSlot.objects, "filter") as slot_update,
        mock.patch.object(views.ProjectMember.objects, "filter") as members,
        mock.patch.object(views.transaction, "on_commit") as on_commit,
        mock.patch.object(views.issue_activity, "delay") as activity,
        mock.patch.object(views, "base_host", return_value="https://plane.test"),
    ):
        locked_files.return_value.filter.return_value = files
        members.return_value.exists.return_value = False
        yield SimpleNamespace(
            user=user,
            request=request,
            issue=issue,
            slot=slot,
            files=files,
            role=role,
            lookup=lookup,
            locked_files=locked_files,
            slot_update=slot_update,
            members=members,
            on_commit=on_commit,
            activity=activity,
        )


def call_delete(context):
    # Only remove atomic's DB wrapper: run the actual endpoint body and decisions.
    return views.IssueAttachmentSlotEndpoint.delete.__wrapped__(
        views.IssueAttachmentSlotEndpoint(),
        context.request,
        "workspace",
        context.issue.project_id,
        context.issue.id,
        context.slot.id,
    )


@pytest.mark.parametrize(
    "owners,admin,allowed",
    [
        ([], False, True),
        (["self"], False, True),
        (["self", "self"], False, True),
        (["other"], False, False),
        (["self", "other"], False, False),
        (["other", "self"], False, False),
        (["self", "other"], True, True),
        (["other", "other"], True, True),
    ],
)
def test_delete_authorizes_entire_set_before_mutations(deletion, owners, admin, allowed):
    context = deletion
    assets = [
        SimpleNamespace(
            id=uuid4(), created_by_id=context.user.id if owner == "self" else uuid4(), is_uploaded=index == 0
        )
        for index, owner in enumerate(owners)
    ]
    context.files.__iter__.return_value = iter(assets)
    context.members.return_value.exists.return_value = admin
    if not allowed:
        with pytest.raises(PermissionDenied):
            call_delete(context)
        context.files.filter.assert_not_called()
        context.files.update.assert_not_called()
        context.slot_update.assert_not_called()
        context.on_commit.assert_not_called()
        return

    response = call_delete(context)
    assert response.status_code == 200
    assert response.data == {
        "slot_id": str(context.slot.id),
        "deleted_attachment_ids": [str(asset.id) for asset in assets],
    }
    context.role.assert_called_once_with(context.request, "workspace", context.issue.project_id, write=True)
    context.lookup.assert_called_once_with("workspace", context.issue.project_id, context.issue.id, lock=True)
    context.locked_files.return_value.filter.assert_called_once_with(
        attachment_slot=context.slot,
        workspace_id=context.issue.workspace_id,
        project_id=context.issue.project_id,
        issue_id=context.issue.id,
        entity_type=views.FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
        is_deleted=False,
    )
    context.files.filter.assert_called_once_with(pk__in=[str(asset.id) for asset in assets])
    update = context.files.filter.return_value.update.call_args.kwargs
    assert update == {"is_deleted": True, "deleted_at": mock.ANY}
    context.slot_update.return_value.update.assert_called_once_with(deleted_at=update["deleted_at"])
    if "other" in owners:
        context.members.assert_called_once_with(
            workspace_id=context.issue.workspace_id,
            project_id=context.issue.project_id,
            member=context.user,
            is_active=True,
            role=views.ROLE.ADMIN.value,
        )
    else:
        context.members.assert_not_called()
    context.activity.assert_not_called()
    assert context.on_commit.call_count == len(assets)
    for callback in context.on_commit.call_args_list:
        assert callback.kwargs == {"robust": True}
        callback.args[0]()
    assert context.activity.call_count == len(assets)
    if assets:
        assert context.activity.call_args.kwargs["type"] == "attachment.activity.deleted"


def test_slot_write_denial_never_reads_or_mutates_files(deletion):
    deletion.role.side_effect = PermissionDenied("No slot write access")
    with pytest.raises(PermissionDenied):
        call_delete(deletion)
    deletion.lookup.assert_not_called()
    deletion.locked_files.assert_not_called()
    deletion.slot_update.assert_not_called()


def test_late_completion_rejects_missing_active_asset_before_storage_or_activity():
    from django.http import Http404
    from plane.app.views.issue import attachment as issue_views

    request = SimpleNamespace(user=SimpleNamespace(id=uuid4()))
    project_id, issue_id, asset_id = uuid4(), uuid4(), uuid4()
    with (
        mock.patch.object(issue_views, "require_slot_role"),
        mock.patch.object(issue_views, "scoped_issue") as issue_lookup,
        mock.patch.object(issue_views.FileAsset.objects, "select_for_update") as assets,
        mock.patch.object(issue_views, "get_object_or_404", side_effect=Http404) as lookup,
        mock.patch.object(issue_views.transaction, "on_commit") as on_commit,
        mock.patch.object(issue_views, "S3Storage") as storage,
    ):
        with pytest.raises(Http404):
            issue_views.IssueAttachmentV2Endpoint.patch.__wrapped__.__wrapped__(
                issue_views.IssueAttachmentV2Endpoint(),
                request,
                "workspace",
                project_id,
                issue_id,
                asset_id,
            )
    issue_lookup.assert_called_once_with("workspace", project_id, issue_id, lock=True)
    lookup.assert_called_once_with(
        assets.return_value,
        pk=asset_id,
        workspace__slug="workspace",
        project_id=project_id,
        issue_id=issue_id,
        is_deleted=False,
        entity_type=views.FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
    )
    on_commit.assert_not_called()
    storage.assert_not_called()


def test_database_update_failure_does_not_publish_activity(deletion):
    deletion.files.__iter__.return_value = iter([SimpleNamespace(id=uuid4(), created_by_id=deletion.user.id)])
    deletion.slot_update.return_value.update.side_effect = RuntimeError("database failed")
    with pytest.raises(RuntimeError, match="database failed"):
        call_delete(deletion)
    deletion.on_commit.assert_not_called()
    deletion.activity.assert_not_called()
