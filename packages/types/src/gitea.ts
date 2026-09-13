/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export type GiteaConfig = {
  enabled: boolean;
  has_secret: boolean;
  validation_url: string;
  commits_url: string;
  lookup_url: string;
  issue_url_template: string;
};

export type GiteaHook = { filename: "pre-receive" | "post-receive"; content: string };
export type GiteaHooks = {
  pre_receive: GiteaHook & { filename: "pre-receive" };
  post_receive: GiteaHook & { filename: "post-receive" };
};

export type IssueGitCommit = {
  id: string;
  sha: string;
  short_sha: string;
  title: string;
  author_name: string;
  committed_at: string | null;
  url: string;
  repository_name: string;
  branch: string;
};

export type IssueGitCommitsResponse = {
  results: IssueGitCommit[];
  count: number;
  next_page: number | null;
};
