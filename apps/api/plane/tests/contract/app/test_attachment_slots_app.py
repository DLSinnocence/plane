# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Real app API coverage for shared templates and atomic attachment replacement."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import mock
from uuid import uuid4

import pytest
from django.db import IntegrityError, transaction, connection, close_old_connections
from rest_framework.test import APIClient

from plane.db.models import (
    AttachmentTemplate,
    FileAsset,
    Issue,
    IssueAttachmentSlot,
    Project,
    ProjectMember,
    User,
    Workspace,
    WorkspaceMember,
)

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def attachment_context(workspace, create_user, session_client, settings):
    settings.APP_BASE_URL = "https://plane.example.test"
    with (
        mock.patch("plane.app.views.issue.attachment.issue_activity.delay"),
        mock.patch("plane.app.views.issue.attachment.get_asset_object_metadata.delay"),
    ):
        project = Project.objects.create(name="Attachments", identifier="ATT", workspace=workspace)
        membership = ProjectMember.objects.create(project=project, workspace=workspace, member=create_user, role=15)
        WorkspaceMember.objects.filter(workspace=workspace, member=create_user).update(role=15)
        issue = Issue.objects.create(name="Attach files", project=project, workspace=workspace)
        Issue.objects.filter(pk=issue.pk).update(created_by=create_user)
        issue.refresh_from_db()
        yield session_client, workspace, project, issue, membership


def urls(context):
    _, workspace, project, issue, _ = context
    base = f"/api/workspaces/{workspace.slug}/projects/{project.id}/issues/{issue.id}"
    return (
        f"/api/workspaces/{workspace.slug}/attachment-templates/",
        base + "/attachment-slots/",
        base.replace("/api/", "/api/assets/v2/") + "/attachments/",
    )


def create_slot(context, name="Design"):
    response = context[0].post(urls(context)[1], {"name": name}, format="json")
    assert response.status_code == 201, response.data
    return response.data


def upload(context, slot_id=None):
    data = {"name": "proof.pdf", "type": "application/pdf", "size": 1024}
    if slot_id is not None:
        data["slot_id"] = slot_id
    with mock.patch("plane.app.views.issue.attachment.S3Storage") as storage:
        storage.return_value.generate_presigned_post.return_value = {"url": "https://upload.invalid", "fields": {}}
        response = context[0].post(urls(context)[2], data, format="json")
    assert response.status_code == 200, response.data
    return response.data["asset_id"]


def test_template_crud_trim_conflicts_and_scope(attachment_context):
    client, workspace, _, _, _ = attachment_context
    templates, _, _ = urls(attachment_context)
    response = client.post(templates, {"name": "  Review  ", "slots": [" Proof ", "Report"]}, format="json")
    assert response.status_code == 201, response.data
    template = response.data
    assert template["name"] == "Review" and template["slots"] == ["Proof", "Report"]
    assert template["created_by"] is not None
    assert len(client.get(templates).data) == 1
    assert client.post(templates, {"name": "review", "slots": ["A"]}, format="json").status_code == 400
    detail = templates + str(template["id"]) + "/"
    assert client.patch(detail, {"name": " New ", "slots": ["B"]}, format="json").data["name"] == "New"
    other = Workspace.objects.create(name="Other", slug="other", owner=workspace.owner)
    foreign = AttachmentTemplate.objects.create(workspace=other, name="Foreign", slots=["X"])
    assert client.patch(templates + str(foreign.id) + "/", {"name": "Stolen"}, format="json").status_code == 404
    assert client.delete(detail).status_code == 204
    assert client.get(templates).data == []


@pytest.mark.parametrize(
    "payload",
    [
        {"name": " ", "slots": ["A"]},
        {"name": 123, "slots": ["A"]},
        {"name": "x" * 101, "slots": ["A"]},
        {"name": "X", "slots": []},
        {"name": "X", "slots": ["A", " a "]},
        {"name": "X", "slots": [" "]},
        {"name": "X", "slots": [str(i) for i in range(51)]},
        {"name": "X", "slots": [None]},
    ],
)
def test_invalid_templates(attachment_context, payload):
    assert attachment_context[0].post(urls(attachment_context)[0], payload, format="json").status_code == 400


