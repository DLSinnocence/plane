# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""Database contracts for unified rows; object storage is deliberately mocked."""

from importlib import import_module
from types import SimpleNamespace
from unittest import mock

import pytest
from django.apps import apps
from django.db import connection
from django.utils import timezone

from plane.db.models import FileAsset, Issue, IssueAttachmentSlot, Project, ProjectMember, User, WorkspaceMember

pytestmark = [pytest.mark.contract, pytest.mark.django_db]
VIEW = "plane.app.views.issue.attachment"


@pytest.fixture
def context(workspace, create_user, session_client, settings):
    settings.APP_BASE_URL = "https://plane.example.test"
    project = Project.objects.create(name="Unified", identifier="UNI", workspace=workspace)
    membership = ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=15)
    WorkspaceMember.objects.filter(workspace=workspace, member=create_user).update(role=15)
    issue = Issue.objects.create(workspace=workspace, project=project, name="Files")
    Issue.objects.filter(pk=issue.pk).update(created_by=create_user)
    issue.refresh_from_db()
    base = f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/issues/{issue.id}/attachments/"
    with (
        mock.patch(f"{VIEW}.S3Storage") as storage,
        mock.patch(f"{VIEW}.issue_activity.delay"),
        mock.patch(f"{VIEW}.get_asset_object_metadata.delay"),
    ):
        storage.return_value.generate_presigned_post.return_value = {"url": "https://upload.invalid", "fields": {}}
        yield SimpleNamespace(
            workspace=workspace,
            project=project,
            issue=issue,
            user=create_user,
            client=session_client,
            membership=membership,
            url=base,
            storage=storage,
        )


def post(context, name="proof.pdf", slot_id=None):
    data = {"name": name, "type": "application/pdf", "size": 1024}
    if slot_id:
        data["slot_id"] = str(slot_id)
    return context.client.post(context.url, data, format="json")


@pytest.mark.parametrize("role", [5, 15, 20])
def test_direct_upload_requires_formal_write_role(context, role):
    ProjectMember.objects.filter(pk=context.membership.pk).update(role=role)
    WorkspaceMember.objects.filter(workspace=context.workspace, member=context.user).update(role=role)
    response = post(context)
    if role == 5:
        assert response.status_code == 403
        assert not FileAsset.objects.filter(issue=context.issue).exists()
        return
    assert response.status_code == 200, response.data
    asset = FileAsset.objects.get(pk=response.data["asset_id"])
    assert asset.attachment_slot.name == "附件"
    assert str(asset.attachment_slot_id) == str(response.data["attachment_slot_id"])
    assert str(asset.attachment_slot_id) == str(response.data["attachment"]["attachment_slot_id"])
    assert context.client.patch(context.url + str(asset.id) + "/", {}, format="json").status_code == 200
    asset.refresh_from_db()
    assert asset.is_uploaded


def test_upload_response_has_real_row_without_fetching_slot_list(context):
    IssueAttachmentSlot.objects.create(
        workspace=context.workspace, project=context.project, issue=context.issue,
        name="附件", sort_order=8,
    )
    pending = post(context)
    assert pending.status_code == 200
    slot_id = pending.data["attachment_slot_id"]
    assert pending.data["attachment_slot"] == {"id": slot_id, "name": "附件2", "sort_order": 9}
    # The row may be renamed by another request while the object upload runs.
    IssueAttachmentSlot.objects.filter(pk=slot_id).update(name="最终附件名称", sort_order=12)
    detail = context.url + pending.data["asset_id"] + "/"
    completed = context.client.patch(detail, {}, format="json")
    assert completed.status_code == 200
    assert completed.data == {
        "attachment_slot_id": slot_id, "deleted_attachment_ids": [],
        "attachment_slot": {"id": slot_id, "name": "最终附件名称", "sort_order": 12},
    }
    repeated = context.client.patch(detail, {}, format="json")
    assert repeated.status_code == 200 and repeated.data == completed.data


def test_retry_pending_presign_reuses_row_and_original_key(context):
    first, repeated = post(context), post(context)
    assert first.status_code == repeated.status_code == 200
    assert first.data["asset_id"] == repeated.data["asset_id"]
    assert IssueAttachmentSlot.objects.filter(issue=context.issue).count() == 1
    keys = [call.kwargs["object_name"] for call in context.storage.return_value.generate_presigned_post.call_args_list]
    assert keys[0] == keys[1]


@pytest.mark.parametrize("raises", [True, False])
def test_failed_presign_rolls_back_asset_and_row(context, raises):
    method = context.storage.return_value.generate_presigned_post
    if raises:
        method.side_effect = RuntimeError("Storage offline")
        # BaseAPIView translates unexpected storage errors into an HTTP 500.
        response = post(context)
        assert response.status_code == 500
        assert response.data == {"error": "Something went wrong please try again later"}
    else:
        method.return_value = None
        assert post(context).status_code == 503
    assert not FileAsset.objects.filter(issue=context.issue).exists()
    assert not IssueAttachmentSlot.objects.filter(issue=context.issue).exists()


