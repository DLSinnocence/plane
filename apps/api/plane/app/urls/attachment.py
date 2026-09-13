# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path

from plane.app.views.attachment import (
    AttachmentTemplateEndpoint,
    IssueAttachmentSlotEndpoint,
    ApplyAttachmentTemplateEndpoint,
)

urlpatterns = [
    path(
        "workspaces/<str:slug>/attachment-templates/",
        AttachmentTemplateEndpoint.as_view(),
        name="attachment-templates",
    ),
    path(
        "workspaces/<str:slug>/attachment-templates/<uuid:template_id>/",
        AttachmentTemplateEndpoint.as_view(),
        name="attachment-template-detail",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/issues/<uuid:issue_id>/attachment-slots/",
        IssueAttachmentSlotEndpoint.as_view(),
        name="issue-attachment-slots",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/issues/<uuid:issue_id>/attachment-slots/apply-template/",
        ApplyAttachmentTemplateEndpoint.as_view(),
        name="issue-attachment-slots-apply-template",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/issues/<uuid:issue_id>/attachment-slots/<uuid:slot_id>/",
        IssueAttachmentSlotEndpoint.as_view(),
        name="issue-attachment-slot-detail",
    ),
]