def test_guest_and_inactive_permissions(attachment_context):
    client, workspace, _, _, membership = attachment_context
    templates, slots, _ = urls(attachment_context)
    membership.role = 5
    membership.save()
    WorkspaceMember.objects.filter(workspace=workspace, member=membership.member).update(role=5)
    assert client.get(templates).status_code == 403
    assert client.post(templates, {"name": "X", "slots": ["X"]}, format="json").status_code == 403
    assert client.get(slots).status_code == 200
    assert client.post(slots, {"name": "X"}, format="json").status_code == 403
    assert client.post(slots + "apply-template/", {"template_id": str(uuid4())}, format="json").status_code == 403
    membership.is_active = False
    membership.save()
    assert client.get(slots).status_code == 403


@pytest.mark.parametrize(
    "revocation", ["inactive_membership", "deleted_membership", "inactive_user", "deleted_workspace"]
)
def test_workspace_revocation_denies_slots_and_templates(attachment_context, revocation):
    from django.utils import timezone

    client, workspace, _, _, membership = attachment_context
    templates, slots, assets = urls(attachment_context)
    template = client.post(templates, {"name": "Review", "slots": ["Proof"]}, format="json").data
    slot = create_slot(attachment_context)
    pending = upload(attachment_context, slot["id"])
    workspace_members = WorkspaceMember.objects.filter(workspace=workspace, member=membership.member)
    if revocation == "inactive_membership":
        workspace_members.update(is_active=False)
    elif revocation == "deleted_membership":
        workspace_members.update(deleted_at=timezone.now())
    elif revocation == "inactive_user":
        User.objects.filter(pk=membership.member_id).update(is_active=False)
    else:
        Workspace.objects.filter(pk=workspace.pk).update(deleted_at=timezone.now())
    assert ProjectMember.objects.filter(pk=membership.pk, is_active=True).exists()
    detail = slots + str(slot["id"]) + "/"
    assert client.get(slots).status_code == 403
    assert client.post(slots, {"name": "Denied"}, format="json").status_code == 403
    assert client.patch(detail, {"name": "Denied"}, format="json").status_code == 403
    assert client.delete(detail).status_code == 403
    assert client.post(slots + "apply-template/", {"template_id": template["id"]}, format="json").status_code == 403
    assert (
        client.post(
            assets, {"name": "x.pdf", "type": "application/pdf", "size": 100, "slot_id": slot["id"]}, format="json"
        ).status_code
        == 403
    )
    assert client.patch(assets + pending + "/", {}, format="json").status_code == 403
    assert client.get(templates).status_code == 403
    assert client.post(templates, {"name": "Denied", "slots": ["A"]}, format="json").status_code == 403
    template_detail = templates + str(template["id"]) + "/"
    assert client.patch(template_detail, {"name": "Denied"}, format="json").status_code == 403
    assert client.delete(template_detail).status_code == 403
    assert not FileAsset.objects.get(pk=pending).is_uploaded
    assert IssueAttachmentSlot.objects.filter(pk=slot["id"], name=slot["name"]).exists()


def test_slots_rename_apply_append_and_scope(attachment_context):
    client, workspace, project, issue, _ = attachment_context
    templates, slots, _ = urls(attachment_context)
    first = create_slot(attachment_context, " Existing ")
    assert first["name"] == "Existing" and first["attachment"] is None
    assert client.post(slots, {"name": "existing"}, format="json").status_code == 400
    template = client.post(templates, {"name": "Set", "slots": ["EXISTING", "Proof", "Report"]}, format="json").data
    applied = client.post(slots + "apply-template/", {"template_id": template["id"]}, format="json")
    assert applied.status_code == 200, applied.data
    assert [row["name"] for row in applied.data] == ["Existing", "Proof", "Report"]
    repeated = client.post(slots + "apply-template/", {"template_id": template["id"]}, format="json")
    assert repeated.data == applied.data
    detail = slots + str(first["id"]) + "/"
    assert client.patch(detail, {"name": "proof"}, format="json").status_code == 400
    assert client.patch(detail, {"name": " Renamed "}, format="json").data["name"] == "Renamed"
    other_issue = Issue.objects.create(name="Other", project=project, workspace=workspace)
    foreign_slot = IssueAttachmentSlot.objects.create(
        name="Foreign", issue=other_issue, project=project, workspace=workspace
    )
    assert client.delete(slots + str(foreign_slot.id) + "/").status_code == 404
    other_workspace = Workspace.objects.create(name="Other", slug="foreign", owner=workspace.owner)
    foreign_template = AttachmentTemplate.objects.create(name="Foreign", slots=["X"], workspace=other_workspace)
    assert (
        client.post(slots + "apply-template/", {"template_id": str(foreign_template.id)}, format="json").status_code
        == 404
    )
    mismatched_url = slots.replace(str(issue.id), str(uuid4()))
    assert client.get(mismatched_url).status_code == 404
    response = client.delete(detail)
    assert response.status_code == 200
    assert response.data == {"slot_id": str(first["id"]), "deleted_attachment_ids": []}


