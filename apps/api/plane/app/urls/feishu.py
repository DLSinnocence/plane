# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.urls import path

from plane.app.views.feishu import (
    FeishuDeliveriesEndpoint,
    FeishuIntegrationEndpoint,
    FeishuRecipientsEndpoint,
    FeishuTestEndpoint,
)

urlpatterns = [
    path("workspaces/<str:slug>/integrations/feishu/", FeishuIntegrationEndpoint.as_view(), name="feishu-integration"),
    path(
        "workspaces/<str:slug>/integrations/feishu/deliveries/",
        FeishuDeliveriesEndpoint.as_view(),
        name="feishu-deliveries",
    ),
    path(
        "workspaces/<str:slug>/integrations/feishu/recipients/",
        FeishuRecipientsEndpoint.as_view(),
        name="feishu-recipients",
    ),
    path("workspaces/<str:slug>/integrations/feishu/test/", FeishuTestEndpoint.as_view(), name="feishu-test"),
]
