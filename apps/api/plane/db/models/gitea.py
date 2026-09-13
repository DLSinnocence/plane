# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.db import models

from .base import BaseModel


class GiteaIntegration(BaseModel):
    workspace = models.OneToOneField("db.Workspace", on_delete=models.CASCADE, related_name="gitea_integration")
    secret = models.TextField(blank=True, default="")
    enabled = models.BooleanField(default=False)

    class Meta:
        db_table = "gitea_integrations"


class GiteaCommit(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="gitea_commits")
    sha = models.CharField(max_length=64)
    url = models.URLField(max_length=2048)
    message = models.TextField()
    title = models.TextField()
    author_name = models.CharField(max_length=255, blank=True, default="")
    committed_at = models.DateTimeField(null=True, blank=True)
    repository_name = models.CharField(max_length=255, blank=True, default="")
    branch = models.CharField(max_length=1024, blank=True, default="")

    class Meta:
        db_table = "gitea_commits"
        constraints = [models.UniqueConstraint(fields=["workspace", "url"], name="gitea_commit_unique")]


class GiteaCommitLink(BaseModel):
    commit = models.ForeignKey(GiteaCommit, on_delete=models.CASCADE, related_name="links")
    issue = models.ForeignKey("db.Issue", on_delete=models.CASCADE, related_name="gitea_commit_links")

    class Meta:
        db_table = "gitea_commit_links"
        constraints = [models.UniqueConstraint(fields=["commit", "issue"], name="gitea_commit_issue_unique")]