def test_template_edits_do_not_retroactively_change_applied_slots(attachment_context):
    client = attachment_context[0]
    templates, slots, assets = urls(attachment_context)
    response = client.post(templates, {"name": "Review", "slots": ["Proof", "Report"]}, format="json")
    assert response.status_code == 201, response.data
    template = response.data
    apply_url = slots + "apply-template/"
    applied = client.post(apply_url, {"template_id": template["id"]}, format="json")
    assert applied.status_code == 200, applied.data
    proof = applied.data[0]
    asset_id = upload(attachment_context, proof["id"])
    assert client.patch(assets + asset_id + "/", {}, format="json").status_code == 200
    original = client.get(slots).data
    assert str(original[0]["attachment"]["attachment_slot_id"]) == str(proof["id"])
    assert original[1]["attachment"] is None

    detail = templates + str(template["id"]) + "/"
    changed = client.patch(detail, {"name": "Revised review", "slots": ["REPORT", "Approval"]}, format="json")
    assert changed.status_code == 200, changed.data
    assert client.get(slots).data == original

    # Explicit reapplication appends new names; removed/renamed template entries
    # never rename or remove the issue's existing slots or their completed files.
    reapplied = client.post(apply_url, {"template_id": template["id"]}, format="json")
    assert reapplied.status_code == 200, reapplied.data
    assert reapplied.data[:2] == original
    assert [row["name"] for row in reapplied.data] == ["Proof", "Report", "Approval"]
    assert reapplied.data[2]["attachment"] is None
    assert client.post(apply_url, {"template_id": template["id"]}, format="json").data == reapplied.data
    assert client.delete(detail).status_code == 204
    assert client.get(slots).data == reapplied.data


def test_cross_issue_slot_id_rejected_before_creating_upload(attachment_context):
    client, workspace, project, _, membership = attachment_context
    _, _, assets = urls(attachment_context)
    other_issue = Issue.objects.create(name="Other issue", workspace=workspace, project=project)
    Issue.objects.filter(pk=other_issue.pk).update(created_by=membership.member)
    other_context = client, workspace, project, other_issue, membership
    foreign_slot = create_slot(other_context)
    existing_id = upload(other_context, foreign_slot["id"])
    other_assets = urls(other_context)[2]
    assert client.patch(other_assets + existing_id + "/", {}, format="json").status_code == 200
    original = client.get(urls(other_context)[1]).data
    before = FileAsset.objects.count()
    with mock.patch("plane.app.views.issue.attachment.S3Storage") as storage:
        response = client.post(
            assets,
            {
                "name": "wrong-issue.pdf",
                "type": "application/pdf",
                "size": 100,
                "slot_id": foreign_slot["id"],
            },
            format="json",
        )
    assert response.status_code == 404, response.data
    storage.assert_not_called()
    assert FileAsset.objects.count() == before
    assert client.get(urls(other_context)[1]).data == original
    assert client.get(urls(attachment_context)[1]).data == []
    # The same asset ID cannot be completed through a different issue URL either.
    assert client.patch(assets + existing_id + "/", {}, format="json").status_code == 404


def test_slot_limit_is_atomic(attachment_context):
    client, workspace, project, issue, _ = attachment_context
    templates, slots, _ = urls(attachment_context)
    for i in range(49):
        IssueAttachmentSlot.objects.create(name=str(i), sort_order=i, issue=issue, project=project, workspace=workspace)
    template = client.post(templates, {"name": "Too many", "slots": ["New", "Other"]}, format="json").data
    assert client.post(slots + "apply-template/", {"template_id": template["id"]}, format="json").status_code == 400
    assert len(client.get(slots).data) == 49
    create_slot(attachment_context)
    assert client.post(slots, {"name": "Overflow"}, format="json").status_code == 400


