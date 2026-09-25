# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third party imports
from rest_framework import status
from rest_framework.response import Response
from drf_spectacular.utils import OpenApiResponse

# Module imports
from plane.api.serializers import StateSerializer
from plane.app.permissions import ProjectEntityPermission
from plane.db.models import State
from .base import BaseAPIView
from plane.utils.openapi import (
    state_docs,
    STATE_ID_PARAMETER,
    CURSOR_PARAMETER,
    PER_PAGE_PARAMETER,
    FIELDS_PARAMETER,
    EXPAND_PARAMETER,
    create_paginated_response,
    STATE_EXAMPLE,
)


class StateListCreateAPIEndpoint(BaseAPIView):
    """Read-only state list endpoint; the class name preserves existing imports."""

    serializer_class = StateSerializer
    model = State
    permission_classes = [ProjectEntityPermission]
    use_read_replica = True
    http_method_names = ["get", "head", "options"]

    def get_queryset(self):
        return (
            State.objects.filter(workspace__slug=self.kwargs.get("slug"))
            .filter(project_id=self.kwargs.get("project_id"))
            .filter(
                project__project_projectmember__member=self.request.user,
                project__project_projectmember__is_active=True,
            )
            .filter(is_triage=False)
            .filter(project__archived_at__isnull=True)
            .select_related("project")
            .select_related("workspace")
            .distinct()
        )

    @state_docs(
        operation_id="list_states",
        summary="List states",
        description="Retrieve all workflow states for a project.",
        parameters=[
            CURSOR_PARAMETER,
            PER_PAGE_PARAMETER,
            FIELDS_PARAMETER,
            EXPAND_PARAMETER,
        ],
        responses={
            200: create_paginated_response(
                StateSerializer,
                "PaginatedStateResponse",
                "Paginated list of states",
                "Paginated States",
            ),
        },
    )
    def get(self, request, slug, project_id):
        """List states

        Retrieve all workflow states for a project.
        Returns paginated results when listing all states.
        """
        return self.paginate(
            request=request,
            queryset=(self.get_queryset()),
            on_results=lambda states: StateSerializer(states, many=True, fields=self.fields, expand=self.expand).data,
        )


class StateDetailAPIEndpoint(BaseAPIView):
    """Read-only state detail endpoint."""

    serializer_class = StateSerializer
    model = State
    permission_classes = [ProjectEntityPermission]
    use_read_replica = True
    http_method_names = ["get", "head", "options"]

    def get_queryset(self):
        return (
            State.objects.filter(workspace__slug=self.kwargs.get("slug"))
            .filter(project_id=self.kwargs.get("project_id"))
            .filter(
                project__project_projectmember__member=self.request.user,
                project__project_projectmember__is_active=True,
            )
            .filter(is_triage=False)
            .filter(project__archived_at__isnull=True)
            .select_related("project")
            .select_related("workspace")
            .distinct()
        )

    @state_docs(
        operation_id="retrieve_state",
        summary="Retrieve state",
        description="Retrieve details of a specific state.",
        parameters=[
            STATE_ID_PARAMETER,
        ],
        responses={
            200: OpenApiResponse(
                description="State retrieved",
                response=StateSerializer,
                examples=[STATE_EXAMPLE],
            ),
        },
    )
    def get(self, request, slug, project_id, state_id):
        """Retrieve details of a specific state."""
        serializer = StateSerializer(
            self.get_queryset().get(pk=state_id),
            fields=self.fields,
            expand=self.expand,
        )
        return Response(serializer.data, status=status.HTTP_200_OK)
