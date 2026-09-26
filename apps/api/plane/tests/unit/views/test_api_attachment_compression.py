# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""Public API presigning matches the web attachment compression contract."""

from inspect import unwrap
from types import SimpleNamespace
from unittest import mock
from uuid import uuid4

import pytest
from rest_framework.exceptions import PermissionDenied, ValidationError

from plane.api.views import issue as views
from plane.app.serializers.attachment import ATTACHMENT_COMPRESSION_THRESHOLD

pytestmark = pytest.mark.unit
THRESHOLD = ATTACHMENT_COMPRESSION_THRESHOLD
PSD = "image/vnd.adobe.photoshop"


@pytest.fixture
def upload():
    issue = SimpleNamespace(id=uuid4(), project_id=uuid4(), workspace_id=uuid4())
    slot = SimpleNamespace(id=uuid4(), name="附件", sort_order=1)
    asset = SimpleNamespace(
        id=uuid4(), attachment_slot_id=slot.id, attachment_slot=slot,
        asset=SimpleNamespace(name="workspace/uuid-design.PSD"), asset_url="/asset",
    )
    with (
        mock.patch.object(views, "scoped_issue", return_value=issue),
        mock.patch.object(views, "require_issue_write_access") as permission,
        mock.patch.object(views.Workspace.objects, "get", return_value=SimpleNamespace(id=issue.workspace_id)),
        mock.patch.object(views, "create_attachment_asset", return_value=asset) as create,
        mock.patch.object(views, "IssueAttachmentSerializer") as serialized,
        mock.patch.object(views, "S3Storage") as storage,
        mock.patch.object(views.FileAsset.objects, "filter") as assets,
        mock.patch.object(views.IssueAttachmentSlot.objects, "select_for_update"),
        mock.patch.object(views, "get_object_or_404", return_value=slot),
        mock.patch.object(views, "require_replacement_permission") as replacement_permission,
    ):
        serialized.return_value.data = {"id": str(asset.id)}
        storage.return_value.generate_presigned_post.return_value = {"url": "/storage", "fields": {}}
        assets.return_value.exists.return_value = False

        def post(data):
            request = SimpleNamespace(data=data, user=SimpleNamespace(id=uuid4()))
            return unwrap(views.IssueAttachmentListCreateAPIEndpoint.post)(
                views.IssueAttachmentListCreateAPIEndpoint(), request, "workspace", issue.project_id, issue.id
            )

        yield SimpleNamespace(
            post=post, create=create, storage=storage.return_value, asset=asset,
            permission=permission, assets=assets, slot=slot, replacement_permission=replacement_permission,
        )


@pytest.mark.parametrize("compressed", [False, True])
@pytest.mark.parametrize("with_slot", [False, True])
def test_public_api_preserves_original_metadata_and_signs_encoded_body(upload, compressed, with_slot):
    size = THRESHOLD + 1 if compressed else THRESHOLD
    data = {"name": "design.PSD", "type": PSD, "size": size, "external_id": "external-1", "external_source": "test"}
    attributes = {"name": data["name"], "type": PSD, "size": size}
    if compressed:
        data.update(content_encoding="gzip", compressed_size=12345)
        attributes.update(content_encoding="gzip", compressed_size=12345)
    if with_slot:
        data["slot_id"] = str(upload.slot.id)
    response = upload.post(data)
    assert response.status_code == 200
    kwargs = upload.create.call_args.kwargs
    assert kwargs["attributes"] == attributes
    assert kwargs["size"] == size
    assert kwargs["external_id"] == "external-1"
    assert kwargs["external_source"] == "test"
    assert kwargs["attachment_slot"] == (upload.slot if with_slot else None)
    assert kwargs["asset"].endswith("-design.PSD")
    upload.permission.assert_called_once()
    assert upload.replacement_permission.call_count == int(with_slot)
    options = {"content_encoding": "gzip"} if compressed else {}
    upload.storage.generate_presigned_post.assert_called_once_with(
        object_name=upload.asset.asset.name, file_type=PSD,
        file_size=12345 if compressed else size, **options,
    )


def test_numeric_size_string_is_validated_before_arithmetic(upload):
    response = upload.post({"name": "design.psd", "type": PSD, "size": str(THRESHOLD)})
    assert response.status_code == 200
    assert upload.create.call_args.kwargs["size"] == THRESHOLD


@pytest.mark.parametrize("size", ["invalid", [100], -1, 1.5, 1024 * 1024 * 1024 + 1])
def test_bad_original_sizes_reject_before_creating_or_signing(upload, size, settings):
    settings.FILE_SIZE_LIMIT = 1024 * 1024 * 1024
    with pytest.raises(ValidationError):
        upload.post({"name": "design.psd", "type": PSD, "size": size})
    upload.create.assert_not_called()
    upload.storage.generate_presigned_post.assert_not_called()


def test_incomplete_compression_metadata_rejects(upload):
    with pytest.raises(ValidationError):
        upload.post({"name": "design.psd", "type": PSD, "size": THRESHOLD + 1, "content_encoding": "gzip"})
    upload.create.assert_not_called()
    upload.storage.generate_presigned_post.assert_not_called()


def test_external_id_conflict_still_prevents_duplicate_assets(upload):
    upload.assets.return_value.exists.return_value = True
    upload.assets.return_value.first.return_value = upload.asset
    response = upload.post({
        "name": "design.psd", "type": PSD, "size": THRESHOLD + 1,
        "content_encoding": "gzip", "compressed_size": 12345,
        "external_id": "duplicate", "external_source": "test",
    })
    assert response.status_code == 409
    assert response.data["id"] == str(upload.asset.id)
    upload.create.assert_not_called()
    upload.storage.generate_presigned_post.assert_not_called()


def test_issue_write_permission_is_still_required_before_presigning(upload):
    upload.permission.side_effect = PermissionDenied("No write access")
    with pytest.raises(PermissionDenied):
        upload.post({
            "name": "design.psd", "type": PSD, "size": THRESHOLD + 1,
            "content_encoding": "gzip", "compressed_size": 12345,
        })
    upload.create.assert_not_called()
    upload.storage.generate_presigned_post.assert_not_called()


def test_gzip_does_not_bypass_public_api_mime_allowlist(upload):
    response = upload.post({
        "name": "file.exe", "type": "application/x-msdownload", "size": THRESHOLD + 1,
        "content_encoding": "gzip", "compressed_size": 12345,
    })
    assert response.status_code == 400
    upload.create.assert_not_called()
    upload.storage.generate_presigned_post.assert_not_called()