def test_two_phase_replace_retry_delete_and_direct_upload_rows(attachment_context):
    client = attachment_context[0]
    _, slots, assets = urls(attachment_context)
    slot = create_slot(attachment_context)
    first = upload(attachment_context, slot["id"])
    assert client.get(slots).data[0]["attachment"] is None
    first_complete = client.patch(assets + first + "/", {}, format="json")
    assert first_complete.status_code == 200
    assert first_complete.data == {
        "attachment_slot_id": str(slot["id"]), "deleted_attachment_ids": [],
        "attachment_slot": {"id": str(slot["id"]), "name": slot["name"], "sort_order": slot["sort_order"]},
    }
    assert str(client.get(slots).data[0]["attachment"]["id"]) == first
    second = upload(attachment_context, slot["id"])
    # A pending/failed storage upload cannot displace the completed file.
    assert str(client.get(slots).data[0]["attachment"]["id"]) == first
    replaced = client.patch(assets + second + "/", {}, format="json")
    assert replaced.status_code == 200
    assert replaced.data == {
        "attachment_slot_id": str(slot["id"]), "deleted_attachment_ids": [first],
        "attachment_slot": {"id": str(slot["id"]), "name": slot["name"], "sort_order": slot["sort_order"]},
    }
    assert client.patch(assets + first + "/", {}, format="json").status_code == 404
    repeated = client.patch(assets + second + "/", {}, format="json")
    assert repeated.status_code == 200 and repeated.data["deleted_attachment_ids"] == []
    assert str(client.get(slots).data[0]["attachment"]["id"]) == second
    old = FileAsset.all_objects.get(pk=first)
    assert old.is_deleted and old.deleted_at and str(old.attachment_slot_id) == str(slot["id"])
    assert len(client.get(assets).data) == 1
    assert client.delete(assets + second + "/").status_code == 204
    assert client.get(slots).data[0]["attachment"] is None
    third = upload(attachment_context, slot["id"])
    response = client.delete(slots + str(slot["id"]) + "/")
    assert response.status_code == 200
    assert response.data == {"slot_id": str(slot["id"]), "deleted_attachment_ids": [third]}
    assert FileAsset.all_objects.get(pk=third).is_deleted
    assert FileAsset.all_objects.get(pk=first).is_deleted
    assert client.patch(assets + third + "/", {}, format="json").status_code == 404
    direct = upload(attachment_context)
    assert client.patch(assets + direct + "/", {}, format="json").status_code == 200
    assert {str(row["id"]) for row in client.get(assets).data} == {direct}
    assert FileAsset.objects.get(pk=direct).attachment_slot.name == "附件"


@pytest.mark.django_db(transaction=True)
def test_completion_survives_broker_failure_after_commit(attachment_context, caplog):
    client = attachment_context[0]
    _, slots, assets = urls(attachment_context)
    slot = create_slot(attachment_context)
    previous = upload(attachment_context, slot["id"])
    assert client.patch(assets + previous + "/", {}, format="json").status_code == 200
    replacement = upload(attachment_context, slot["id"])

    with (
        mock.patch(
            "plane.app.views.issue.attachment.issue_activity.delay",
            side_effect=RuntimeError("activity broker unavailable"),
        ) as activity,
        mock.patch(
            "plane.app.views.issue.attachment.get_asset_object_metadata.delay",
            side_effect=RuntimeError("metadata broker unavailable"),
        ) as metadata,
        caplog.at_level("ERROR", logger="django.db.backends.base"),
    ):
        # transaction=True executes the callbacks during the request's real commit.
        response = client.patch(assets + replacement + "/", {}, format="json")
        assert response.status_code == 200, response.data
        assert response.data["deleted_attachment_ids"] == [previous]
        current = FileAsset.objects.get(pk=replacement)
        assert current.is_uploaded and str(current.attachment_slot_id) == str(slot["id"])
        old = FileAsset.all_objects.get(pk=previous)
        assert old.is_deleted and old.deleted_at and str(old.attachment_slot_id) == str(slot["id"])
        assert str(client.get(slots).data[0]["attachment"]["id"]) == replacement
        activity.assert_called_once()
        metadata.assert_called_once_with(replacement)
        assert "activity broker unavailable" in caplog.text
        assert "metadata broker unavailable" in caplog.text

        assert client.patch(assets + replacement + "/", {}, format="json").status_code == 200
        assert client.patch(assets + previous + "/", {}, format="json").status_code == 404
        activity.assert_called_once()
        metadata.assert_called_once()
        assert str(client.get(slots).data[0]["attachment"]["id"]) == replacement


