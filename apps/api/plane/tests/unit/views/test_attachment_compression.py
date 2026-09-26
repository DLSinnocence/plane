# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""Metadata validation and presigning; no database or object store required."""

import base64
import json
from inspect import unwrap
from types import SimpleNamespace
from unittest import mock
from uuid import uuid4

import pytest
from rest_framework.exceptions import ValidationError

from plane.app.serializers.attachment import (
    ATTACHMENT_COMPRESSION_THRESHOLD,
    AttachmentSlotUploadSerializer,
)
from plane.app.views.issue import attachment as views
from plane.settings.storage import S3Storage

pytestmark = pytest.mark.unit
THRESHOLD = ATTACHMENT_COMPRESSION_THRESHOLD
PSD = "image/vnd.adobe.photoshop"


@pytest.mark.parametrize("size", [1, THRESHOLD - 1, THRESHOLD, THRESHOLD + 1])
def test_legacy_unencoded_metadata_is_accepted(size):
    serializer = AttachmentSlotUploadSerializer(data={"size": size})
    assert serializer.is_valid(), serializer.errors
    assert serializer.validated_data == {"size": size}


@pytest.mark.parametrize(
    "data",
    [
        {"size": 0},
        {"size": -1},
        {"size": "invalid"},
        {"size": 1.5},
        {"size": 1024 * 1024 * 1024 + 1},
        {"size": THRESHOLD + 1, "content_encoding": "br", "compressed_size": 10},
        {"size": THRESHOLD + 1, "content_encoding": "gzip"},
        {"size": THRESHOLD + 1, "compressed_size": 10},
        {"content_encoding": "gzip", "compressed_size": 10},
        {"size": THRESHOLD, "content_encoding": "gzip", "compressed_size": 10},
        {"size": THRESHOLD - 1, "content_encoding": "gzip", "compressed_size": 10},
        {"size": THRESHOLD + 1, "content_encoding": "gzip", "compressed_size": 0},
        {"size": THRESHOLD + 1, "content_encoding": "gzip", "compressed_size": -1},
        {"size": THRESHOLD + 1, "content_encoding": "gzip", "compressed_size": "bad"},
        {"size": THRESHOLD + 1, "content_encoding": "gzip", "compressed_size": THRESHOLD * 2},
    ],
)
def test_invalid_compression_metadata_is_rejected(data, settings):
    settings.FILE_SIZE_LIMIT = 1024 * 1024 * 1024
    serializer = AttachmentSlotUploadSerializer(data=data)
    assert not serializer.is_valid()


def test_compression_cannot_bypass_configured_original_size_limit(settings):
    settings.FILE_SIZE_LIMIT = THRESHOLD
    serializer = AttachmentSlotUploadSerializer(
        data={"size": THRESHOLD + 1, "content_encoding": "gzip", "compressed_size": 100}
    )
    assert not serializer.is_valid()
    assert "size" in serializer.errors


