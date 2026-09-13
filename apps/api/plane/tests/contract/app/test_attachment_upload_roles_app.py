# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Ordinary attachment permissions for the reported 39 KiB ZIP upload.

Exercise the real Django metadata/upload-completion endpoints and permission
checks. Object-storage transfers and Celery publication stay mocked; these
checks do not claim to reproduce a browser or storage-server failure.
"""

from unittest import mock

import pytest
from rest_framework.test import APIClient

from plane.db.models import FileAsset, Issue, Project, ProjectMember, User, WorkspaceMember

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
    # Intentionally omit slot_id: this reproduces the ordinary-attachment path.
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
    assert response.status_code == 200, response.data
    asset = FileAsset.objects.get(pk=response.data["asset_id"])
    assert asset.issue_id == context["issue"].id
    assert asset.project_id == context["project"].id
    assert asset.workspace_id == context["workspace"].id
    assert asset.created_by_id == context["uploader"].id
    assert asset.attachment_slot_id is None
    assert not asset.is_uploaded
    assert asset.size == ZIP_SIZE
    assert asset.attributes == {"name": ZIP_NAME, "type": ZIP_TYPE, "size": ZIP_SIZE}
    assert response.data["attachment"]["attachment_slot_id"] is None
    assert response.data["upload_data"]["url"] == "https://storage.example.test/upload"
    context["storage"].return_value.generate_presigned_post.assert_called_once_with(
        object_name=asset.asset.name, file_type=ZIP_TYPE, file_size=ZIP_SIZE
    )
    assert client.get(url).data == []

    detail = url + str(asset.id) + "/"
    with django_capture_on_commit_callbacks(execute=True):
        completed = client.patch(detail, {}, format="json")
    assert completed.status_code == 204, completed.data
    asset.refresh_from_db()
    assert asset.is_uploaded
    assert asset.created_by_id == context["uploader"].id
    assert asset.attachment_slot_id is None
    listed = client.get(url)
    assert listed.status_code == 200, listed.data
    assert [str(row["id"]) for row in listed.data] == [str(asset.id)]
    context["activity"].assert_called_once()
    assert context["activity"].call_args.kwargs["actor_id"] == str(context["uploader"].id)
    context["metadata"].assert_called_once_with(str(asset.id))

    with django_capture_on_commit_callbacks(execute=True):
        repeated = client.patch(detail, {}, format="json")
    assert repeated.status_code == 204, repeated.data
    context["activity"].assert_called_once()
    context["metadata"].assert_called_once()


@pytest.mark.parametrize("membership_state", ["inactive", "removed"])
def test_39k_zip_requires_active_project_membership(zip_upload_context, membership_state):
    context = zip_upload_context
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
