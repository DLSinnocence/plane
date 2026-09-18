# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path


from plane.app.views import UnsplashEndpoint
from plane.app.views import GPTIntegrationEndpoint, WorkspaceGPTIntegrationEndpoint


from plane.app.views.ai import (
    WorkspaceAgentChatEndpoint,
    WorkspaceAIModelsDiscoveryEndpoint,
    WorkspaceAIProviderEndpoint,
    WorkspaceAIProviderModelEndpoint,
    WorkspaceAIProviderModelsEndpoint,
    WorkspaceAIProvidersEndpoint,
    WorkspaceAISettingsEndpoint,
)

urlpatterns = [
    path("workspaces/<str:slug>/agent/chat/", WorkspaceAgentChatEndpoint.as_view(), name="workspace-agent-chat"),
    path(
        "workspaces/<str:slug>/ai-settings/",
        WorkspaceAISettingsEndpoint.as_view(),
        name="workspace-ai-settings",
    ),
    path(
        "workspaces/<str:slug>/ai-settings/models/",
        WorkspaceAIModelsDiscoveryEndpoint.as_view(),
        name="workspace-ai-model-discovery",
    ),
    path(
        "workspaces/<str:slug>/ai-settings/providers/",
        WorkspaceAIProvidersEndpoint.as_view(),
        name="workspace-ai-providers",
    ),
    path(
        "workspaces/<str:slug>/ai-settings/providers/<uuid:provider_id>/",
        WorkspaceAIProviderEndpoint.as_view(),
        name="workspace-ai-provider",
    ),
    path(
        "workspaces/<str:slug>/ai-settings/providers/<uuid:provider_id>/models/",
        WorkspaceAIProviderModelsEndpoint.as_view(),
        name="workspace-ai-provider-models",
    ),
    path(
        "workspaces/<str:slug>/ai-settings/providers/<uuid:provider_id>/models/<uuid:model_id>/",
        WorkspaceAIProviderModelEndpoint.as_view(),
        name="workspace-ai-provider-model",
    ),
    path("unsplash/", UnsplashEndpoint.as_view(), name="unsplash"),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/ai-assistant/",
        GPTIntegrationEndpoint.as_view(),
        name="importer",
    ),
    path(
        "workspaces/<str:slug>/ai-assistant/",
        WorkspaceGPTIntegrationEndpoint.as_view(),
        name="importer",
    ),
]
