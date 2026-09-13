# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.db import transaction
from django.db.models import Prefetch
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.serializers.attachment import (
    AttachmentTemplateSerializer,
    IssueAttachmentSlotSerializer,
    ApplyAttachmentTemplateSerializer,
)
from plane.db.models import (
    AttachmentTemplate,
    IssueAttachmentSlot,
    FileAsset,
    Issue,
    Workspace,
    ProjectMember,
    WorkspaceMember,
)
from .base import BaseAPIView


def require_workspace_access(request, slug):
    if (
        not request.user.is_active
        or not WorkspaceMember.objects.filter(
            workspace__slug=slug,
            workspace__deleted_at__isnull=True,
            member=request.user,
            member__is_active=True,
            is_active=True,
        ).exists()
    ):
        raise PermissionDenied("You don't have the required permissions.")


def require_slot_role(request, slug, project_id, write=False):
    require_workspace_access(request, slug)
    roles = [ROLE.ADMIN.value, ROLE.MEMBER.value] if write else [ROLE.ADMIN.value, ROLE.MEMBER.value, ROLE.GUEST.value]
    if not ProjectMember.objects.filter(
        workspace__slug=slug,
        project_id=project_id,
        member=request.user,
        is_active=True,
        role__in=roles,
        project__workspace__slug=slug,
        project__deleted_at__isnull=True,
    ).exists():
        raise PermissionDenied("You don't have the required permissions.")


def scoped_issue(slug, project_id, issue_id, lock=False):
    queryset = Issue.objects.select_for_update() if lock else Issue.objects.all()
    return get_object_or_404(
        queryset,
        pk=issue_id,
        project_id=project_id,
        workspace__slug=slug,
        project__workspace__slug=slug,
        project__deleted_at__isnull=True,
    )


def scoped_slots(issue):
    return IssueAttachmentSlot.objects.filter(
        issue=issue,
        project_id=issue.project_id,
        workspace_id=issue.workspace_id,
    ).prefetch_related(
        Prefetch(
            "attachments",
            queryset=FileAsset.objects.filter(
                is_uploaded=True,
                is_deleted=False,
                issue=issue,
                project_id=issue.project_id,
                workspace_id=issue.workspace_id,
                entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
            ).select_related("workspace"),
            to_attr="current_attachments",
        )
    )


def check_name(queryset, name):
    if any(existing.casefold() == name.casefold() for existing in queryset.values_list("name", flat=True)):
        raise ValidationError({"name": "A name already exists (case insensitive)."})


class AttachmentTemplateEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug):
        require_workspace_access(request, slug)
        templates = AttachmentTemplate.objects.filter(workspace__slug=slug)
        return Response(AttachmentTemplateSerializer(templates, many=True).data)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    @transaction.atomic
    def post(self, request, slug):
        require_workspace_access(request, slug)
        workspace = get_object_or_404(Workspace.objects.select_for_update(), slug=slug)
        serializer = AttachmentTemplateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        check_name(AttachmentTemplate.objects.filter(workspace=workspace), serializer.validated_data["name"])
        template = serializer.save(workspace=workspace, created_by=request.user)
        return Response(AttachmentTemplateSerializer(template).data, status=201)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    @transaction.atomic
    def patch(self, request, slug, template_id):
        require_workspace_access(request, slug)
        workspace = get_object_or_404(Workspace.objects.select_for_update(), slug=slug)
        template = get_object_or_404(AttachmentTemplate.objects, workspace=workspace, pk=template_id)
        serializer = AttachmentTemplateSerializer(template, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        if "name" in serializer.validated_data:
            check_name(
                AttachmentTemplate.objects.filter(workspace=workspace).exclude(pk=template_id),
                serializer.validated_data["name"],
            )
        serializer.save(updated_by=request.user)
        return Response(serializer.data)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    @transaction.atomic
    def delete(self, request, slug, template_id):
        require_workspace_access(request, slug)
        workspace = get_object_or_404(Workspace.objects.select_for_update(), slug=slug)
        template = get_object_or_404(AttachmentTemplate.objects, workspace=workspace, pk=template_id)
        AttachmentTemplate.objects.filter(pk=template.pk).update(deleted_at=timezone.now())
        return Response(status=204)


class IssueAttachmentSlotEndpoint(BaseAPIView):
    def get(self, request, slug, project_id, issue_id):
        require_slot_role(request, slug, project_id)
        issue = scoped_issue(slug, project_id, issue_id)
        return Response(IssueAttachmentSlotSerializer(scoped_slots(issue), many=True).data)

    @transaction.atomic
    def post(self, request, slug, project_id, issue_id):
        require_slot_role(request, slug, project_id, write=True)
        issue = scoped_issue(slug, project_id, issue_id, lock=True)
        serializer = IssueAttachmentSlotSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        slots = scoped_slots(issue)
        check_name(slots, serializer.validated_data["name"])
        if slots.count() >= 50:
            raise ValidationError({"error": "An issue may have at most 50 attachment slots."})
        order = max(slots.values_list("sort_order", flat=True), default=-1) + 1
        slot = serializer.save(
            issue=issue,
            project=issue.project,
            workspace_id=issue.workspace_id,
            sort_order=order,
            created_by=request.user,
        )
        return Response(IssueAttachmentSlotSerializer(slot).data, status=201)

    @transaction.atomic
    def patch(self, request, slug, project_id, issue_id, slot_id):
        require_slot_role(request, slug, project_id, write=True)
        issue = scoped_issue(slug, project_id, issue_id, lock=True)
        slot = get_object_or_404(scoped_slots(issue), pk=slot_id)
        serializer = IssueAttachmentSlotSerializer(slot, data=request.data)
        serializer.is_valid(raise_exception=True)
        check_name(scoped_slots(issue).exclude(pk=slot_id), serializer.validated_data["name"])
        serializer.save(updated_by=request.user)
        return Response(serializer.data)

    @transaction.atomic
    def delete(self, request, slug, project_id, issue_id, slot_id):
        require_slot_role(request, slug, project_id, write=True)
        issue = scoped_issue(slug, project_id, issue_id, lock=True)
        slot = get_object_or_404(scoped_slots(issue).select_for_update(), pk=slot_id)
        # Soft deletion does not execute SET_NULL. Unlink even pending/deleted assets
        # before marking the slot deleted, preserving them as ordinary attachments.
        FileAsset.all_objects.filter(attachment_slot=slot).update(attachment_slot=None)
        IssueAttachmentSlot.objects.filter(pk=slot.pk).update(deleted_at=timezone.now())
        return Response(status=204)


class ApplyAttachmentTemplateEndpoint(BaseAPIView):
    @transaction.atomic
    def post(self, request, slug, project_id, issue_id):
        require_slot_role(request, slug, project_id, write=True)
        issue = scoped_issue(slug, project_id, issue_id, lock=True)
        serializer = ApplyAttachmentTemplateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        template = get_object_or_404(
            AttachmentTemplate.objects,
            pk=serializer.validated_data["template_id"],
            workspace_id=issue.workspace_id,
        )
        slots = list(scoped_slots(issue))
        existing = {slot.name.casefold() for slot in slots}
        missing = [name for name in template.slots if name.casefold() not in existing]
        if len(slots) + len(missing) > 50:
            raise ValidationError({"error": "An issue may have at most 50 attachment slots."})
        order = max((slot.sort_order for slot in slots), default=-1) + 1
        for index, name in enumerate(missing):
            IssueAttachmentSlot.objects.create(
                issue=issue,
                project=issue.project,
                workspace_id=issue.workspace_id,
                name=name,
                sort_order=order + index,
                created_by=request.user,
            )
        return Response(IssueAttachmentSlotSerializer(scoped_slots(issue), many=True).data)
