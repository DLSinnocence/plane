# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Module imports
from .base import BaseSerializer
from django.db import transaction
from .issue import IssueSerializer, IssueExpandSerializer
from plane.db.models import IntakeIssue, Issue, State, StateGroup
from rest_framework import serializers


class IssueForIntakeSerializer(BaseSerializer):
    """
    Serializer for work item data within intake submissions.

    Handles essential work item fields for intake processing including
    content validation and priority assignment for triage workflows.
    """

    description = serializers.JSONField(source="description_json", required=False, allow_null=True)

    class Meta:
        model = Issue
        fields = [
            "name",
            "description",  # Deprecated
            "description_json",
            "description_html",
            "priority",
        ]
        read_only_fields = [
            "id",
            "workspace",
            "project",
            "created_by",
            "updated_by",
            "created_at",
            "updated_at",
        ]


class IntakeIssueCreateSerializer(BaseSerializer):
    """
    Serializer for creating intake work items with embedded issue data.

    Manages intake work item creation including nested issue creation,
    status assignment, and source tracking for issue queue management.
    """

    issue = IssueForIntakeSerializer(help_text="Issue data for the intake issue")

    class Meta:
        model = IntakeIssue
        fields = ["issue"]


class IntakeIssueSerializer(BaseSerializer):
    """
    Comprehensive serializer for intake work items with expanded issue details.

    Provides full intake work item data including embedded issue information,
    status tracking, and triage metadata for issue queue management.
    """

    issue_detail = IssueExpandSerializer(read_only=True, source="issue")
    inbox = serializers.UUIDField(source="intake.id", read_only=True)

    class Meta:
        model = IntakeIssue
        fields = "__all__"
        read_only_fields = [
            "id",
            "workspace",
            "project",
            "issue",
            "created_by",
            "updated_by",
            "created_at",
            "updated_at",
        ]


class IntakeIssueUpdateSerializer(BaseSerializer):
    """
    Serializer for updating intake work items and their associated issues.

    Handles intake work item modifications including status changes, triage decisions,
    and embedded issue updates for issue queue processing workflows.
    """

    issue = IssueForIntakeSerializer(required=False, help_text="Issue data to update in the intake issue")

    class Meta:
        model = IntakeIssue
        fields = [
            "status",
            "snoozed_till",
            "duplicate_to",
            "source",
            "source_email",
            "issue",
        ]
        read_only_fields = [
            "id",
            "workspace",
            "project",
            "created_by",
            "updated_by",
            "created_at",
            "updated_at",
        ]

    @transaction.atomic
    def update(self, instance, validated_data):
        instance = IntakeIssue.objects.select_for_update().get(pk=instance.pk)
        issue = Issue.objects.select_for_update().get(pk=instance.issue_id)
        instance.issue = issue
        issue_data = validated_data.pop("issue", {})
        if validated_data.get("status") == 1 and issue.state and issue.state.group == StateGroup.TRIAGE.value:
            default_state = State.objects.filter(project_id=issue.project_id, default=True).first()
            if default_state is None:
                raise serializers.ValidationError({
                    "status": "Cannot accept intake issue: No default state found for the project"
                })
            issue_data["state"] = str(default_state.pk)
        if issue_data:
            serializer = IssueSerializer(
                issue, data=issue_data, partial=True,
                context={**self.context, "project_id": issue.project_id, "workspace_id": issue.workspace_id},
            )
            serializer.is_valid(raise_exception=True)
            instance.issue = serializer.save()
        return super().update(instance, validated_data)


class IssueDataSerializer(serializers.Serializer):
    """
    Serializer for nested work item data in intake request payloads.

    Validates core work item fields within intake requests including
    content formatting, priority levels, and metadata for issue creation.
    """

    name = serializers.CharField(max_length=255, help_text="Issue name")
    description_html = serializers.CharField(required=False, allow_null=True, help_text="Issue description HTML")
    priority = serializers.ChoiceField(choices=Issue.PRIORITY_CHOICES, default="none", help_text="Issue priority")
