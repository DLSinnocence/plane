# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import uuid

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils.decorators import method_decorator
from django.views.decorators.debug import sensitive_post_parameters
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from plane.authentication.session import BaseSessionAuthentication
from plane.bgtasks.feishu_task import dispatch_feishu_message, safe_error
from plane.db.models import FeishuIntegration, FeishuMessage, User, Workspace, WorkspaceMember
from plane.utils.feishu import FeishuError, configured_app_url, decrypt_secret, encrypt_secret
from plane.utils.phone import normalize_phone_number


class ConfigInput(serializers.Serializer):
    app_id = serializers.CharField(max_length=255, required=False, allow_blank=True)
    app_secret = serializers.CharField(
        max_length=4096, required=False, allow_blank=True, write_only=True, trim_whitespace=False
    )
    enabled = serializers.BooleanField(required=False)


class TestInput(serializers.Serializer):
    user_id = serializers.UUIDField()


def config_data(integration):
    return {
        "id": str(integration.id) if integration else None,
        "app_id": integration.app_id if integration else "",
        "enabled": integration.enabled if integration else False,
        "has_app_secret": bool(integration and integration.app_secret),
    }


def active_member(workspace, user_id):
    return WorkspaceMember.objects.filter(
        workspace=workspace,
        member_id=user_id,
        is_active=True,
        member__is_active=True,
    ).exists()


class FeishuAdminAPIView(APIView):
    authentication_classes = [BaseSessionAuthentication]
    permission_classes = [IsAuthenticated]

    def workspace(self, request, slug):
        workspace = get_object_or_404(Workspace, slug=slug)
        if (
            not request.user.is_active
            or not WorkspaceMember.objects.filter(
                workspace=workspace,
                member=request.user,
                role=20,
                is_active=True,
            ).exists()
        ):
            raise PermissionDenied("Only active workspace administrators can manage Feishu.")
        return workspace


@method_decorator(sensitive_post_parameters("app_secret"), name="dispatch")
class FeishuIntegrationEndpoint(FeishuAdminAPIView):
    def get(self, request, slug):
        workspace = self.workspace(request, slug)
        return Response(config_data(FeishuIntegration.objects.filter(workspace=workspace).first()))

    def patch(self, request, slug):
        workspace = self.workspace(request, slug)
        data = ConfigInput(data=request.data)
        data.is_valid(raise_exception=True)
        values = data.validated_data
        with transaction.atomic():
            Workspace.objects.select_for_update().get(pk=workspace.pk)
            integration, _ = FeishuIntegration.objects.get_or_create(workspace=workspace)
            previous_app_id = integration.app_id
            integration.app_id = values.get("app_id", integration.app_id)
            integration.enabled = values.get("enabled", integration.enabled)
            if previous_app_id != integration.app_id and not values.get("app_secret", "").strip():
                raise ValidationError({"error": "Provide the new app secret when changing the Feishu app ID."})
            try:
                if values.get("app_secret"):
                    integration.app_secret = encrypt_secret(values["app_secret"])
                if integration.enabled:
                    if not integration.app_id or not integration.app_secret:
                        raise ValidationError({"error": "App ID and app secret are required to enable Feishu."})
                    decrypt_secret(integration.app_secret)
            except FeishuError:
                raise ValidationError({"error": "Feishu credentials could not be securely stored or read."}) from None
            if integration.enabled:
                try:
                    configured_app_url()
                except FeishuError:
                    raise ValidationError(
                        {"error": "Configure a valid HTTP(S) APP_BASE_URL or WEB_URL before enabling Feishu."}
                    ) from None
            integration.save()
        return Response(config_data(integration))


class FeishuRecipientsEndpoint(FeishuAdminAPIView):
    def get(self, request, slug):
        workspace = self.workspace(request, slug)
        members = (
            WorkspaceMember.objects.filter(
                workspace=workspace,
                is_active=True,
                member__is_active=True,
            )
            .select_related("member")
            .order_by("member_id")
        )
        rows = []
        for member in members:
            mobile = normalize_phone_number(member.member.mobile_number)
            rows.append(
                {
                    "user_id": str(member.member_id),
                    "has_mobile": bool(mobile),
                    "mobile_hint": "+" + "*" * (len(mobile) - 5) + mobile[-4:] if mobile else "",
                }
            )
        return Response(rows)


class FeishuDeliveriesEndpoint(FeishuAdminAPIView):
    def get(self, request, slug):
        workspace = self.workspace(request, slug)
        rows = list(
            FeishuMessage.objects.filter(integration__workspace=workspace)
            .order_by("-created_at")
            .values("id", "issue_id", "receiver_id", "status", "attempts", "last_error", "created_at", "sent_at")[:50]
        )
        for row in rows:
            row["last_error"] = safe_error(row["last_error"]) if row["last_error"] else ""
        return Response(rows)


class FeishuTestEndpoint(FeishuAdminAPIView):
    def post(self, request, slug):
        workspace = self.workspace(request, slug)
        data = TestInput(data=request.data)
        data.is_valid(raise_exception=True)
        user_id = data.validated_data["user_id"]
        if not active_member(workspace, user_id):
            raise ValidationError({"error": "User must be an active workspace member."})
        with transaction.atomic():
            integration = get_object_or_404(FeishuIntegration.objects.select_for_update(), workspace=workspace)
            if not integration.enabled or not integration.app_id or not integration.app_secret:
                raise ValidationError({"error": "Enable and configure Feishu before sending a test."})
            receiver = get_object_or_404(User, pk=user_id, is_active=True)
            mobile = normalize_phone_number(receiver.mobile_number)
            if not mobile:
                raise ValidationError({"error": "phone_invalid" if receiver.mobile_number else "phone_missing"})
            try:
                app_url = configured_app_url()
            except FeishuError:
                raise ValidationError(
                    {"error": "Configure a valid HTTP(S) APP_BASE_URL or WEB_URL before sending a test."}
                ) from None
            message = FeishuMessage.objects.create(
                integration=integration,
                receiver_id=user_id,
                event_key=f"test:{uuid.uuid4()}",
                recipient_mobile=mobile,
                recipient_open_id="",
                app_id=integration.app_id,
                card={
                    "header": {"title": {"tag": "plain_text", "content": "Plane 飞书通知测试"}},
                    "elements": [
                        {"tag": "div", "text": {"tag": "plain_text", "content": "飞书应用机器人通知已连接。"}},
                        {
                            "tag": "action",
                            "actions": [
                                {
                                    "tag": "button",
                                    "type": "primary",
                                    "text": {"tag": "plain_text", "content": "打开 Plane"},
                                    "url": app_url,
                                }
                            ],
                        },
                    ],
                },
            )
            transaction.on_commit(lambda: dispatch_feishu_message(message.id))
        return Response({"id": str(message.id), "status": "pending"}, status=202)
