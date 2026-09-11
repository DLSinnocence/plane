# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third party frameworks
from rest_framework import serializers

# Module imports
from .base import BaseSerializer
from django.db import transaction
from .issue import IssueCreateSerializer, IssueIntakeSerializer, LabelLiteSerializer, IssueDetailSerializer
from .project import ProjectLiteSerializer
from .state import StateLiteSerializer
from .user import UserLiteSerializer
from plane.db.models import Intake, IntakeIssue, Issue, StateGroup, State


class IntakeSerializer(BaseSerializer):
    project_detail = ProjectLiteSerializer(source="project", read_only=True)
    pending_issue_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = Intake
        fields = "__all__"
        read_only_fields = ["project", "workspace"]


class IntakeIssueSerializer(BaseSerializer):
    issue = IssueIntakeSerializer(read_only=True)

    class Meta:
        model = IntakeIssue
        fields = [
            "id",
            "status",
            "duplicate_to",
            "snoozed_till",
            "source",
            "issue",
            "created_by",
        ]
        read_only_fields = ["project", "workspace"]

    @transaction.atomic
    def update(self, instance, validated_data):
        instance = IntakeIssue.objects.select_for_update().get(pk=instance.pk)
        issue = Issue.objects.select_for_update().get(pk=instance.issue_id)
        instance.issue = issue
        if validated_data.get("status") == 1 and issue.state and issue.state.group == StateGroup.TRIAGE.value:
            default_state = State.objects.filter(project_id=issue.project_id, default=True).first()
            if default_state is None:
                raise serializers.ValidationError({
                    "status": "Cannot accept intake issue: No default state found for the project"
                })
            serializer = IssueCreateSerializer(
                issue, data={"state_id": str(default_state.pk)}, partial=True,
                context={**self.context, "project_id": issue.project_id, "workspace_id": issue.workspace_id},
            )
            serializer.is_valid(raise_exception=True)
            instance.issue = serializer.save()
        return super().update(instance, validated_data)

    def to_representation(self, instance):
        # Pass the annotated fields to the Issue instance if they exist
        if hasattr(instance, "label_ids"):
            instance.issue.label_ids = instance.label_ids
        return super().to_representation(instance)


class IntakeIssueDetailSerializer(BaseSerializer):
    issue = IssueDetailSerializer(read_only=True)
    duplicate_issue_detail = IssueIntakeSerializer(read_only=True, source="duplicate_to")

    class Meta:
        model = IntakeIssue
        fields = [
            "id",
            "status",
            "duplicate_to",
            "snoozed_till",
            "duplicate_issue_detail",
            "source",
            "issue",
        ]
        read_only_fields = ["project", "workspace"]

    def to_representation(self, instance):
        # Pass the annotated fields to the Issue instance if they exist
        if hasattr(instance, "assignee_ids"):
            instance.issue.assignee_ids = instance.assignee_ids
        if hasattr(instance, "label_ids"):
            instance.issue.label_ids = instance.label_ids

        return super().to_representation(instance)


class IntakeIssueLiteSerializer(BaseSerializer):
    class Meta:
        model = IntakeIssue
        fields = ["id", "status", "duplicate_to", "snoozed_till", "source"]
        read_only_fields = fields


class IssueStateIntakeSerializer(BaseSerializer):
    state_detail = StateLiteSerializer(read_only=True, source="state")
    project_detail = ProjectLiteSerializer(read_only=True, source="project")
    label_details = LabelLiteSerializer(read_only=True, source="labels", many=True)
    assignee_details = UserLiteSerializer(read_only=True, source="assignees", many=True)
    sub_issues_count = serializers.IntegerField(read_only=True)
    issue_intake = IntakeIssueLiteSerializer(read_only=True, many=True)

    class Meta:
        model = Issue
        fields = "__all__"
