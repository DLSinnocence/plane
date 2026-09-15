# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import json
import uuid

# Django imports
from django.utils import timezone
from django.core.serializers.json import DjangoJSONEncoder
from django.conf import settings
from django.http import HttpResponseRedirect
from django.db import transaction
from django.shortcuts import get_object_or_404
from plane.utils.attachment_rows import (
    complete_attachment_asset, create_attachment_asset, provision_attachment_row,
    require_replacement_permission, require_file_owner_or_admin, presign_attachment_upload,
    attachment_completion_data, attachment_slot_data,
)
from plane.app.serializers.attachment import AttachmentSlotUploadSerializer
from plane.app.views.attachment import require_slot_role, scoped_issue
from plane.db.models import IssueAttachmentSlot

# Third Party imports
from rest_framework.response import Response
from rest_framework import status
from rest_framework.parsers import MultiPartParser, FormParser

# Module imports
from .. import BaseAPIView
from plane.app.serializers import IssueAttachmentSerializer
from plane.db.models import FileAsset, Workspace
from plane.bgtasks.issue_activities_task import issue_activity
from plane.app.permissions import allow_permission, ROLE
from plane.settings.storage import S3Storage
from plane.utils.path_validator import sanitize_filename
from plane.bgtasks.storage_metadata_task import get_asset_object_metadata
from plane.utils.host import base_host
from plane.utils.issue_permissions import require_issue_write_access


class IssueAttachmentEndpoint(BaseAPIView):
    serializer_class = IssueAttachmentSerializer
    model = FileAsset
    parser_classes = (MultiPartParser, FormParser)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST])
    @transaction.atomic
    def post(self, request, slug, project_id, issue_id):
        issue = scoped_issue(slug, project_id, issue_id, lock=True)
        require_issue_write_access(request.user, issue)
        serializer = IssueAttachmentSerializer(data=request.data)
        workspace = Workspace.objects.get(slug=slug)
        if serializer.is_valid():
            serializer.save(
                attachment_slot=provision_attachment_row(issue, request.user.id),
                created_by=request.user,
                is_uploaded=True,
                project_id=project_id,
                issue_id=issue_id,
                workspace_id=workspace.id,
                entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
            )
            issue_activity.delay(
                type="attachment.activity.created",
                requested_data=None,
                actor_id=str(self.request.user.id),
                issue_id=str(self.kwargs.get("issue_id", None)),
                project_id=str(self.kwargs.get("project_id", None)),
                current_instance=json.dumps(serializer.data, cls=DjangoJSONEncoder),
                epoch=int(timezone.now().timestamp()),
                notification=True,
                origin=base_host(request=request, is_app=True),
            )
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    @allow_permission([ROLE.ADMIN], creator=True, model=FileAsset)
    @transaction.atomic
    def delete(self, request, slug, project_id, issue_id, pk):
        issue = scoped_issue(slug, project_id, issue_id, lock=True)
        require_issue_write_access(request.user, issue)
        issue_attachment = FileAsset.objects.select_for_update().filter(
            pk=pk, workspace__slug=slug, project_id=project_id, issue_id=issue_id
        ).first()
        if not issue_attachment:
            return Response(
                {"error": "Issue attachment not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        require_file_owner_or_admin(
            issue_attachment, request.user, "Only the uploader or an admin can delete this attachment."
        )
        issue_attachment.asset.delete(save=False)
        issue_attachment.delete()
        issue_activity.delay(
            type="attachment.activity.deleted",
            requested_data=None,
            actor_id=str(self.request.user.id),
            issue_id=str(self.kwargs.get("issue_id", None)),
            project_id=str(self.kwargs.get("project_id", None)),
            current_instance=None,
            epoch=int(timezone.now().timestamp()),
            notification=True,
            origin=base_host(request=request, is_app=True),
        )

        return Response(status=status.HTTP_204_NO_CONTENT)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST])
    def get(self, request, slug, project_id, issue_id):
        issue_attachments = FileAsset.objects.filter(issue_id=issue_id, workspace__slug=slug, project_id=project_id)
        serializer = IssueAttachmentSerializer(issue_attachments, many=True)
        return Response(serializer.data, status=status.HTTP_200_OK)


