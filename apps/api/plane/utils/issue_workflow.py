# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from uuid import UUID

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied

from plane.db.models import Issue, IssueAssignee, ProjectMember, State, WorkspaceMember


class IssueWorkflowSerializerMixin:
    """Authorize persisted responsibility and save each handoff under the issue lock."""

    workflow_state_field = "state"
    workflow_assignee_field = "assignees"

    def to_internal_value(self, data):
        aliases = {"state", "state_id", "assignees", "assignee_ids"}
        aliases -= {self.workflow_state_field, self.workflow_assignee_field}
        for alias in aliases:
            if alias in data:
                raise serializers.ValidationError({alias: "Use the endpoint's canonical workflow field."})
        return super().to_internal_value(data)

    @transaction.atomic
    def save(self, **kwargs):
        if self.instance is not None:
            self.instance = Issue.objects.select_for_update().get(pk=self.instance.pk)
        return super().save(**kwargs)

    def _workflow_project_id(self):
        return self.instance.project_id if self.instance is not None else self.context.get("project_id")

    def _validate_workflow_members(self, value):
        if not isinstance(value, (list, tuple)):
            raise serializers.ValidationError("Assignees must be a list of user IDs.")
        try:
            members = list(dict.fromkeys(str(UUID(str(getattr(member, "pk", member)))) for member in value))
        except (ValueError, TypeError, AttributeError):
            raise serializers.ValidationError("Assignees must be user UUIDs.")
        valid = {
            str(pk)
            for pk in ProjectMember.objects.filter(
                project_id=self._workflow_project_id(),
                is_active=True,
                role__gte=15,
                member__is_active=True,
                member_id__in=members,
            ).values_list("member_id", flat=True)
        }
        if set(members) - valid:
            raise serializers.ValidationError("Every assignee must be an active project member with member access.")
        return members

    def validate_state_assignees(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError("Expected an object mapping state IDs to user ID lists.")
        normalized = {}
        try:
            for state_id, members in value.items():
                if not isinstance(state_id, str) or not isinstance(members, list):
                    raise ValueError
                key = str(UUID(state_id))
                if key in normalized or any(not isinstance(member, str) for member in members):
                    raise ValueError
                normalized[key] = self._validate_workflow_members(members)
        except (ValueError, TypeError, AttributeError):
            raise serializers.ValidationError("State and user IDs must be UUIDs, with a list for every state.")
        valid_states = {
            str(pk)
            for pk in State.all_state_objects.filter(
                project_id=self._workflow_project_id(),
                deleted_at__isnull=True,
                pk__in=normalized,
            ).values_list("pk", flat=True)
        }
        if set(normalized) - valid_states:
            raise serializers.ValidationError("Every state must belong to this project.")
        return normalized

    def _validate_workflow_save(self, data, issue=None):
        for alias in {"state_id", "assignees", "assignee_ids"} - {self.workflow_assignee_field}:
            if alias in data:
                raise serializers.ValidationError({alias: "Use the canonical serializer save field."})
        if issue is not None:
            for field in ("created_by", "project", "workspace"):
                for alias in (field, f"{field}_id"):
                    if alias in data:
                        value = getattr(data[alias], "pk", data[alias])
                        if str(value) != str(getattr(issue, f"{field}_id")):
                            raise serializers.ValidationError({alias: "This field cannot be changed."})
                        data.pop(alias)
        if "state" in data and data["state"] is not None:
            state_id = getattr(data["state"], "pk", data["state"])
            manager = State.all_state_objects if self.context.get("allow_triage_state") else State.objects
            try:
                state = manager.filter(
                    project_id=self._workflow_project_id(),
                    deleted_at__isnull=True,
                    pk=state_id,
                ).first()
            except (ValueError, TypeError, DjangoValidationError):
                state = None
            if state is None:
                raise serializers.ValidationError({"state": "State must belong to this project."})
            data["state"] = state
        if "state_assignees" in data:
            data["state_assignees"] = self.validate_state_assignees(data["state_assignees"])
        if self.workflow_assignee_field in data:
            data[self.workflow_assignee_field] = self._validate_workflow_members(data[self.workflow_assignee_field])

    def _authorize_workflow(self, issue, data):
        next_state = data.get("state", issue.state)
        if next_state is None:
            next_state = (
                State.objects.filter(project_id=issue.project_id, default=True).first()
                or State.objects.filter(project_id=issue.project_id).first()
            )
            if "state" in data:
                data["state"] = next_state
        changing_state = getattr(next_state, "pk", None) != issue.state_id
        changing_assignment = "state_assignees" in data or self.workflow_assignee_field in data
        if not changing_state and not changing_assignment:
            return
        actor = getattr(self.context.get("request"), "user", None)
        actor_id = getattr(actor, "pk", None)
        membership = (
            ProjectMember.objects.filter(
                project_id=issue.project_id,
                member_id=actor_id,
                is_active=True,
                member__is_active=True,
            ).first()
            if actor_id and getattr(actor, "is_active", False)
            else None
        )
        administrator = membership is not None and (
            membership.role == 20
            or WorkspaceMember.objects.filter(
                workspace_id=issue.workspace_id, member_id=actor_id, role=20, is_active=True
            ).exists()
        )
        owner = membership is not None and membership.role >= 15 and actor_id == issue.created_by_id
        if changing_assignment and not (administrator or owner):
            raise PermissionDenied("Only the work item owner or administrators may change workflow assignments.")
        if not changing_state:
            return
        transition_manager = administrator or (
            membership is not None and membership.role >= 15 and issue.project.project_lead_id == actor_id
        )
        key = str(issue.state_id)
        actual = [str(pk) for pk in IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True)]
        current = issue.state_assignees[key] if key in issue.state_assignees else actual
        responsible = membership is not None and membership.role >= 15 and str(actor_id) in (current or [])
        if not (transition_manager or responsible):
            raise PermissionDenied(
                "Only current responsible members, project admins, or the project lead may change state."
            )

    def _replace_workflow_assignees(self, issue, members):
        IssueAssignee.objects.filter(issue=issue).delete()
        IssueAssignee.objects.bulk_create(
            [
                IssueAssignee(
                    issue=issue,
                    project_id=issue.project_id,
                    workspace_id=issue.workspace_id,
                    assignee_id=member,
                    created_by_id=issue.created_by_id,
                    updated_by_id=issue.updated_by_id,
                )
                for member in members
            ],
            ignore_conflicts=True,
        )
        if hasattr(issue, "_prefetched_objects_cache"):
            issue._prefetched_objects_cache.pop("assignees", None)
            issue._prefetched_objects_cache.pop("issue_assignee", None)

    @transaction.atomic
    def create(self, validated_data):
        self._validate_workflow_save(validated_data)
        direct = validated_data.get(self.workflow_assignee_field)
        issue = self.create_workflow_issue(validated_data)
        key = str(issue.state_id)
        if key in issue.state_assignees:
            members = issue.state_assignees[key]
            if direct is not None and set(direct) != set(members):
                raise serializers.ValidationError(
                    {self.workflow_assignee_field: "Assignees conflict with the state's configured assignment."}
                )
            self._replace_workflow_assignees(issue, members)
        elif direct is not None:
            self._replace_workflow_assignees(issue, direct)
        return issue

    @transaction.atomic
    def update(self, instance, validated_data):
        issue = Issue.objects.select_for_update().get(pk=instance.pk)
        self.instance = issue
        self._validate_workflow_save(validated_data, issue)
        self._authorize_workflow(issue, validated_data)
        plan = dict(validated_data.get("state_assignees", issue.state_assignees))
        next_state = validated_data.get("state", issue.state)
        key = str(getattr(next_state, "pk", None))
        changing_state = getattr(next_state, "pk", None) != issue.state_id
        direct = validated_data.get(self.workflow_assignee_field)
        if key in plan:
            if direct is not None:
                if (changing_state or "state_assignees" in validated_data) and set(direct) != set(plan[key]):
                    raise serializers.ValidationError(
                        {self.workflow_assignee_field: "Assignees conflict with the state's configured assignment."}
                    )
                if not changing_state:
                    plan[key] = direct
                    validated_data["state_assignees"] = plan
            if changing_state or "state_assignees" in validated_data:
                validated_data[self.workflow_assignee_field] = self._validate_workflow_members(plan[key])
        return self.update_workflow_issue(issue, validated_data)


# Compatibility for existing imports.
IssueWorkflowMixin = IssueWorkflowSerializerMixin