def test_new_rows_cannot_bypass_limit_but_empty_existing_row_can_upload(context):
    for number in range(50):
        IssueAttachmentSlot.objects.create(
            workspace=context.workspace,
            project=context.project,
            issue=context.issue,
            name=f"Row {number}",
        )
    assert post(context).status_code == 400
    slot = IssueAttachmentSlot.objects.filter(issue=context.issue).first()
    assert post(context, slot_id=slot.id).status_code == 200
    assert IssueAttachmentSlot.objects.filter(issue=context.issue).count() == 50


def test_replacement_deletes_old_file_and_cannot_revive_it(context):
    first = post(context).data
    first_url = context.url + first["asset_id"] + "/"
    assert context.client.patch(first_url, {}, format="json").status_code == 200
    second = post(context, name="new.pdf", slot_id=first["attachment_slot_id"]).data
    old = FileAsset.objects.get(pk=first["asset_id"])
    assert old.is_uploaded and not old.is_deleted
    second_url = context.url + second["asset_id"] + "/"
    assert context.client.patch(second_url, {}, format="json").status_code == 200
    old = FileAsset.all_objects.get(pk=old.pk)
    assert old.is_deleted and old.deleted_at
    assert str(old.attachment_slot_id) == first["attachment_slot_id"]
    assert context.client.patch(first_url, {}, format="json").status_code == 404
    assert context.client.patch(second_url, {}, format="json").status_code == 200


def test_replacement_rechecks_current_owner_at_completion(context):
    first = post(context).data
    assert context.client.patch(context.url + first["asset_id"] + "/", {}, format="json").status_code == 200
    pending = post(context, name="replacement.pdf", slot_id=first["attachment_slot_id"]).data
    other = User.objects.create(email="other-file-owner@example.test", username="other-file-owner")
    FileAsset.objects.filter(pk=first["asset_id"]).update(created_by=other)
    assert post(context, name="third.pdf", slot_id=first["attachment_slot_id"]).status_code == 403
    assert context.client.patch(context.url + pending["asset_id"] + "/", {}, format="json").status_code == 403
    assert FileAsset.objects.get(pk=first["asset_id"]).is_uploaded
    assert not FileAsset.objects.get(pk=pending["asset_id"]).is_uploaded


def test_migration_preserves_over_50_files_and_rehomes_deleted_rows(context):
    def asset(**changes):
        data = dict(
            workspace=context.workspace,
            project=context.project,
            issue=context.issue,
            created_by=context.user,
            entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
            is_uploaded=True,
            asset="original/path.pdf",
        )
        data.update(changes)
        return FileAsset.objects.create(**data)

    kept_slot = IssueAttachmentSlot.objects.create(
        workspace=context.workspace,
        project=context.project,
        issue=context.issue,
        name="附件",
    )
    kept = asset(attachment_slot=kept_slot)
    deleted_slot = IssueAttachmentSlot.objects.create(
        workspace=context.workspace,
        project=context.project,
        issue=context.issue,
        name="Old row",
    )
    deleted_slot.deleted_at = timezone.now()
    deleted_slot.save()
    orphaned = asset(attachment_slot=deleted_slot)
    files = [asset() for _ in range(55)] + [kept, orphaned]
    other_project = Project.objects.create(name="Other scope", identifier="OTH", workspace=context.workspace)
    other_issue = Issue.objects.create(workspace=context.workspace, project=other_project, name="Other")
    draft = Issue.objects.create(workspace=context.workspace, project=context.project, name="Draft", is_draft=True)
    excluded = [
        asset(issue=other_issue),
        asset(issue=draft),
        asset(is_uploaded=False),
        asset(is_deleted=True),
        asset(entity_type=FileAsset.EntityTypeContext.ISSUE_DESCRIPTION),
        asset(issue=None),
    ]
    before = {item.id: (item.asset.name, item.created_by_id, item.asset_url) for item in files}
    migration = import_module("plane.db.migrations.0132_unify_issue_attachment_rows")
    migration.unify_attachment_rows(apps, SimpleNamespace(connection=connection))
    assert IssueAttachmentSlot.objects.filter(issue=context.issue).count() == 57
    for item in files:
        item.refresh_from_db()
        assert item.attachment_slot_id
        assert (item.asset.name, item.created_by_id, item.asset_url) == before[item.id]
    kept.refresh_from_db()
    assert kept.attachment_slot_id == kept_slot.id
    orphaned.refresh_from_db()
    assert orphaned.attachment_slot_id != deleted_slot.id and not orphaned.is_deleted
    for item in excluded:
        item.refresh_from_db()
        assert item.attachment_slot_id is None
    migration.unify_attachment_rows(apps, SimpleNamespace(connection=connection))
    assert IssueAttachmentSlot.objects.filter(issue=context.issue).count() == 57
