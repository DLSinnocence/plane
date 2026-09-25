# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
from itertools import groupby
from collections import defaultdict

# Third party imports
from rest_framework.response import Response
from rest_framework import status

# Module imports
from .. import BaseViewSet, BaseAPIView
from plane.app.serializers import StateSerializer
from plane.app.permissions import ROLE, allow_permission
from plane.db.models import State


class StateViewSet(BaseViewSet):
    serializer_class = StateSerializer
    model = State
    http_method_names = ["get", "head", "options"]

    # Keep the legacy route resolvable without allowing project workflow changes.
    mark_as_default = BaseViewSet.http_method_not_allowed

    def get_queryset(self):
        return self.filter_queryset(
            super()
            .get_queryset()
            .filter(workspace__slug=self.kwargs.get("slug"))
            .filter(project_id=self.kwargs.get("project_id"))
            .filter(
                project__project_projectmember__member=self.request.user,
                project__project_projectmember__is_active=True,
                project__archived_at__isnull=True,
            )
            .filter(is_triage=False)
            .select_related("project")
            .select_related("workspace")
            .distinct()
        )

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST])
    def list(self, request, slug, project_id):
        states = StateSerializer(self.get_queryset(), many=True).data

        grouped_states = defaultdict(list)
        for state in states:
            grouped_states[state["group"]].append(state)

        for group, group_states in grouped_states.items():
            count = len(group_states)

            for index, state in enumerate(group_states, start=1):
                state["order"] = index / count

        grouped = request.GET.get("grouped", False)

        if grouped == "true":
            state_dict = {}
            for key, value in groupby(
                sorted(states, key=lambda state: state["group"]),
                lambda state: state.get("group"),
            ):
                state_dict[str(key)] = list(value)
            return Response(state_dict, status=status.HTTP_200_OK)

        return Response(states, status=status.HTTP_200_OK)


class IntakeStateEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST])
    def get(self, request, slug, project_id):
        state = State.triage_objects.filter(workspace__slug=slug, project_id=project_id).first()
        if not state:
            return Response(
                {"error": "Triage state not found"},
                status=status.HTTP_404_NOT_FOUND,
            )

        return Response(StateSerializer(state).data, status=status.HTTP_200_OK)
