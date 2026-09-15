# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""Public attachment routes enforce issue access and existing file ownership together."""

from types import SimpleNamespace
from unittest import mock

import pytest

from plane.db.models import FileAsset, Issue, IssueAttachmentSlot, Project, ProjectMember, State, User, WorkspaceMember

pytestmark = [pytest.mark.contract, pytest.mark.django_db]
VIEW = "plane.api.views.issue"


@pytest.fixture
def attachments(workspace, create_user, api_key_client, settings):
    settings.APP_BASE_URL = "https://plane.example.test"
    project = Project.objects.create(name="Public attachments", identifier="PAT", workspace=workspace)
    membership = ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=15)
    WorkspaceMember.objects.filter(workspace=workspace, member=create_user).update(role=15)
    other = User.objects.create(email="public-attachment-owner@example.test", username="public-attachment-owner")
    state = State.objects.create(workspace=workspace, project=project, name="Working", group="started")
    issue = Issue(workspace=workspace, project=project, name="Public files", state=state, created_by=create_user)
    issue.save(disable_auto_set_user=True)
    slot = IssueAttachmentSlot.objects.create(workspace=workspace, project=project, issue=issue, name="Proof")
    asset = FileAsset(
        workspace=workspace, project=project, issue=issue, attachment_slot=slot, created_by=create_user,
        asset="public/proof.pdf", entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
        attributes={"name": "proof.pdf", "type": "application/pdf", "size": 100},
    )
    asset.save(disable_auto_set_user=True)
    base = f"/api/v1/workspaces/{workspace.slug}/projects/{project.id}/work-items/{issue.id}/attachments/"
    with (
        mock.patch(f"{VIEW}.S3Storage") as storage,
        mock.patch(f"{VIEW}.issue_activity.delay") as activity,
        mock.patch(f"{VIEW}.get_asset_object_metadata.delay") as metadata,
    ):
        storage.return_value.generate_presigned_post.return_value = {"url": "https://upload.invalid", "fields": {}}
        yield SimpleNamespace(
            workspace=workspace, project=project, user=create_user, other=other, membership=membership,
            issue=issue, state=state, slot=slot, asset=asset, client=api_key_client, url=base,
            storage=storage, activity=activity, metadata=metadata,
        )


def upload_payload(context):
    return {"name": "replacement.pdf", "type": "application/pdf", "size": 100, "slot_id": str(context.slot.id)}


@pytest.mark.parametrize(
    "actor,allowed",
    [("creator", True), ("current", True), ("future", False), ("unrelated", False), ("lead", False),
     ("project_admin", True), ("workspace_admin", True), ("guest_creator", False)],
)
@pytest.mark.parametrize("method", ["post", "patch", "delete"])
def test_public_attachment_write_permission_matrix(attachments, actor, allowed, method):
    context = attachments
    changes = {"created_by": context.other, "state_assignees": {}}
    if actor in {"creator", "guest_creator"}:
        changes["created_by"] = context.user
    if actor == "current":
        changes["state_assignees"] = {str(context.state.id): [str(context.user.id)]}
    if actor == "future":
        future = State.objects.create(
            workspace=context.workspace, project=context.project, name="Review", group="started",
        )
        changes["state_assignees"] = {str(future.id): [str(context.user.id)]}
    Issue.objects.filter(pk=context.issue.pk).update(**changes)
    if actor == "lead":
        Project.objects.filter(pk=context.project.pk).update(project_lead=context.user)
    if actor == "project_admin":
        ProjectMember.objects.filter(pk=context.membership.pk).update(role=20)
    if actor in {"workspace_admin", "guest_creator"}:
        ProjectMember.objects.filter(pk=context.membership.pk).update(role=5)
        WorkspaceMember.objects.filter(workspace=context.workspace, member=context.user).update(
            role=20 if actor == "workspace_admin" else 5,
        )
    url = context.url if method == "post" else context.url + str(context.asset.id) + "/"
    response = getattr(context.client, method)(url, upload_payload(context) if method == "post" else {}, format="json")
    assert response.status_code == ((204 if method == "delete" else 200) if allowed else 403), response.data
    if not allowed:
        context.asset.refresh_from_db()
        assert not context.asset.is_uploaded and not context.asset.is_deleted
        assert FileAsset.objects.filter(issue=context.issue).count() == 1
        context.storage.assert_not_called()
        context.activity.assert_not_called()
        context.metadata.assert_not_called()
        assert context.client.get(context.url).status_code == 200


@pytest.mark.parametrize("method", ["post", "patch", "delete"])
@pytest.mark.parametrize("admin", [None, "project", "workspace"])
def test_public_issue_owner_still_needs_file_owner_or_admin(attachments, method, admin):
    context = attachments
    FileAsset.objects.filter(pk=context.asset.pk).update(created_by=context.other, is_uploaded=method == "post")
    if admin == "project":
        ProjectMember.objects.filter(pk=context.membership.pk).update(role=20)
    elif admin == "workspace":
        ProjectMember.objects.filter(pk=context.membership.pk).update(role=5)
        WorkspaceMember.objects.filter(workspace=context.workspace, member=context.user).update(role=20)
    url = context.url if method == "post" else context.url + str(context.asset.id) + "/"
    response = getattr(context.client, method)(url, upload_payload(context) if method == "post" else {}, format="json")
    expected = (204 if method == "delete" else 200) if admin else 403
    assert response.status_code == expected, response.data
    if not admin:
        context.asset.refresh_from_db()
        assert not context.asset.is_deleted
        assert context.asset.is_uploaded is (method == "post")
        context.activity.assert_not_called()


@pytest.mark.parametrize("method", ["patch", "delete"])
@pytest.mark.parametrize("legacy_url", [False, True])
def test_public_attachment_id_cannot_cross_issue_scope(attachments, method, legacy_url):
    context = attachments
    foreign = Issue(workspace=context.workspace, project=context.project, name="Other issue", created_by=context.user)
    foreign.save(disable_auto_set_user=True)
    FileAsset.objects.filter(pk=context.asset.pk).update(issue=foreign)
    url = context.url + str(context.asset.id) + "/"
    if legacy_url:
        url = url.replace("/work-items/", "/issues/").replace("/attachments/", "/issue-attachments/")
    response = getattr(context.client, method)(url, {}, format="json")
    assert response.status_code == 404, response.data
    context.asset.refresh_from_db()
    assert not context.asset.is_uploaded and not context.asset.is_deleted
    context.activity.assert_not_called()
    context.metadata.assert_not_called()


@pytest.mark.parametrize("method", ["patch", "delete"])
def test_public_pending_upload_loses_write_access_when_unassigned(attachments, method):
    context = attachments
    Issue.objects.filter(pk=context.issue.pk).update(
        created_by=context.other, state_assignees={str(context.state.id): [str(context.user.id)]},
    )
    pending = context.client.post(context.url, upload_payload(context), format="json")
    assert pending.status_code == 200, pending.data
    Issue.objects.filter(pk=context.issue.pk).update(state_assignees={})
    response = getattr(context.client, method)(context.url + pending.data["asset_id"] + "/", {}, format="json")
    assert response.status_code == 403, response.data
    asset = FileAsset.objects.get(pk=pending.data["asset_id"])
    assert not asset.is_uploaded and not asset.is_deleted
