# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import gzip
import io
from types import SimpleNamespace
from unittest import mock
from uuid import uuid4

import pytest
from botocore.exceptions import ClientError
from rest_framework.exceptions import ValidationError

from plane.settings.storage import S3Storage
from plane.utils import attachment_rows as rows

pytestmark = pytest.mark.unit
PSD = "image/vnd.adobe.photoshop"


def stored_body(data, **metadata):
    storage = object.__new__(S3Storage)
    storage.aws_storage_bucket_name = "bucket"
    storage.s3_client = mock.Mock()
    body = io.BytesIO(data)
    storage.s3_client.get_object.return_value = {
        "Body": body, "ContentType": PSD, "ContentEncoding": "gzip",
        "ContentLength": len(data), "ETag": '"verified-etag"', **metadata,
    }
    return storage, body


def test_verification_streams_and_validates_all_gzip_members():
    first, second = b"8BPS" * 50000, b"second member" * 10000
    encoded = gzip.compress(first) + gzip.compress(second)
    storage, body = stored_body(encoded)
    assert storage.verify_gzip_object("key", len(first) + len(second), len(encoded), PSD) == '"verified-etag"'
    assert body.closed
    storage.s3_client.get_object.assert_called_once_with(Bucket="bucket", Key="key")


@pytest.mark.parametrize("kind", ["raw", "empty", "truncated", "crc", "oversized", "undersized", "extra-member"])
def test_corrupt_or_falsely_sized_upload_is_rejected_and_stream_closed(kind):
    original = b"8BPS" * 10000
    encoded = gzip.compress(original)
    declared = len(original)
    if kind == "raw":
        encoded = original
    elif kind == "empty":
        encoded = b""
    elif kind == "truncated":
        encoded = encoded[:-5]
    elif kind == "crc":
        encoded = encoded[:-8] + bytes([encoded[-8] ^ 255]) + encoded[-7:]
    elif kind == "oversized":
        declared -= 1
    elif kind == "undersized":
        declared += 1
    elif kind == "extra-member":
        encoded += gzip.compress(b"unexpected second member")
    storage, body = stored_body(encoded)
    with pytest.raises(ValueError):
        storage.verify_gzip_object("key", declared, len(encoded), PSD)
    assert body.closed


@pytest.mark.parametrize(
    "metadata",
    [{"ContentEncoding": None}, {"ContentType": "application/gzip"}, {"ContentLength": 999}, {"ETag": None}],
)
def test_mismatched_storage_metadata_is_rejected(metadata):
    encoded = gzip.compress(b"8BPS")
    storage, body = stored_body(encoded, **metadata)
    with pytest.raises(ValueError):
        storage.verify_gzip_object("key", 4, len(encoded), PSD)
    assert body.closed


def test_decompression_bomb_stops_at_declared_size_plus_one():
    encoded = gzip.compress(b"x" * (8 * 1024 * 1024))
    storage, body = stored_body(encoded)
    reads = []
    real_gzip = gzip.GzipFile

    class MeasuredGzip(real_gzip):
        def read(self, size=-1):
            result = super().read(size)
            reads.append(len(result))
            return result

    with mock.patch("plane.settings.storage.gzip.GzipFile", MeasuredGzip):
        with pytest.raises(ValueError, match="exceeds"):
            storage.verify_gzip_object("key", 100, len(encoded), PSD)
    assert sum(reads) == 101
    assert body.closed


def pending_asset():
    return SimpleNamespace(
        attributes={"name": "design.psd", "size": 100, "type": PSD, "content_encoding": "gzip", "compressed_size": 80},
        asset=SimpleNamespace(name="workspace/presigned-source.psd"), workspace_id=uuid4(), pk=uuid4(),
    )


