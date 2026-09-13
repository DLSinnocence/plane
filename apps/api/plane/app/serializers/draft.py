# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.db import transaction
from django.utils import timezone

# Third Party imports
from rest_framework import serializers

# Module imports
from .base import BaseSerializer
from .issue import IssueCreateSerializer
from plane.utils.issue_workflow import complete_workflow_plan, workflow_default_assignees
from plane.db.models import (
    Issue,
    Label,
    State,
    DraftIssue,
    DraftIssueAssignee,
    DraftIssueLabel,
    DraftIssueCycle,
    DraftIssueModule,
    EstimatePoint,
)
from plane.utils.content_validator import (
    validate_html_content,
    validate_binary_data,
)


class DraftIssueCreateSerializer(BaseSerializer):
    # ids
    state_id = serializers.PrimaryKeyRelatedField(
        source="state", queryset=State.objects.all(), required=False, allow_null=True
    )
    parent_id = serializers.PrimaryKeyRelatedField(
        source="parent", queryset=Issue.objects.all(), required=False, allow_null=True
    )
    label_ids = serializers.ListField(
        child=serializers.PrimaryKeyRelatedField(queryset=Label.objects.all()),
        write_only=True,
        required=False,
    )
    assignee_ids = serializers.SerializerMethodField()

    def get_assignee_ids(self, instance):
        return [
            str(pk)
            for pk in DraftIssueAssignee.objects.filter(draft_issue=instance).values_list("assignee_id", flat=True)
        ]

    def to_internal_value(self, data):
        for field in ("assignee_ids", "assignees"):
            if field in data:
                raise serializers.ValidationError({field: "Configure assignees through state_assignees."})
        return super().to_internal_value(data)

    def validate_state_assignees(self, value):
        return IssueCreateSerializer(context=self.context).validate_state_assignees(value)

    def _save_workflow(self, issue, *, validate_fixed):
        issue.state_assignees = (
            complete_workflow_plan(issue, issue.state_assignees or {}, validate_fixed=validate_fixed)
            if issue.project_id
            else {}
        )
        issue.save(update_fields=["state_assignees"], disable_auto_set_user=True)
        members = issue.state_assignees.get(str(issue.state_id), workflow_default_assignees(issue))
        DraftIssueAssignee.objects.filter(draft_issue=issue).delete()
        DraftIssueAssignee.objects.bulk_create(
            [
                DraftIssueAssignee(
                    draft_issue=issue,
                    assignee_id=member,
                    workspace_id=issue.workspace_id,
                    project_id=issue.project_id,
                    created_by_id=issue.created_by_id,
                    updated_by_id=issue.updated_by_id,
                )
                for member in members
            ]
        )
        if hasattr(issue, "_prefetched_objects_cache"):
            issue._prefetched_objects_cache.pop("assignees", None)
        return issue

    class Meta:
        model = DraftIssue
        fields = "__all__"
        read_only_fields = [
            "workspace",
            "project",
            "assignees",
            "created_by",
            "updated_by",
            "created_at",
            "updated_at",
        ]

    def to_representation(self, instance):
        data = super().to_representation(instance)
        label_ids = self.initial_data.get("label_ids")
        data["label_ids"] = label_ids if label_ids else []
        return data

    def validate(self, attrs):
        if (
            attrs.get("start_date", None) is not None
            and attrs.get("target_date", None) is not None
            and attrs.get("start_date", None) > attrs.get("target_date", None)
        ):
            raise serializers.ValidationError("Start date cannot exceed target date")

        # Validate description content for security
        if "description_html" in attrs and attrs["description_html"]:
            is_valid, error_msg, sanitized_html = validate_html_content(attrs["description_html"])
            if not is_valid:
                raise serializers.ValidationError({"error": "html content is not valid"})
            # Update the attrs with sanitized HTML if available
            if sanitized_html is not None:
                attrs["description_html"] = sanitized_html

        if "description_binary" in attrs and attrs["description_binary"]:
            is_valid, error_msg = validate_binary_data(attrs["description_binary"])
            if not is_valid:
                raise serializers.ValidationError({"description_binary": "Invalid binary data"})

        # Validate labels are from project
        if attrs.get("label_ids"):
            label_ids = [label.id for label in attrs["label_ids"]]
            attrs["label_ids"] = list(
                Label.objects.filter(project_id=self.context.get("project_id"), id__in=label_ids).values_list(
                    "id", flat=True
                )
            )

        # # Check state is from the project only else raise validation error
        if (
            attrs.get("state")
            and not State.objects.filter(
                project_id=self.context.get("project_id"),
                pk=attrs.get("state").id,
            ).exists()
        ):
            raise serializers.ValidationError("State is not valid please pass a valid state_id")

        # # Check parent issue is from workspace as it can be cross workspace
        if (
            attrs.get("parent")
            and not Issue.objects.filter(
                project_id=self.context.get("project_id"),
                pk=attrs.get("parent").id,
            ).exists()
        ):
            raise serializers.ValidationError("Parent is not valid issue_id please pass a valid issue_id")

        if (
            attrs.get("estimate_point")
            and not EstimatePoint.objects.filter(
                project_id=self.context.get("project_id"),
                pk=attrs.get("estimate_point").id,
            ).exists()
        ):
            raise serializers.ValidationError("Estimate point is not valid please pass a valid estimate_point_id")

        return attrs

    @transaction.atomic
    def create(self, validated_data):
        validate_fixed = "state_assignees" in validated_data
        labels = validated_data.pop("label_ids", None)
        modules = validated_data.pop("module_ids", None)
        cycle_id = self.initial_data.get("cycle_id", None)
        modules = self.initial_data.get("module_ids", None)

        workspace_id = self.context["workspace_id"]
        project_id = self.context["project_id"]

        # Create Issue
        issue = DraftIssue.objects.create(**validated_data, workspace_id=workspace_id, project_id=project_id)

        # Issue Audit Users
        created_by_id = issue.created_by_id
        updated_by_id = issue.updated_by_id

        if labels is not None and len(labels):
            DraftIssueLabel.objects.bulk_create(
                [
                    DraftIssueLabel(
                        label_id=label_id,
                        draft_issue=issue,
                        project_id=project_id,
                        workspace_id=workspace_id,
                        created_by_id=created_by_id,
                        updated_by_id=updated_by_id,
                    )
                    for label_id in labels
                ],
                batch_size=10,
            )

        if cycle_id is not None:
            DraftIssueCycle.objects.create(
                cycle_id=cycle_id,
                draft_issue=issue,
                project_id=project_id,
                workspace_id=workspace_id,
                created_by_id=created_by_id,
                updated_by_id=updated_by_id,
            )

        if modules is not None and len(modules):
            DraftIssueModule.objects.bulk_create(
                [
                    DraftIssueModule(
                        module_id=module_id,
                        draft_issue=issue,
                        project_id=project_id,
                        workspace_id=workspace_id,
                        created_by_id=created_by_id,
                        updated_by_id=updated_by_id,
                    )
                    for module_id in modules
                ],
                batch_size=10,
            )

        return self._save_workflow(issue, validate_fixed=validate_fixed)

    @transaction.atomic
    def update(self, instance, validated_data):
        validate_fixed = "state_assignees" in validated_data
        project_id = self.context.get("project_id", instance.project_id)
        if str(project_id) != str(instance.project_id):
            validated_data["project_id"] = project_id
            validated_data.setdefault("state", None)
            validated_data.setdefault("state_assignees", {})
        labels = validated_data.pop("label_ids", None)
        cycle_id = self.context.get("cycle_id", "not_provided")
        modules = self.initial_data.get("module_ids", None)

        # Related models
        workspace_id = instance.workspace_id

        created_by_id = instance.created_by_id
        updated_by_id = instance.updated_by_id

        if labels is not None:
            DraftIssueLabel.objects.filter(draft_issue=instance).delete()
            DraftIssueLabel.objects.bulk_create(
                [
                    DraftIssueLabel(
                        label_id=label,
                        draft_issue=instance,
                        workspace_id=workspace_id,
                        project_id=project_id,
                        created_by_id=created_by_id,
                        updated_by_id=updated_by_id,
                    )
                    for label in labels
                ],
                batch_size=10,
            )

        if cycle_id != "not_provided":
            DraftIssueCycle.objects.filter(draft_issue=instance).delete()
            if cycle_id:
                DraftIssueCycle.objects.create(
                    cycle_id=cycle_id,
                    draft_issue=instance,
                    workspace_id=workspace_id,
                    project_id=project_id,
                    created_by_id=created_by_id,
                    updated_by_id=updated_by_id,
                )

        if modules is not None:
            DraftIssueModule.objects.filter(draft_issue=instance).delete()
            DraftIssueModule.objects.bulk_create(
                [
                    DraftIssueModule(
                        module_id=module_id,
                        draft_issue=instance,
                        workspace_id=workspace_id,
                        project_id=project_id,
                        created_by_id=created_by_id,
                        updated_by_id=updated_by_id,
                    )
                    for module_id in modules
                ],
                batch_size=10,
            )

        # Time updation occurs even when other related models are updated
        instance.updated_at = timezone.now()
        instance = super().update(instance, validated_data)
        return self._save_workflow(instance, validate_fixed=validate_fixed)


class DraftIssueSerializer(BaseSerializer):
    # ids
    cycle_id = serializers.PrimaryKeyRelatedField(read_only=True)
    module_ids = serializers.ListField(child=serializers.UUIDField(), required=False)

    # Many to many
    label_ids = serializers.ListField(child=serializers.UUIDField(), required=False)
    assignee_ids = serializers.ListField(child=serializers.UUIDField(), required=False)

    class Meta:
        model = DraftIssue
        fields = [
            "id",
            "name",
            "state_id",
            "state_assignees",
            "sort_order",
            "completed_at",
            "estimate_point",
            "priority",
            "start_date",
            "target_date",
            "project_id",
            "parent_id",
            "cycle_id",
            "module_ids",
            "label_ids",
            "assignee_ids",
            "created_at",
            "updated_at",
            "created_by",
            "updated_by",
            "type_id",
            "description_html",
        ]
        read_only_fields = fields


class DraftIssueDetailSerializer(DraftIssueSerializer):
    description_html = serializers.CharField()

    class Meta(DraftIssueSerializer.Meta):
        fields = DraftIssueSerializer.Meta.fields + ["description_html"]
        read_only_fields = fields
