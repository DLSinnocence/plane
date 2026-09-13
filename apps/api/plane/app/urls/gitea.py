# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.urls import path

from plane.app.views.gitea import (
    GiteaIntegrationEndpoint,
    GiteaHookEndpoint,
    GiteaRotateTokenEndpoint,
    GiteaValidateEndpoint,
    GiteaCommitsEndpoint,
    GiteaWorkItemEndpoint,
    GiteaCommitWorkItemsEndpoint,
    GiteaIssueCommitsEndpoint,
)

BASE = "workspaces/<str:slug>/integrations/gitea/"
PUBLIC = "integrations/gitea/<str:slug>/"
urlpatterns = [
    path(BASE, GiteaIntegrationEndpoint.as_view()),
    path(BASE + "hooks/", GiteaHookEndpoint.as_view()),
    path(BASE + "rotate-token/", GiteaRotateTokenEndpoint.as_view()),
    path(PUBLIC + "validate/", GiteaValidateEndpoint.as_view()),
    path(PUBLIC + "commits/", GiteaCommitsEndpoint.as_view()),
    path(PUBLIC + "work-items/<str:identifier>/", GiteaWorkItemEndpoint.as_view()),
    path(PUBLIC + "commits/<str:sha>/work-items/", GiteaCommitWorkItemsEndpoint.as_view()),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/issues/<uuid:issue_id>/git-commits/",
        GiteaIssueCommitsEndpoint.as_view(),
    ),
]
