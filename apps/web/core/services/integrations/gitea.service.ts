/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import type { GiteaConfig, GiteaHooks, IssueGitCommitsResponse } from "@plane/types";
import { APIService } from "@/services/api.service";

export class GiteaService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  private path(workspaceSlug: string) {
    return `/api/workspaces/${encodeURIComponent(workspaceSlug)}/integrations/gitea/`;
  }

  async getConfig(workspaceSlug: string): Promise<GiteaConfig> {
    return this.get(this.path(workspaceSlug)).then((response) => response.data);
  }

  async updateConfig(workspaceSlug: string, data: { enabled: boolean }): Promise<GiteaConfig> {
    return this.patch(this.path(workspaceSlug), data).then((response) => response.data);
  }

  async generateHooks(workspaceSlug: string, repositoryUrl: string): Promise<GiteaHooks> {
    return this.post(`${this.path(workspaceSlug)}hooks/`, { repository_url: repositoryUrl }).then(
      (response) => response.data
    );
  }

  async rotateToken(workspaceSlug: string): Promise<GiteaConfig> {
    return this.post(`${this.path(workspaceSlug)}rotate-token/`, {}).then((response) => response.data);
  }

  async listIssueCommits(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    page = 1
  ): Promise<IssueGitCommitsResponse> {
    return this.get(
      `/api/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/git-commits/`,
      { params: { page } }
    ).then((response) => response.data);
  }
}
