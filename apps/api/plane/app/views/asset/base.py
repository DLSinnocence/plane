# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third party imports
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser

# Module imports
from ..base import BaseAPIView, BaseViewSet
from plane.app.permissions import WorkspaceMemberPermission
from plane.db.models import FileAsset, Workspace
from plane.app.serializers import FileAssetSerializer
from django.db import transaction
from plane.app.views.attachment import require_slot_role, scoped_issue
from plane.utils.attachment_rows import provision_attachment_row


class FileAssetEndpoint(BaseAPIView):
    parser_classes = (MultiPartParser, FormParser, JSONParser)
    permission_classes = [IsAuthenticated, WorkspaceMemberPermission]

    """
    A viewset for viewing and editing task instances.
    """

    def get(self, request, workspace_id, asset_key):
        asset_key = str(workspace_id) + "/" + asset_key
        files = FileAsset.objects.filter(asset=asset_key)
        if files.exists():
            serializer = FileAssetSerializer(files, context={"request": request}, many=True)
            return Response({"data": serializer.data, "status": True}, status=status.HTTP_200_OK)
        else:
            return Response(
                {"error": "Asset key does not exist", "status": False},
                status=status.HTTP_200_OK,
            )

    @transaction.atomic
    def post(self, request, slug):
        # WorkspaceMemberPermission already rejects unknown slugs before this runs.
        # Use .get() so any TOCTOU race still surfaces as a 404 via ObjectDoesNotExist.
        workspace = Workspace.objects.get(slug=slug)
        serializer = FileAssetSerializer(data=request.data)
        if serializer.is_valid():
            issue = serializer.validated_data.get("issue")
            if serializer.validated_data.get("entity_type") == FileAsset.EntityTypeContext.ISSUE_ATTACHMENT and issue:
                require_slot_role(request, slug, issue.project_id)
                issue = scoped_issue(slug, issue.project_id, issue.id, lock=True)
                serializer.save(
                    workspace_id=workspace.id, project=issue.project, issue=issue,
                    attachment_slot=provision_attachment_row(issue, request.user.id),
                    created_by=request.user, is_uploaded=True,
                )
            else:
                serializer.save(workspace_id=workspace.id)
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    def delete(self, request, workspace_id, asset_key):
        asset_key = str(workspace_id) + "/" + asset_key
        file_asset = FileAsset.objects.get(asset=asset_key)
        file_asset.is_deleted = True
        file_asset.save(update_fields=["is_deleted"])
        return Response(status=status.HTTP_204_NO_CONTENT)


class FileAssetViewSet(BaseViewSet):
    permission_classes = [IsAuthenticated, WorkspaceMemberPermission]

    def restore(self, request, workspace_id, asset_key):
        asset_key = str(workspace_id) + "/" + asset_key
        file_asset = FileAsset.objects.get(asset=asset_key)
        if file_asset.attachment_slot_id or file_asset.entity_type == FileAsset.EntityTypeContext.ISSUE_ATTACHMENT:
            return Response({"error": "Deleted work item attachments cannot be restored."}, status=400)
        file_asset.is_deleted = False
        file_asset.save(update_fields=["is_deleted"])
        return Response(status=status.HTTP_204_NO_CONTENT)


class UserAssetsEndpoint(BaseAPIView):
    parser_classes = (MultiPartParser, FormParser)

    def get(self, request, asset_key):
        files = FileAsset.objects.filter(asset=asset_key, created_by=request.user)
        if files.exists():
            serializer = FileAssetSerializer(files, context={"request": request})
            return Response({"data": serializer.data, "status": True}, status=status.HTTP_200_OK)
        else:
            return Response(
                {"error": "Asset key does not exist", "status": False},
                status=status.HTTP_200_OK,
            )

    def post(self, request):
        serializer = FileAssetSerializer(data=request.data)
        if serializer.is_valid():
            if serializer.validated_data.get("entity_type") == FileAsset.EntityTypeContext.ISSUE_ATTACHMENT:
                return Response({"error": "Use the issue attachment endpoint for work item attachments."}, status=400)
            serializer.save()
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    def delete(self, request, asset_key):
        file_asset = FileAsset.objects.get(asset=asset_key, created_by=request.user)
        file_asset.is_deleted = True
        file_asset.save(update_fields=["is_deleted"])
        return Response(status=status.HTTP_204_NO_CONTENT)