def test_completion_permissions_and_generic_bypass(attachment_context):
    _, workspace, project, _, _ = attachment_context
    _, _, assets = urls(attachment_context)
    slot = create_slot(attachment_context)
    asset_id = upload(attachment_context, slot["id"])
    outsider = User.objects.create(email="another@example.com", username="another")
    WorkspaceMember.objects.create(workspace=workspace, member=outsider, role=15)
    member = ProjectMember.objects.create(workspace=workspace, project=project, member=outsider, role=15)
    second_client = APIClient()
    second_client.force_authenticate(user=outsider)
    assert second_client.patch(assets + asset_id + "/", {}, format="json").status_code == 403
    generic = f"/api/assets/v2/workspaces/{workspace.slug}/{asset_id}/"
    assert second_client.patch(generic, {}, format="json").status_code == 403
    assert not FileAsset.objects.get(pk=asset_id).is_uploaded
    member.role = 20
    member.save()
    assert second_client.patch(assets + asset_id + "/", {}, format="json").status_code == 200


def test_upload_scope_and_failed_presign_preserve_current(attachment_context):
    client, workspace, project, _, _ = attachment_context
    _, slots, assets = urls(attachment_context)
    slot = create_slot(attachment_context)
    asset_id = upload(attachment_context, slot["id"])
    client.patch(assets + asset_id + "/", {}, format="json")
    other_issue = Issue.objects.create(name="Other", workspace=workspace, project=project)
    foreign = IssueAttachmentSlot.objects.create(name="Other", workspace=workspace, project=project, issue=other_issue)
    data = {"name": "x.pdf", "type": "application/pdf", "size": 100, "slot_id": str(foreign.id)}
    assert client.post(assets, data, format="json").status_code == 404
    data["slot_id"] = "bad-uuid"
    assert client.post(assets, data, format="json").status_code == 400
    data["slot_id"] = slot["id"]
    before = FileAsset.objects.count()
    with mock.patch("plane.app.views.issue.attachment.S3Storage") as storage:
        storage.return_value.generate_presigned_post.side_effect = RuntimeError("storage unavailable")
        response = client.post(assets, data, format="json")
    assert response.status_code >= 400
    assert FileAsset.objects.count() == before
    assert str(client.get(slots).data[0]["attachment"]["id"]) == asset_id


def test_deleting_populated_slot_deletes_completed_and_pending(attachment_context):
    client = attachment_context[0]
    _, slots, assets = urls(attachment_context)
    slot = create_slot(attachment_context)
    completed = upload(attachment_context, slot["id"])
    assert client.patch(assets + completed + "/", {}, format="json").status_code == 200
    pending = upload(attachment_context, slot["id"])
    response = client.delete(slots + str(slot["id"]) + "/")
    assert response.status_code == 200
    assert response.data["slot_id"] == str(slot["id"])
    assert set(response.data["deleted_attachment_ids"]) == {completed, pending}
    assert client.get(slots).data == []
    assert client.get(assets).data == []
    for asset_id in (completed, pending):
        asset = FileAsset.all_objects.get(pk=asset_id)
        assert asset.is_deleted and asset.deleted_at is not None
        assert str(asset.attachment_slot_id) == str(slot["id"])
        assert client.get(assets + asset_id + "/").status_code == 404
        assert client.patch(assets + asset_id + "/", {}, format="json").status_code == 404
    assert not FileAsset.all_objects.get(pk=pending).is_uploaded