class IssueAttachmentV2Endpoint(BaseAPIView):
    serializer_class = IssueAttachmentSerializer
    model = FileAsset

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST])
    @transaction.atomic
    def post(self, request, slug, project_id, issue_id):
        issue = scoped_issue(slug, project_id, issue_id, lock=True)
        require_issue_write_access(request.user, issue)
        slot_data = AttachmentSlotUploadSerializer(data=request.data)
        slot_data.is_valid(raise_exception=True)
        slot = None
        if "slot_id" in slot_data.validated_data:
            slot = get_object_or_404(
                IssueAttachmentSlot.objects.select_for_update(),
                pk=slot_data.validated_data["slot_id"],
                workspace_id=issue.workspace_id,
                project_id=project_id,
                issue_id=issue_id,
            )
            require_replacement_permission(slot, request.user)
        name = sanitize_filename(request.data.get("name")) or "unnamed"
        type = request.data.get("type", False)
        size = int(request.data.get("size", settings.FILE_SIZE_LIMIT))

        if not type or type not in settings.ATTACHMENT_MIME_TYPES:
            return Response(
                {"error": "Invalid file type.", "status": False},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Get the workspace
        workspace = Workspace.objects.get(slug=slug)

        # asset key
        asset_key = f"{workspace.id}/{uuid.uuid4().hex}-{name}"

        # Get the size limit
        size_limit = min(size, settings.FILE_SIZE_LIMIT)

        # Create a File Asset
        asset = create_attachment_asset(
            attachment_slot=slot,
            attributes={"name": name, "type": type, "size": size_limit},
            asset=asset_key,
            size=size_limit,
            workspace_id=workspace.id,
            created_by=request.user,
            issue_id=issue_id,
            project_id=project_id,
            entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
        )

        # Get the presigned URL
        storage = S3Storage(request=request)

        # Generate a presigned URL to share an S3 object
        presigned_url = presign_attachment_upload(storage, asset, type, size_limit)

        # Return the presigned URL
        return Response(
            {
                "upload_data": presigned_url,
                "asset_id": str(asset.id),
                "attachment_slot_id": str(asset.attachment_slot_id),
                "attachment_slot": attachment_slot_data(asset.attachment_slot),
                "attachment": IssueAttachmentSerializer(asset).data,
                "asset_url": asset.asset_url,
            },
            status=status.HTTP_200_OK,
        )

    @allow_permission([ROLE.ADMIN], creator=True, model=FileAsset)
    @transaction.atomic
    def delete(self, request, slug, project_id, issue_id, pk):
        issue = scoped_issue(slug, project_id, issue_id, lock=True)
        require_issue_write_access(request.user, issue)
        issue_attachment = get_object_or_404(
            FileAsset.objects.select_for_update(),
            pk=pk,
            workspace__slug=slug,
            project_id=project_id,
            issue_id=issue_id,
        )
        require_file_owner_or_admin(
            issue_attachment, request.user, "Only the uploader or an admin can delete this attachment."
        )
        issue_attachment.is_deleted = True
        issue_attachment.deleted_at = timezone.now()
        issue_attachment.save()

        issue_activity.delay(
            type="attachment.activity.deleted",
            requested_data=None,
            actor_id=str(self.request.user.id),
            issue_id=str(issue_id),
            project_id=str(project_id),
            current_instance=None,
            epoch=int(timezone.now().timestamp()),
            notification=True,
            origin=base_host(request=request, is_app=True),
        )

        return Response(status=status.HTTP_204_NO_CONTENT)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST])
    def get(self, request, slug, project_id, issue_id, pk=None):
        if pk:
            # Get the asset
            asset = FileAsset.objects.get(id=pk, workspace__slug=slug, project_id=project_id, issue_id=issue_id)

            # Check if the asset is uploaded
            if not asset.is_uploaded:
                return Response(
                    {"error": "The asset is not uploaded.", "status": False},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            storage = S3Storage(request=request)
            presigned_url = storage.generate_presigned_url(
                object_name=asset.asset.name,
                disposition="attachment",
                filename=asset.attributes.get("name"),
            )
            return HttpResponseRedirect(presigned_url)

        # Get all the attachments
        issue_attachments = FileAsset.objects.filter(
            issue_id=issue_id,
            entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
            workspace__slug=slug,
            project_id=project_id,
            is_uploaded=True,
            is_deleted=False,
        )
        # Serialize the attachments
        serializer = IssueAttachmentSerializer(issue_attachments, many=True)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST])
    @transaction.atomic
    def patch(self, request, slug, project_id, issue_id, pk):
        require_slot_role(request, slug, project_id)
        issue = scoped_issue(slug, project_id, issue_id, lock=True)
        require_issue_write_access(request.user, issue)
        issue_attachment = get_object_or_404(
            FileAsset.objects.select_for_update(),
            pk=pk,
            workspace__slug=slug,
            project_id=project_id,
            issue_id=issue_id,
            is_deleted=False,
            entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
        )
        issue_attachment, completed = complete_attachment_asset(issue_attachment, request.user)
        if not completed:
            return Response(attachment_completion_data(issue_attachment), status=status.HTTP_200_OK)
        serialized = json.dumps(IssueAttachmentSerializer(issue_attachment).data, cls=DjangoJSONEncoder)
        # Publication failures are logged by Django after commit and must not
        # turn an already successful replacement into an HTTP failure.
        transaction.on_commit(
            lambda: issue_activity.delay(
                type="attachment.activity.created",
                requested_data=None,
                actor_id=str(request.user.id),
                issue_id=str(issue_id),
                project_id=str(project_id),
                current_instance=serialized,
                epoch=int(timezone.now().timestamp()),
                notification=True,
                origin=base_host(request=request, is_app=True),
            ),
            robust=True,
        )
        if not issue_attachment.storage_metadata:
            transaction.on_commit(
                lambda: get_asset_object_metadata.delay(str(issue_attachment.id)),
                robust=True,
            )
        return Response(attachment_completion_data(issue_attachment), status=status.HTTP_200_OK)
