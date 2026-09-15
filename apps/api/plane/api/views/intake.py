# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import json
from functools import partial

# Django imports
from django.core.serializers.json import DjangoJSONEncoder
from django.db import transaction
from django.utils import timezone
from django.db.models import Q, Value, UUIDField
from django.db.models.functions import Coalesce
from django.contrib.postgres.aggregates import ArrayAgg
from django.contrib.postgres.fields import ArrayField

# Third party imports
from rest_framework import status
from rest_framework.response import Response
from drf_spectacular.utils import OpenApiResponse, OpenApiRequest

# Module imports
from plane.api.serializers import (
    IntakeIssueSerializer,
    IssueSerializer,
    IntakeIssueCreateSerializer,
    IntakeIssueUpdateSerializer,
)
from plane.app.permissions import ProjectLitePermission
from plane.bgtasks.issue_activities_task import issue_activity
from plane.db.models import Intake, IntakeIssue, Issue, Project, ProjectMember, State, StateGroup
from plane.utils.issue_workflow_activity import issue_activity_payload
from plane.utils.issue_permissions import (
    project_access_role, require_intake_write_access, require_project_admin_access,
)
from plane.utils.host import base_host
from plane.utils.issue_write_scope import lock_issue_delete_scope
from plane.utils.content_validator import validate_html_content
from .base import BaseAPIView
from plane.db.models.intake import SourceType
from plane.utils.openapi import (
    intake_docs,
    WORKSPACE_SLUG_PARAMETER,
    PROJECT_ID_PARAMETER,
    ISSUE_ID_PARAMETER,
    CURSOR_PARAMETER,
    PER_PAGE_PARAMETER,
    FIELDS_PARAMETER,
    EXPAND_PARAMETER,
    create_paginated_response,
    # Request Examples
    INTAKE_ISSUE_CREATE_EXAMPLE,
    INTAKE_ISSUE_UPDATE_EXAMPLE,
    # Response Examples
    INTAKE_ISSUE_EXAMPLE,
    INVALID_REQUEST_RESPONSE,
    DELETED_RESPONSE,
)