@pytest.mark.parametrize(
    "project_role,workspace_role,allowed", [(15, 15, False), (15, 20, True), (5, 20, True), (20, 15, True)],
)
@pytest.mark.parametrize("foreign_pending", [False, True])
def test_slot_delete_checks_every_file_owner(
    attachment_context, project_role, workspace_role, allowed, foreign_pending
):
    client, workspace, project, _, membership = attachment_context
    _, slots, assets = urls(attachment_context)
    slot = create_slot(attachment_context)
    completed = upload(attachment_context, slot["id"])
    assert client.patch(assets + completed + "/", {}, format="json").status_code == 200
    pending = upload(attachment_context, slot["id"])
    other = User.objects.create(email="file-owner@example.com", username="file-owner")
    FileAsset.objects.filter(pk=pending if foreign_pending else completed).update(created_by=other)
    ProjectMember.objects.filter(pk=membership.pk).update(role=project_role)
    WorkspaceMember.objects.filter(workspace=workspace, member=membership.member).update(role=workspace_role)
    response = client.delete(slots + str(slot["id"]) + "/")
    assert response.status_code == (200 if allowed else 403), response.data
    assert IssueAttachmentSlot.objects.filter(pk=slot["id"]).exists() is not allowed
    for asset_id in (completed, pending):
        asset = FileAsset.all_objects.get(pk=asset_id)
        assert asset.is_deleted is allowed
        assert (asset.deleted_at is not None) is allowed
        assert str(asset.attachment_slot_id) == str(slot["id"])
    if allowed:
        assert set(response.data["deleted_attachment_ids"]) == {completed, pending}


@pytest.mark.parametrize("scope", ["workspace", "project", "issue", "entity_type", "slot"])
def test_slot_delete_does_not_touch_files_outside_scope(attachment_context, scope):
    client, workspace, project, issue, _ = attachment_context
    _, slots, _ = urls(attachment_context)
    slot = create_slot(attachment_context)
    current = upload(attachment_context, slot["id"])
    foreign = upload(attachment_context, slot["id"])
    if scope == "workspace":
        other = Workspace.objects.create(name="Other", slug="outside", owner=workspace.owner)
        changes = {"workspace": other}
    elif scope == "project":
        other = Project.objects.create(name="Other", identifier="OTH", workspace=workspace)
        changes = {"project": other}
    elif scope == "issue":
        changes = {"issue": Issue.objects.create(name="Other", workspace=workspace, project=project)}
    elif scope == "entity_type":
        changes = {"entity_type": FileAsset.EntityTypeContext.COMMENT_DESCRIPTION}
    else:
        other = IssueAttachmentSlot.objects.create(name="Other", workspace=workspace, project=project, issue=issue)
        changes = {"attachment_slot": other}
    FileAsset.objects.filter(pk=foreign).update(**changes)
    response = client.delete(slots + str(slot["id"]) + "/")
    assert response.status_code == 200
    assert response.data == {"slot_id": str(slot["id"]), "deleted_attachment_ids": [current]}
    asset = FileAsset.objects.get(pk=foreign)
    assert not asset.is_deleted and asset.deleted_at is None


def test_slot_delete_database_failure_rolls_back_files_and_slot(attachment_context):
    from django.db.models.query import QuerySet

    client = attachment_context[0]
    _, slots, assets = urls(attachment_context)
    slot = create_slot(attachment_context)
    completed = upload(attachment_context, slot["id"])
    assert client.patch(assets + completed + "/", {}, format="json").status_code == 200
    pending = upload(attachment_context, slot["id"])
    original_update = QuerySet.update

    def fail_slot_update(queryset, **kwargs):
        if queryset.model is IssueAttachmentSlot:
            assert not FileAsset.objects.filter(pk__in=[completed, pending]).exists()
            original_update(queryset, **kwargs)
            raise IntegrityError("slot update failed")
        return original_update(queryset, **kwargs)

    with mock.patch.object(QuerySet, "update", fail_slot_update):
        response = client.delete(slots + str(slot["id"]) + "/")
    assert response.status_code >= 400
    assert IssueAttachmentSlot.objects.filter(pk=slot["id"]).exists()
    for asset_id in (completed, pending):
        asset = FileAsset.objects.get(pk=asset_id)
        assert not asset.is_deleted and asset.deleted_at is None
        assert str(asset.attachment_slot_id) == str(slot["id"])