def test_promotion_uses_internal_storage_conditional_copy_and_commit_cleanup():
    asset = pending_asset()
    staging_key = asset.asset.name
    with mock.patch.object(rows, "S3Storage") as factory, mock.patch.object(rows.transaction, "on_commit") as commit:
        storage = factory.return_value
        storage.verify_gzip_object.return_value = '"verified-etag"'
        rows.verify_and_promote_attachment_upload(asset)
        factory.assert_called_once_with()
        storage.verify_gzip_object.assert_called_once_with(staging_key, 100, 80, PSD)
        assert asset.asset != staging_key
        assert asset.asset.startswith(f"{asset.workspace_id}/")
        storage.copy_object.assert_called_once_with(staging_key, asset.asset, source_etag='"verified-etag"')
        storage.delete_files.assert_not_called()
        assert commit.call_args.kwargs == {"robust": True}
        commit.call_args.args[0]()
        storage.delete_files.assert_called_once_with([staging_key])


@pytest.mark.parametrize("failure", ["invalid", "missing", "changed-during-validation"])
def test_failed_verification_or_promotion_never_switches_source_or_cleans_it(failure):
    asset = pending_asset()
    old_field = asset.asset
    with mock.patch.object(rows, "S3Storage") as factory, mock.patch.object(rows.transaction, "on_commit") as commit:
        storage = factory.return_value
        if failure == "invalid":
            storage.verify_gzip_object.side_effect = ValueError("Invalid gzip")
            expected = ValidationError
        elif failure == "missing":
            storage.verify_gzip_object.side_effect = ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
            expected = rows.AttachmentUploadUnavailable
        else:
            storage.copy_object.return_value = None
            expected = rows.AttachmentUploadUnavailable
        with pytest.raises(expected):
            rows.verify_and_promote_attachment_upload(asset)
        assert asset.asset is old_field
        commit.assert_not_called()
        storage.delete_files.assert_not_called()
        if failure != "changed-during-validation":
            storage.copy_object.assert_not_called()


def test_conditional_copy_binds_etag_and_keeps_metadata_copy_default():
    storage, _ = stored_body(b"unused")
    storage.copy_object("staging", "final", source_etag='"etag"')
    storage.s3_client.copy_object.assert_called_once_with(
        Bucket="bucket", CopySource={"Bucket": "bucket", "Key": "staging"}, Key="final", CopySourceIfMatch='"etag"',
    )


def test_legacy_attachment_needs_no_storage_verification():
    asset = SimpleNamespace(attributes={"name": "legacy.psd", "size": 100, "type": PSD})
    with mock.patch.object(rows, "S3Storage") as storage:
        rows.verify_and_promote_attachment_upload(asset)
    storage.assert_not_called()


def test_verification_failure_precedes_replacement_or_completion_mutation():
    user = SimpleNamespace(id=uuid4())
    issue = SimpleNamespace(id=uuid4(), workspace_id=uuid4(), project_id=uuid4())
    slot = SimpleNamespace(id=uuid4())
    asset = mock.Mock(pk=uuid4(), workspace_id=issue.workspace_id, project_id=issue.project_id,
                      issue_id=issue.id, attachment_slot_id=slot.id, is_uploaded=False)
    with (
        mock.patch.object(rows, "lock_attachment_issue", return_value=issue),
        mock.patch.object(rows, "require_issue_write_access"),
        mock.patch.object(rows, "get_object_or_404", side_effect=[asset, slot]),
        mock.patch.object(rows.FileAsset.objects, "select_for_update"),
        mock.patch.object(rows.IssueAttachmentSlot.objects, "select_for_update"),
        mock.patch.object(rows, "require_file_owner_or_admin"),
        mock.patch.object(rows, "require_replacement_permission"),
        mock.patch.object(rows, "verify_and_promote_attachment_upload", side_effect=ValidationError("Invalid gzip")),
        mock.patch.object(rows.FileAsset.objects, "filter") as files,
    ):
        with pytest.raises(ValidationError):
            rows.complete_attachment_asset.__wrapped__(asset, user)
        files.assert_not_called()
        asset.save.assert_not_called()
        assert not asset.is_uploaded