class IntakeIssueListCreateAPIEndpoint(BaseAPIView):
    """Intake Work Item List and Create Endpoint"""

    serializer_class = IntakeIssueSerializer

    model = Intake
    permission_classes = [ProjectLitePermission]
    use_read_replica = True

    def get_queryset(self):
        intake = Intake.objects.filter(
            workspace__slug=self.kwargs.get("slug"),
            project_id=self.kwargs.get("project_id"),
        ).first()

        project = Project.objects.get(workspace__slug=self.kwargs.get("slug"), pk=self.kwargs.get("project_id"))

        if intake is None or not project.intake_view:
            return IntakeIssue.objects.none()

        return (
            IntakeIssue.objects.filter(
                Q(snoozed_till__gte=timezone.now()) | Q(snoozed_till__isnull=True),
                workspace__slug=self.kwargs.get("slug"),
                project_id=self.kwargs.get("project_id"),
                intake_id=intake.id,
            )
            .select_related("issue", "workspace", "project")
            .order_by(self.kwargs.get("order_by", "-created_at"))
        )

    @intake_docs(
        operation_id="get_intake_work_items_list",
        summary="List intake work items",
        description="Retrieve all work items in the project's intake queue. Returns paginated results when listing all intake work items.",  # noqa: E501
        parameters=[
            WORKSPACE_SLUG_PARAMETER,
            PROJECT_ID_PARAMETER,
            CURSOR_PARAMETER,
            PER_PAGE_PARAMETER,
            FIELDS_PARAMETER,
            EXPAND_PARAMETER,
        ],
        responses={
            200: create_paginated_response(
                IntakeIssueSerializer,
                "PaginatedIntakeIssueResponse",
                "Paginated list of intake work items",
                "Paginated Intake Work Items",
            ),
        },
    )
    def get(self, request, slug, project_id):
        """List intake work items

        Retrieve all work items in the project's intake queue.
        Returns paginated results when listing all intake work items.
        """
        issue_queryset = self.get_queryset()
        return self.paginate(
            request=request,
            queryset=(issue_queryset),
            on_results=lambda intake_issues: IntakeIssueSerializer(
                intake_issues, many=True, fields=self.fields, expand=self.expand
            ).data,
        )

    @intake_docs(
        operation_id="create_intake_work_item",
        summary="Create intake work item",
        description="Submit a new work item to the project's intake queue for review and triage. Automatically creates the work item with default triage state and tracks activity.",  # noqa: E501
        parameters=[
            WORKSPACE_SLUG_PARAMETER,
            PROJECT_ID_PARAMETER,
        ],
        request=OpenApiRequest(
            request=IntakeIssueCreateSerializer,
            examples=[INTAKE_ISSUE_CREATE_EXAMPLE],
        ),
        responses={
            201: OpenApiResponse(
                description="Intake work item created",
                response=IntakeIssueSerializer,
                examples=[INTAKE_ISSUE_EXAMPLE],
            ),
            400: INVALID_REQUEST_RESPONSE,
        },
    )
    @transaction.atomic
    def post(self, request, slug, project_id):
        """Create intake work item

        Submit a new work item to the project's intake queue for review and triage.
        Automatically creates the work item with default triage state and tracks activity.
        """
        if not request.data.get("issue", {}).get("name", False):
            return Response({"error": "Name is required"}, status=status.HTTP_400_BAD_REQUEST)

        intake = Intake.objects.filter(workspace__slug=slug, project_id=project_id).first()

        project = Project.objects.get(workspace__slug=slug, pk=project_id)

        # Intake view
        if intake is None and not project.intake_view:
            return Response(
                {"error": "Intake is not enabled for this project enable it through the project's api"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Check for valid priority
        if request.data.get("issue", {}).get("priority", "none") not in [
            "low",
            "medium",
            "high",
            "urgent",
            "none",
        ]:
            return Response({"error": "Invalid priority"}, status=status.HTTP_400_BAD_REQUEST)

        # get the triage state
        triage_state = State.triage_objects.filter(project_id=project_id, workspace__slug=slug).first()

        if not triage_state:
            triage_state = State.objects.create(
                name="Triage",
                group=StateGroup.TRIAGE.value,
                project_id=project_id,
                workspace_id=project.workspace_id,
                color="#4E5355",
                sequence=65000,
                default=False,
            )

        # create an issue
        issue_data = request.data.get("issue", {})
        # Accept both "description" and "description_json" keys for the description_json field
        description_json = issue_data.get("description") or issue_data.get("description_json") or {}
        # Sanitize description_html before saving to prevent stored XSS (GHSA-hh2r-3hwp-mvq3)
        raw_description_html = issue_data.get("description_html", "<p></p>")
        _, _, sanitized_description_html = validate_html_content(raw_description_html)
        safe_description_html = sanitized_description_html if sanitized_description_html is not None else "<p></p>"
        issue_serializer = IssueSerializer(
            data={
                "name": issue_data.get("name"),
                "description_json": description_json,
                "description_html": safe_description_html,
                "priority": issue_data.get("priority", "none"),
                "state": str(triage_state.id),
            },
            context={
                "request": request,
                "project_id": project_id,
                "workspace_id": project.workspace_id,
                "default_assignee_id": project.default_assignee_id,
                "allow_triage_state": True,
                "intake_submission": True,
            },
        )
        issue_serializer.is_valid(raise_exception=True)
        issue = issue_serializer.save()

        # create an intake issue
        intake_issue = IntakeIssue.objects.create(
            intake_id=intake.id,
            project_id=project_id,
            issue=issue,
            source=SourceType.IN_APP,
        )
        # Create an Issue Activity
        transaction.on_commit(
            partial(
                issue_activity.delay,
                type="issue.activity.created",
                requested_data=issue_activity_payload(issue_data, issue_serializer.instance, "assignees"),
                actor_id=str(request.user.id),
                issue_id=str(issue.id),
                project_id=str(project_id),
                current_instance=None,
                epoch=int(timezone.now().timestamp()),
                intake=str(intake_issue.id),
            )
        )

        serializer = IntakeIssueSerializer(intake_issue)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class IntakeIssueDetailAPIEndpoint(BaseAPIView):
    """Intake Issue API Endpoint"""

    permission_classes = [ProjectLitePermission]

    serializer_class = IntakeIssueSerializer
    model = IntakeIssue
    use_read_replica = True

    filterset_fields = ["status"]

    def get_queryset(self):
        intake = Intake.objects.filter(
            workspace__slug=self.kwargs.get("slug"),
            project_id=self.kwargs.get("project_id"),
        ).first()

        project = Project.objects.get(workspace__slug=self.kwargs.get("slug"), pk=self.kwargs.get("project_id"))

        if intake is None or not project.intake_view:
            return IntakeIssue.objects.none()

        return (
            IntakeIssue.objects.filter(
                Q(snoozed_till__gte=timezone.now()) | Q(snoozed_till__isnull=True),
                workspace__slug=self.kwargs.get("slug"),
                project_id=self.kwargs.get("project_id"),
                intake_id=intake.id,
            )
            .select_related("issue", "workspace", "project")
            .order_by(self.kwargs.get("order_by", "-created_at"))
        )

    @intake_docs(
        operation_id="retrieve_intake_work_item",
        summary="Retrieve intake work item",
        description="Retrieve details of a specific intake work item.",
        parameters=[
            WORKSPACE_SLUG_PARAMETER,
            PROJECT_ID_PARAMETER,
            ISSUE_ID_PARAMETER,
        ],
        responses={
            200: OpenApiResponse(
                description="Intake work item",
                response=IntakeIssueSerializer,
                examples=[INTAKE_ISSUE_EXAMPLE],
            ),
        },
    )
    def get(self, request, slug, project_id, issue_id):
        """Retrieve intake work item

        Retrieve details of a specific intake work item.
        """
        intake_issue_queryset = self.get_queryset().get(issue_id=issue_id)
        intake_issue_data = IntakeIssueSerializer(intake_issue_queryset, fields=self.fields, expand=self.expand).data
        return Response(intake_issue_data, status=status.HTTP_200_OK)

    @intake_docs(
        operation_id="update_intake_work_item",
        summary="Update intake work item",
        description="Modify an existing intake work item's properties or status for triage processing. Supports status changes like accept, reject, or mark as duplicate.",  # noqa: E501
        parameters=[
            WORKSPACE_SLUG_PARAMETER,
            PROJECT_ID_PARAMETER,
            ISSUE_ID_PARAMETER,
        ],
        request=OpenApiRequest(
            request=IntakeIssueUpdateSerializer,
            examples=[INTAKE_ISSUE_UPDATE_EXAMPLE],
        ),
        responses={
            200: OpenApiResponse(
                description="Intake work item updated",
                response=IntakeIssueSerializer,
                examples=[INTAKE_ISSUE_EXAMPLE],
            ),
            400: INVALID_REQUEST_RESPONSE,
        },
    )
    @transaction.atomic
    def patch(self, request, slug, project_id, issue_id):
        """Update intake work item

        Modify an existing intake work item's properties or status for triage processing.
        Supports status changes like accept, reject, or mark as duplicate.
        """
        intake = Intake.objects.filter(workspace__slug=slug, project_id=project_id).first()

        project = Project.objects.get(workspace__slug=slug, pk=project_id)

        # Intake view
        if intake is None and not project.intake_view:
            return Response(
                {"error": "Intake is not enabled for this project enable it through the project's api"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Get and lock persisted workflow state before validating the update.
        intake_issue = IntakeIssue.objects.select_for_update().get(
            issue_id=issue_id,
            workspace__slug=slug,
            project_id=project_id,
            intake_id=intake.id,
        )
        intake_issue.issue = Issue.objects.select_for_update().get(pk=intake_issue.issue_id)
        require_intake_write_access(request.user, intake_issue.issue)
        role = project_access_role(request.user, project_id, project.workspace_id)
        if set(request.data) - {"issue"}:
            require_project_admin_access(request.user, project_id, project.workspace_id)

        # Get issue data
        issue_data = request.data.pop("issue", False)
        issue_serializer = None
        intake_serializer = None

        # Validate issue data if provided
        if bool(issue_data):
            issue = Issue.objects.annotate(
                label_ids=Coalesce(
                    ArrayAgg(
                        "labels__id",
                        distinct=True,
                        filter=Q(~Q(labels__id__isnull=True) & Q(label_issue__deleted_at__isnull=True)),
                    ),
                    Value([], output_field=ArrayField(UUIDField())),
                ),
                assignee_ids=Coalesce(
                    ArrayAgg(
                        "assignees__id",
                        distinct=True,
                        filter=Q(
                            ~Q(assignees__id__isnull=True)
                            & Q(assignees__member_project__is_active=True)
                            & Q(issue_assignee__deleted_at__isnull=True)
                        ),
                    ),
                    Value([], output_field=ArrayField(UUIDField())),
                ),
            ).get(pk=issue_id, workspace__slug=slug, project_id=project_id)

            # Only allow guests to edit name and description
            if role == 5:
                description_json = issue_data.get("description") or issue_data.get("description_json") or {}
                issue_data = {
                    "name": issue_data.get("name", issue.name),
                    "description_html": issue_data.get("description_html", issue.description_html),
                    "description_json": description_json,
                }

            issue_serializer = IssueSerializer(
                issue,
                data=issue_data,
                partial=True,
                context={
                    "request": request,
                    "project_id": project_id,
                    "workspace_id": project.workspace_id,
                    "allow_triage_state": True,
                    "intake_submission": True,
                },
            )

            if not issue_serializer.is_valid():
                return Response(issue_serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        # Only administrators may review intake submissions.
        if role == 20:
            intake_serializer = IntakeIssueUpdateSerializer(
                intake_issue,
                data=request.data,
                partial=True,
                context={
                    "request": request,
                    "project_id": project_id,
                    "workspace_id": project.workspace_id,
                    "allow_triage_state": True,
                    "intake_submission": True,
                },
            )

            if not intake_serializer.is_valid():
                return Response(intake_serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        # Snapshot before either save; acceptance can also change state and assignments.
        issue = intake_issue.issue
        issue_current_instance = json.dumps(IssueSerializer(issue).data, cls=DjangoJSONEncoder)
        previous_workflow = {
            "state": str(issue.state_id),
            "assignees": [
                str(member_id)
                for member_id in issue.issue_assignee.filter(deleted_at__isnull=True)
                .order_by("assignee_id")
                .values_list("assignee_id", flat=True)
            ],
        }
        intake_current_instance = json.dumps(IntakeIssueSerializer(intake_issue).data, cls=DjangoJSONEncoder)
        if issue_serializer:
            issue_serializer.save()
        if intake_serializer:
            intake_issue = intake_serializer.save()
            issue = intake_issue.issue
        elif issue_serializer:
            issue = issue_serializer.instance
        issue.refresh_from_db()
        intake_issue.issue = issue
        current_workflow = {
            "state": str(issue.state_id),
            "assignees": [
                str(member_id)
                for member_id in issue.issue_assignee.filter(deleted_at__isnull=True)
                .order_by("assignee_id")
                .values_list("assignee_id", flat=True)
            ],
        }
        workflow_changed = previous_workflow != current_workflow
        activity_data = dict(issue_data) if issue_serializer else {}
        if previous_workflow["state"] != current_workflow["state"]:
            activity_data["state"] = current_workflow["state"]

        if issue_serializer or workflow_changed:
            transaction.on_commit(
                partial(
                    issue_activity.delay,
                    type="issue.activity.updated",
                    requested_data=issue_activity_payload(
                        activity_data, issue, "assignees", previous_state_id=previous_workflow["state"]
                    ),
                    actor_id=str(request.user.id),
                    issue_id=str(issue_id),
                    project_id=str(project_id),
                    current_instance=issue_current_instance,
                    epoch=int(timezone.now().timestamp()),
                    notification=True,
                    origin=base_host(request=request, is_app=True),
                    intake=str(intake_issue.id),
                )
            )

        if intake_serializer:
            # create a activity for status change
            transaction.on_commit(
                partial(
                    issue_activity.delay,
                    type="intake.activity.created",
                    requested_data=json.dumps(request.data, cls=DjangoJSONEncoder),
                    actor_id=str(request.user.id),
                    issue_id=str(issue_id),
                    project_id=str(project_id),
                    current_instance=intake_current_instance,
                    epoch=int(timezone.now().timestamp()),
                    notification=False,
                    origin=base_host(request=request, is_app=True),
                    intake=str(intake_issue.id),
                )
            )
        return Response(IntakeIssueSerializer(intake_issue).data, status=status.HTTP_200_OK)

    @intake_docs(
        operation_id="delete_intake_work_item",
        summary="Delete intake work item",
        description="Permanently remove an intake work item from the triage queue. Also deletes the underlying work item if it hasn't been accepted yet.",  # noqa: E501
        parameters=[
            WORKSPACE_SLUG_PARAMETER,
            PROJECT_ID_PARAMETER,
            ISSUE_ID_PARAMETER,
        ],
        responses={
            204: DELETED_RESPONSE,
        },
    )
    @transaction.atomic
    def delete(self, request, slug, project_id, issue_id):
        """Delete intake work item

        Permanently remove an intake work item from the triage queue.
        Also deletes the underlying work item if it hasn't been accepted yet.
        """
        issue = Issue.objects.select_for_update().get(pk=issue_id, workspace__slug=slug, project_id=project_id)
        require_intake_write_access(request.user, issue)
        intake = Intake.objects.filter(workspace__slug=slug, project_id=project_id).first()

        project = Project.objects.get(workspace__slug=slug, pk=project_id)

        # Intake view
        if intake is None and not project.intake_view:
            return Response(
                {"error": "Intake is not enabled for this project enable it through the project's api"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Get the intake issue
        intake_issue = IntakeIssue.objects.get(
            issue_id=issue_id,
            workspace__slug=slug,
            project_id=project_id,
            intake_id=intake.id,
        )

        # Check the issue status
        if intake_issue.status in [-2, -1, 0, 2]:
            # Delete the issue also
            issue = Issue.objects.filter(workspace__slug=slug, project_id=project_id, pk=issue_id).first()
            if issue.created_by_id != request.user.id and (
                not ProjectMember.objects.filter(
                    workspace__slug=slug,
                    member=request.user,
                    role=20,
                    project_id=project_id,
                    is_active=True,
                ).exists()
            ):
                return Response(
                    {"error": "Only admin or creator can delete the work item"},
                    status=status.HTTP_403_FORBIDDEN,
                )
            if Issue.objects.using("default").filter(parent_id=issue.pk).exists():
                issue = lock_issue_delete_scope(request.user, slug, issue.pk, project_id)
            issue.delete()

        intake_issue.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
