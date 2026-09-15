# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Named attachment row permissions for the reported 39 KiB ZIP upload.

Exercise the real Django metadata/upload-completion endpoints and permission
checks. Object-storage transfers and Celery publication stay mocked; these
checks do not claim to reproduce a browser or storage-server failure.
"""

from unittest import mock

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    AttachmentTemplate, FileAsset, Intake, IntakeIssue, Issue, IssueAttachmentSlot,
    Project, ProjectMember, State, User, WorkspaceMember,
)

pytestmark = [pytest.mark.contract, pytest.mark.django_db]

ZIP_NAME = "small-archive.zip"
ZIP_TYPE = "application/zip"
ZIP_SIZE = 39 * 1024
ATTACHMENT_VIEW = "plane.app.views.issue.attachment"


@pytest.fixture
def zip_upload_context(workspace, create_user, settings):
    settings.APP_BASE_URL = "https://plane.example.test"
    with (
        mock.patch(f"{ATTACHMENT_VIEW}.S3Storage") as storage,
        mock.patch(f"{ATTACHMENT_VIEW}.issue_activity.delay") as activity,
        mock.patch(f"{ATTACHMENT_VIEW}.get_asset_object_metadata.delay") as metadata,
    ):
        storage.return_value.generate_presigned_post.return_value = {
            "url": "https://storage.example.test/upload",
            "fields": {"key": "mocked-object-key"},
        }
        project = Project.objects.create(name="ZIP permissions", identifier="ZIP", workspace=workspace)
        ProjectMember.objects.create(project=project, workspace=workspace, member=create_user, role=20)
        issue = Issue(name="Created by another user", project=project, workspace=workspace, created_by=create_user)
        issue.save(disable_auto_set_user=True)
        uploader = User.objects.create(email="zip-uploader@example.test", username="zip-uploader")
        workspace_member = WorkspaceMember.objects.create(workspace=workspace, member=uploader, role=15)
        project_member = ProjectMember.objects.create(project=project, workspace=workspace, member=uploader, role=15)
        client = APIClient()
        client.force_authenticate(user=uploader)
        yield {
            "client": client,
            "workspace": workspace,
            "project": project,
            "issue": issue,
            "author": create_user,
            "uploader": uploader,
            "workspace_member": workspace_member,
            "project_member": project_member,
            "storage": storage,
            "activity": activity,
            "metadata": metadata,
            "url": (f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/issues/{issue.id}/attachments/"),
        }


def zip_payload():
    # Omitting slot_id provisions a named row as part of the authorized upload.
    return {"name": ZIP_NAME, "type": ZIP_TYPE, "size": ZIP_SIZE}


@pytest.mark.parametrize("role", [20, 15, 5], ids=["admin", "member", "guest"])
def test_39k_zip_upload_and_complete_on_another_users_issue(
    zip_upload_context, role, settings, django_capture_on_commit_callbacks
):
    context = zip_upload_context
    client, url = context["client"], context["url"]
    WorkspaceMember.objects.filter(pk=context["workspace_member"].pk).update(role=role)
    ProjectMember.objects.filter(pk=context["project_member"].pk).update(role=role)
    # Match both roles so workspace-admin fallback cannot mask a member failure.
    assert context["issue"].created_by_id == context["author"].id
    assert context["issue"].created_by_id != context["uploader"].id
    assert ZIP_TYPE in settings.ATTACHMENT_MIME_TYPES
    assert ZIP_SIZE <= settings.FILE_SIZE_LIMIT

    response = client.post(url, zip_payload(), format="json")
    if role != 20:
        assert response.status_code == 403, response.data
        assert not FileAsset.objects.filter(issue=context["issue"]).exists()
        context["storage"].assert_not_called()
        return
    assert response.status_code == 200, response.data
    asset = FileAsset.objects.get(pk=response.data["asset_id"])
    assert asset.issue_id == context["issue"].id
    assert asset.project_id == context["project"].id
    assert asset.workspace_id == context["workspace"].id
    assert asset.created_by_id == context["uploader"].id
    assert asset.attachment_slot_id is not None
    assert asset.attachment_slot.name == "附件"
    assert asset.attachment_slot.issue_id == context["issue"].id
    assert asset.attachment_slot.project_id == context["project"].id
    assert asset.attachment_slot.workspace_id == context["workspace"].id
    assert not asset.is_uploaded
    assert asset.size == ZIP_SIZE
    assert asset.attributes == {"name": ZIP_NAME, "type": ZIP_TYPE, "size": ZIP_SIZE}
    slot_id = str(asset.attachment_slot_id)
    assert str(response.data["attachment"]["attachment_slot_id"]) == slot_id
    assert response.data["attachment_slot_id"] == slot_id
    row_data = {"id": slot_id, "name": asset.attachment_slot.name, "sort_order": asset.attachment_slot.sort_order}
    assert response.data["attachment_slot"] == row_data
    assert response.data["upload_data"]["url"] == "https://storage.example.test/upload"
    context["storage"].return_value.generate_presigned_post.assert_called_once_with(
        object_name=asset.asset.name, file_type=ZIP_TYPE, file_size=ZIP_SIZE
    )
    assert client.get(url).data == []

    detail = url + str(asset.id) + "/"
    with django_capture_on_commit_callbacks(execute=True):
        completed = client.patch(detail, {}, format="json")
    assert completed.status_code == 200, completed.data
    assert completed.data == {
        "attachment_slot_id": slot_id, "deleted_attachment_ids": [], "attachment_slot": row_data,
    }
    asset.refresh_from_db()
    assert asset.is_uploaded
    assert asset.created_by_id == context["uploader"].id
    assert asset.attachment_slot_id is not None
    assert asset.attachment_slot.name == "附件"
    assert asset.attachment_slot.issue_id == context["issue"].id
    assert asset.attachment_slot.project_id == context["project"].id
    assert asset.attachment_slot.workspace_id == context["workspace"].id
    listed = client.get(url)
    assert listed.status_code == 200, listed.data
    assert [str(row["id"]) for row in listed.data] == [str(asset.id)]
    context["activity"].assert_called_once()
    assert context["activity"].call_args.kwargs["actor_id"] == str(context["uploader"].id)
    context["metadata"].assert_called_once_with(str(asset.id))

    with django_capture_on_commit_callbacks(execute=True):
        repeated = client.patch(detail, {}, format="json")
    assert repeated.status_code == 200, repeated.data
    assert repeated.data == {
        "attachment_slot_id": slot_id, "deleted_attachment_ids": [], "attachment_slot": row_data,
    }
    context["activity"].assert_called_once()
    context["metadata"].assert_called_once()


@pytest.mark.parametrize("membership_state", ["inactive", "removed"])
def test_39k_zip_requires_active_project_membership(zip_upload_context, membership_state):
    context = zip_upload_context
    Issue.objects.filter(pk=context["issue"].pk).update(created_by=context["uploader"])
    client, url = context["client"], context["url"]
    pending = client.post(url, zip_payload(), format="json")
    assert pending.status_code == 200, pending.data
    asset = FileAsset.objects.get(pk=pending.data["asset_id"])
    membership = ProjectMember.objects.filter(pk=context["project_member"].pk)
    if membership_state == "inactive":
        membership.update(is_active=False)
    else:
        membership.delete()
    assert WorkspaceMember.objects.filter(pk=context["workspace_member"].pk, is_active=True, role=15).exists()
    context["storage"].reset_mock()
    count = FileAsset.objects.count()

    denied_upload = client.post(url, zip_payload(), format="json")
    assert denied_upload.status_code == 403, denied_upload.data
    context["storage"].assert_not_called()
    assert FileAsset.objects.count() == count
    denied_completion = client.patch(url + str(asset.id) + "/", {}, format="json")
    assert denied_completion.status_code == 403, denied_completion.data
    asset.refresh_from_db()
    assert not asset.is_uploaded
    context["activity"].assert_not_called()
    context["metadata"].assert_not_called()


@pytest.mark.parametrize(
    "actor,allowed",
    [("creator", True), ("intake_creator", True), ("current", True), ("future", False), ("lead", False),
     ("unrelated", False), ("project_admin", True), ("workspace_admin", True), ("guest_creator", False)],
)
@pytest.mark.parametrize(
    "action", ["upload", "complete", "delete", "slot_create", "slot_rename", "slot_delete", "apply"],
)
def test_attachment_writes_follow_saved_issue_access(zip_upload_context, actor, allowed, action):
    context = zip_upload_context
    issue, user = context["issue"], context["uploader"]
    project, workspace = context["project"], context["workspace"]
    current = State.objects.create(name="Working", group="started", project=project, workspace=workspace)
    future = State.objects.create(name="Review", group="started", project=project, workspace=workspace)
    changes = {"state": current, "state_assignees": {str(future.id): [str(user.id)]}}
    if actor in {"creator", "intake_creator", "guest_creator"}:
        changes["created_by"] = user
    if actor == "intake_creator":
        intake = Intake.objects.create(name="New requests", project=project, workspace=workspace)
        IntakeIssue.objects.create(intake=intake, issue=issue, project=project, workspace=workspace)
    if actor == "current":
        changes["state_assignees"] = {str(current.id): [str(user.id)]}
    Issue.objects.filter(pk=issue.pk).update(**changes)
    if actor == "lead":
        Project.objects.filter(pk=project.pk).update(project_lead=user)
    if actor == "project_admin":
        ProjectMember.objects.filter(pk=context["project_member"].pk).update(role=20)
    if actor in {"workspace_admin", "guest_creator"}:
        ProjectMember.objects.filter(pk=context["project_member"].pk).update(role=5)
        WorkspaceMember.objects.filter(pk=context["workspace_member"].pk).update(
            role=20 if actor == "workspace_admin" else 5,
        )
    slot = IssueAttachmentSlot.objects.create(name="Proof", issue=issue, project=project, workspace=workspace)
    asset = FileAsset(
        issue=issue, project=project, workspace=workspace, attachment_slot=slot,
        created_by=user, asset="saved/proof.zip", entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
    )
    asset.save(disable_auto_set_user=True)
    template = AttachmentTemplate.objects.create(workspace=workspace, name="Review", slots=["Report"])
    slots = context["url"].replace("/api/assets/v2/", "/api/").replace("/attachments/", "/attachment-slots/")
    requests = {
        "upload": ("post", context["url"], zip_payload(), 200),
        "complete": ("patch", context["url"] + str(asset.id) + "/", {}, 200),
        "delete": ("delete", context["url"] + str(asset.id) + "/", {}, 204),
        "slot_create": ("post", slots, {"name": "Extra"}, 201),
        "slot_rename": ("patch", slots + str(slot.id) + "/", {"name": "Renamed"}, 200),
        "slot_delete": ("delete", slots + str(slot.id) + "/", {}, 200),
        "apply": ("post", slots + "apply-template/", {"template_id": str(template.id)}, 200),
    }
    method, url, payload, expected = requests[action]
    response = getattr(context["client"], method)(url, payload, format="json")
    assert response.status_code == (expected if allowed else 403), response.data
    if not allowed:
        asset.refresh_from_db()
        slot.refresh_from_db()
        assert not asset.is_uploaded and not asset.is_deleted
        assert slot.name == "Proof"
        assert IssueAttachmentSlot.objects.filter(issue=issue).count() == 1
        context["storage"].assert_not_called()
        assert context["client"].get(context["url"]).status_code == 200


@pytest.mark.parametrize("route", ["issue", "workspace", "project", "public"])
@pytest.mark.parametrize("action", ["complete", "delete"])
def test_former_assignee_cannot_complete_or_delete_owned_upload(zip_upload_context, route, action):
    if route == "public" and action == "delete":
        pytest.skip("Generic public assets expose completion only")
    context = zip_upload_context
    issue, user = context["issue"], context["uploader"]
    current = State.objects.create(
        name="Working", group="started", project=context["project"], workspace=context["workspace"],
    )
    Issue.objects.filter(pk=issue.pk).update(state=current, state_assignees={str(current.id): [str(user.id)]})
    pending = context["client"].post(context["url"], zip_payload(), format="json")
    assert pending.status_code == 200, pending.data
    asset = FileAsset.objects.get(pk=pending.data["asset_id"])
    Issue.objects.filter(pk=issue.pk).update(state_assignees={})
    slug, project_id = context["workspace"].slug, context["project"].id
    urls = {
        "issue": context["url"] + str(asset.id) + "/",
        "workspace": f"/api/assets/v2/workspaces/{slug}/{asset.id}/",
        "project": f"/api/assets/v2/workspaces/{slug}/projects/{project_id}/{asset.id}/",
        "public": f"/api/v1/workspaces/{slug}/assets/{asset.id}/",
    }
    response = getattr(context["client"], "patch" if action == "complete" else "delete")(
        urls[route], {}, format="json",
    )
    assert response.status_code == 403, response.data
    asset.refresh_from_db()
    assert not asset.is_uploaded and not asset.is_deleted


@pytest.mark.parametrize("route", ["workspace", "project", "duplicate", "legacy", "legacy_without_type"])
def test_generic_upload_cannot_attach_to_another_members_issue(zip_upload_context, route):
    from django.core.files.uploadedfile import SimpleUploadedFile

    context = zip_upload_context
    issue, workspace, project = context["issue"], context["workspace"], context["project"]
    base = f"/api/assets/v2/workspaces/{workspace.slug}/"
    payload = {
        "name": "image.png", "type": "image/png", "size": 10,
        "entity_type": FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
        "entity_identifier": str(issue.id),
    }
    if route == "project":
        url = base + f"projects/{project.id}/"
    elif route == "duplicate":
        original = FileAsset.objects.create(
            workspace=workspace, project=project, asset="source/image.png", is_uploaded=True,
            attributes={"name": "image.png", "type": "image/png", "size": 10},
        )
        url = base + f"duplicate-assets/{original.id}/"
        payload.update(project_id=str(project.id), entity_id=str(issue.id))
    elif route.startswith("legacy"):
        url = f"/api/workspaces/{workspace.slug}/file-assets/"
        payload = {
            "asset": SimpleUploadedFile("image.png", b"image", content_type="image/png"),
            "issue": str(issue.id), "entity_type": FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
        }
        if route == "legacy_without_type":
            payload.pop("entity_type")
    else:
        url = base
    count = FileAsset.objects.count()
    with mock.patch("plane.app.views.asset.v2.S3Storage") as storage:
        response = context["client"].post(
            url, payload, format="multipart" if route.startswith("legacy") else "json",
        )
    assert response.status_code == 403, response.data
    storage.return_value.generate_presigned_post.assert_not_called()
    storage.return_value.copy_object.assert_not_called()
    assert FileAsset.objects.count() == count
    assert not IssueAttachmentSlot.objects.filter(issue=issue).exists()
