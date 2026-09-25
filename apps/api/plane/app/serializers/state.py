# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Module imports
from .base import BaseSerializer
from rest_framework import serializers

from plane.db.models import State, StateGroup


class StateSerializer(BaseSerializer):
    order = serializers.FloatField(required=False)

    class Meta:
        model = State
        fields = [
            "id",
            "project_id",
            "workspace_id",
            "name",
            "color",
            "group",
            "is_testing",
            "default",
            "description",
            "sequence",
            "order",
        ]
        read_only_fields = ["workspace", "project", "is_testing"]

    def validate(self, attrs):
        if getattr(self.instance, "is_testing", False):
            if attrs.get("group", self.instance.group) != StateGroup.STARTED.value:
                raise serializers.ValidationError({"group": "The testing state must remain in the started group."})
            if attrs.get("default", self.instance.default):
                raise serializers.ValidationError({"default": "The optional testing state cannot be the default."})
        if attrs.get("group") == StateGroup.TRIAGE.value:
            raise serializers.ValidationError("Cannot create triage state")
        return attrs


class StateLiteSerializer(BaseSerializer):
    class Meta:
        model = State
        fields = ["id", "name", "color", "group", "is_testing"]
        read_only_fields = fields
