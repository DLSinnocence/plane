# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.conf import settings
from rest_framework import serializers

from plane.db.models import AttachmentTemplate, IssueAttachmentSlot
from .issue import IssueAttachmentSerializer


ATTACHMENT_COMPRESSION_THRESHOLD = 50 * 1024 * 1024


class AttachmentNameField(serializers.CharField):
    def __init__(self, **kwargs):
        super().__init__(max_length=100, min_length=1, trim_whitespace=True, **kwargs)

    def to_internal_value(self, data):
        if not isinstance(data, str):
            self.fail("invalid")
        return super().to_internal_value(data)


class AttachmentTemplateSerializer(serializers.ModelSerializer):
    name = AttachmentNameField()
    slots = serializers.ListField(child=AttachmentNameField(), min_length=1, max_length=50)

    def validate_slots(self, value):
        if len({name.casefold() for name in value}) != len(value):
            raise serializers.ValidationError("Slot names must be unique (case insensitive).")
        return value

    class Meta:
        model = AttachmentTemplate
        fields = ["id", "name", "slots", "created_by", "updated_at"]
        read_only_fields = ["id", "created_by", "updated_at"]
        validators = []


class IssueAttachmentSlotSerializer(serializers.ModelSerializer):
    name = AttachmentNameField()
    attachment = serializers.SerializerMethodField()

    def get_attachment(self, obj):
        attachments = getattr(obj, "current_attachments", None)
        asset = attachments[0] if attachments else None
        return IssueAttachmentSerializer(asset).data if asset else None

    class Meta:
        model = IssueAttachmentSlot
        fields = ["id", "name", "sort_order", "attachment"]
        read_only_fields = ["id", "sort_order", "attachment"]
        validators = []


class ApplyAttachmentTemplateSerializer(serializers.Serializer):
    template_id = serializers.UUIDField()


class AttachmentSlotUploadSerializer(serializers.Serializer):
    slot_id = serializers.UUIDField(required=False)
    # Limits apply to the original file, not its compressed representation.
    size = serializers.IntegerField(min_value=1, required=False)
    content_encoding = serializers.ChoiceField(choices=["gzip"], required=False)
    compressed_size = serializers.IntegerField(min_value=1, required=False)

    def validate(self, attrs):
        size = attrs.get("size", settings.FILE_SIZE_LIMIT)
        if size > settings.FILE_SIZE_LIMIT:
            raise serializers.ValidationError({"size": "File exceeds the upload size limit."})
        encoded = "content_encoding" in attrs
        if encoded != ("compressed_size" in attrs):
            raise serializers.ValidationError("content_encoding and compressed_size must be supplied together.")
        if encoded:
            if "size" not in attrs or size <= ATTACHMENT_COMPRESSION_THRESHOLD:
                raise serializers.ValidationError({"size": "Compression requires an original file larger than 50 MB."})
            # Incompressible inputs can grow slightly. Allow bounded gzip overhead
            # without letting a tiny declared original authorize an arbitrary upload.
            if attrs["compressed_size"] > size + size // 1000 + 1024:
                raise serializers.ValidationError({"compressed_size": "Compressed file exceeds the upload size limit."})
        return attrs