def test_incompressible_file_at_limit_allows_bounded_gzip_overhead(settings):
    settings.FILE_SIZE_LIMIT = 1024 * 1024 * 1024
    size = settings.FILE_SIZE_LIMIT
    data = {"size": size, "content_encoding": "gzip", "compressed_size": size + size // 1000 + 1024}
    serializer = AttachmentSlotUploadSerializer(data=data)
    assert serializer.is_valid(), serializer.errors
    assert serializer.validated_data == data


@pytest.fixture
def upload():
    issue = SimpleNamespace(id=uuid4(), project_id=uuid4(), workspace_id=uuid4())
    slot = SimpleNamespace(id=uuid4(), name="附件", sort_order=1)
    asset = SimpleNamespace(
        id=uuid4(), attachment_slot_id=slot.id, attachment_slot=slot,
        asset=SimpleNamespace(name="workspace/uuid-设计.PSD"), asset_url="/asset",
    )
    with (
        mock.patch.object(views, "scoped_issue", return_value=issue),
        mock.patch.object(views, "require_issue_write_access"),
        mock.patch.object(views.Workspace.objects, "get", return_value=SimpleNamespace(id=issue.workspace_id)),
        mock.patch.object(views, "create_attachment_asset", return_value=asset) as create,
        mock.patch.object(views, "IssueAttachmentSerializer") as serialized,
        mock.patch.object(views, "S3Storage") as storage,
    ):
        serialized.return_value.data = {"id": str(asset.id)}
        storage.return_value.generate_presigned_post.return_value = {"url": "/storage", "fields": {}}

        def post(data):
            request = SimpleNamespace(data=data, user=SimpleNamespace(id=uuid4()))
            return unwrap(views.IssueAttachmentV2Endpoint.post)(
                views.IssueAttachmentV2Endpoint(), request, "workspace", issue.project_id, issue.id
            )

        yield SimpleNamespace(post=post, create=create, storage=storage.return_value, asset=asset)


@pytest.mark.parametrize("mime", [PSD, "image/x-photoshop", "application/photoshop", "application/x-photoshop"])
@pytest.mark.parametrize("compressed", [False, True])
def test_psd_upload_retains_original_metadata_and_signs_actual_payload(upload, mime, compressed):
    size = THRESHOLD + 1 if compressed else THRESHOLD
    data = {"name": "设计.PSD", "type": mime, "size": size}
    if compressed:
        data.update(content_encoding="gzip", compressed_size=12345)
    response = upload.post(data)
    assert response.status_code == 200
    assert upload.create.call_args.kwargs["attributes"] == data
    assert upload.create.call_args.kwargs["size"] == size
    assert upload.create.call_args.kwargs["asset"].endswith("-设计.PSD")
    options = {"content_encoding": "gzip"} if compressed else {}
    upload.storage.generate_presigned_post.assert_called_once_with(
        object_name=upload.asset.asset.name, file_type=mime,
        file_size=12345 if compressed else size, **options,
    )


def test_invalid_upload_does_not_provision_or_presign(upload):
    with pytest.raises(ValidationError):
        upload.post({"name": "design.psd", "type": PSD, "size": "invalid"})
    upload.create.assert_not_called()
    upload.storage.generate_presigned_post.assert_not_called()


def test_encoding_does_not_bypass_mime_allowlist(upload):
    response = upload.post({
        "name": "file.exe", "type": "application/x-msdownload", "size": THRESHOLD + 1,
        "content_encoding": "gzip", "compressed_size": 12345,
    })
    assert response.status_code == 400
    upload.create.assert_not_called()
    upload.storage.generate_presigned_post.assert_not_called()


@pytest.mark.parametrize("encoding", [None, "gzip"])
def test_s3_post_policy_binds_encoding_type_and_encoded_size(encoding, monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test-secret")
    monkeypatch.setenv("AWS_S3_BUCKET_NAME", "test-bucket")
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("USE_MINIO", "0")
    storage = S3Storage()
    response = storage.generate_presigned_post(
        "workspace/design.psd", PSD, 12345, content_encoding=encoding,
    )
    fields = response["fields"]
    conditions = json.loads(base64.b64decode(fields["policy"]))["conditions"]
    assert fields["Content-Type"] == PSD
    assert {"Content-Type": PSD} in conditions
    assert ["content-length-range", 1, 12345] in conditions
    if encoding:
        assert fields["Content-Encoding"] == "gzip"
        assert {"Content-Encoding": "gzip"} in conditions
    else:
        assert "Content-Encoding" not in fields
        assert not any(isinstance(item, dict) and "Content-Encoding" in item for item in conditions)


def test_object_metadata_reports_encoding_separately_from_original_metadata():
    storage = object.__new__(S3Storage)
    storage.aws_storage_bucket_name = "test-bucket"
    storage.s3_client = mock.Mock()
    storage.s3_client.head_object.return_value = {
        "ContentType": PSD, "ContentEncoding": "gzip", "ContentLength": 12345,
    }
    metadata = storage.get_object_metadata("workspace/design.psd")
    assert metadata["ContentEncoding"] == "gzip"
    assert metadata["ContentLength"] == 12345
    assert metadata["ContentType"] == PSD