@pytest.mark.django_db(transaction=True)
def test_slot_delete_survives_broker_failure(attachment_context, caplog):
    client = attachment_context[0]
    _, slots, _ = urls(attachment_context)
    slot = create_slot(attachment_context)
    pending = upload(attachment_context, slot["id"])
    with (
        mock.patch("plane.app.views.attachment.issue_activity.delay", side_effect=RuntimeError("broker unavailable")),
        caplog.at_level("ERROR", logger="django.db.backends.base"),
    ):
        response = client.delete(slots + str(slot["id"]) + "/")
    assert response.status_code == 200
    assert response.data == {"slot_id": str(slot["id"]), "deleted_attachment_ids": [pending]}
    assert FileAsset.all_objects.get(pk=pending).is_deleted
    assert not IssueAttachmentSlot.objects.filter(pk=slot["id"]).exists()
    assert "broker unavailable" in caplog.text


def test_guest_cannot_mutate_existing_slots(attachment_context):
    client, _, _, _, membership = attachment_context
    slot = create_slot(attachment_context)
    _, slots, assets = urls(attachment_context)
    membership.role = 5
    membership.save()
    detail = slots + str(slot["id"]) + "/"
    assert client.patch(detail, {"name": "Changed"}, format="json").status_code == 403
    assert client.delete(detail).status_code == 403
    assert (
        client.post(
            assets, {"slot_id": slot["id"], "name": "x.pdf", "type": "application/pdf", "size": 10}, format="json"
        ).status_code
        == 403
    )


def test_database_disallows_two_current_assets(attachment_context):
    slot = create_slot(attachment_context)
    first = upload(attachment_context, slot["id"])
    second = upload(attachment_context, slot["id"])
    FileAsset.objects.filter(pk=first).update(is_uploaded=True)
    with pytest.raises(IntegrityError), transaction.atomic():
        FileAsset.objects.filter(pk=second).update(is_uploaded=True)


@pytest.mark.django_db(transaction=True)
def test_concurrent_create_apply_and_completion(attachment_context):
    if connection.vendor != "postgresql":
        pytest.skip("Requires PostgreSQL row-level locking")
    client, _, _, _, membership = attachment_context
    templates, slots, assets = urls(attachment_context)

    def race(method, requests, include_data=False):
        barrier = Barrier(len(requests))

        def execute(item):
            close_old_connections()
            try:
                threaded_client = APIClient()
                threaded_client.force_authenticate(user=membership.member)
                barrier.wait(timeout=10)
                response = getattr(threaded_client, method)(item[0], item[1], format="json")
                return (response.status_code, response.data) if include_data else response.status_code
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=len(requests)) as pool:
            return list(pool.map(execute, requests))

    assert sorted(race("post", [(slots, {"name": "Concurrent"}), (slots, {"name": "concurrent"})])) == [201, 400]
    template = client.post(templates, {"name": "Append", "slots": ["CONCURRENT", "Proof"]}, format="json").data
    apply = (slots + "apply-template/", {"template_id": template["id"]})
    assert race("post", [apply, apply]) == [200, 200]
    rows = client.get(slots).data
    assert len(rows) == 2
    first = upload(attachment_context, rows[0]["id"])
    second = upload(attachment_context, rows[0]["id"])
    with (
        mock.patch("plane.app.views.issue.attachment.issue_activity.delay"),
        mock.patch("plane.app.views.issue.attachment.get_asset_object_metadata.delay"),
    ):
        results = race("patch", [(assets + first + "/", {}), (assets + second + "/", {})], include_data=True)
        assert [result[0] for result in results] == [200, 200]
    assert FileAsset.objects.filter(attachment_slot_id=rows[0]["id"], is_uploaded=True).count() == 1
    assert FileAsset.objects.filter(pk__in=[first, second], is_uploaded=True).count() == 1
    assert FileAsset.all_objects.filter(pk__in=[first, second], is_uploaded=True).count() == 2
    deleted = FileAsset.all_objects.get(pk__in=[first, second], is_deleted=True)
    returned_ids = [pk for _, body in results for pk in body["deleted_attachment_ids"]]
    assert returned_ids == [str(deleted.id)]
    assert all(body["attachment_slot_id"] == str(rows[0]["id"]) for _, body in results)
    for own_id, (_, body) in zip([first, second], results):
        assert own_id not in body["deleted_attachment_ids"]
