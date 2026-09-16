/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo } from "react";
import { orderBy } from "lodash-es";
import { observable, runInAction } from "mobx";
import type { E_SORT_ORDER } from "@plane/constants";
import { EActivityFilterType } from "@plane/constants";
import { EInboxIssueSource, EIssueCommentAccessSpecifier } from "@plane/types";
import type { TCommentsOperations, TIssueActivity, TIssueActivityComment, TIssueComment } from "@plane/types";

const params = new URLSearchParams(window.location.search);
const actor = {
  id: "author",
  first_name: "Alice",
  last_name: "",
  display_name: "Alice",
  avatar_url: "",
  is_bot: false,
};
const common = (issue: string) => ({
  workspace: "workspace",
  workspace_detail: { id: "workspace", slug: "workspace", name: "Workspace" },
  project: "project",
  project_detail: {
    id: "project",
    identifier: "TEST",
    name: "Project",
    cover_image: "",
    description: null,
    emoji: null,
    icon_prop: null,
  },
  issue,
  issue_detail: {
    id: issue,
    name: `Work item ${issue}`,
    sequence_id: issue === "A" ? 1 : 2,
    sort_order: false,
    description_html: "",
    priority: "none" as const,
    start_date: "",
    target_date: "",
    is_draft: false,
  },
  actor: actor.id,
  actor_detail: actor,
  created_by: actor.id,
  updated_by: actor.id,
  attachments: [],
});
const date = (sequence: number) => `2026-01-01T00:${String(sequence).padStart(2, "0")}:00Z`;
const comment = (issue: string, sequence: number, text = `${issue} comment ${sequence}`): TIssueComment => ({
  ...common(issue),
  id: `${issue}-comment-${sequence}`,
  created_at: date(sequence),
  updated_at: date(sequence),
  comment_html: `<p>${text}</p>`,
  comment_stripped: text,
  comment_json: {},
  comment_reactions: [],
  external_id: undefined,
  external_source: undefined,
  access: EIssueCommentAccessSpecifier.INTERNAL,
});
// The API supplies null for work-item creation, although the existing activity
// type currently only declares string | undefined for field.
type FixtureActivity = Omit<TIssueActivity, "field"> & { field: string | null };
const activity = (issue: string, sequence: number, field: string | null, value?: string): FixtureActivity => ({
  ...common(issue),
  id: `${issue}-activity-${sequence}`,
  created_at: date(sequence),
  updated_at: date(sequence),
  field,
  verb: field === null ? "created" : "updated",
  new_value: value,
  old_value: undefined,
  comment: undefined,
  old_identifier: undefined,
  new_identifier: undefined,
  epoch: sequence,
  issue_comment: null,
  source_data: { source: EInboxIssueSource.IN_APP, extra: {} },
});
const activitiesFor = (issue: string) => [
  activity(issue, 0, null),
  activity(issue, 1, "name", `${issue} renamed title`),
  activity(issue, 2, "state", `${issue} developing`),
  activity(issue, 3, "assignees", `${issue} owner`),
  activity(issue, 4, "priority", "high"),
];
const allActivities = [...activitiesFor("A"), ...activitiesFor("B")];

export const fixtureState = observable({
  commentsReady: !params.has("comments-loading"),
  activitiesReady: !params.has("activities-loading"),
  comments: params.has("empty")
    ? ([] as TIssueComment[])
    : [comment("A", 1), comment("A", 2), comment("B", 1), comment("B", 2)],
  activities: params.has("empty") ? ([] as FixtureActivity[]) : allActivities,
  submitted: [] as { issueId: string; html: string }[],
});

const sorted = <T extends { created_at?: string }>(items: T[], order: E_SORT_ORDER) =>
  orderBy(items, (entry) => entry.created_at ?? "", order);
const descriptor = (entry: FixtureActivity): TIssueActivityComment => ({
  id: entry.id,
  created_at: entry.created_at,
  activity_type:
    entry.field === null
      ? EActivityFilterType.DEFAULT
      : entry.field === "state"
        ? EActivityFilterType.STATE
        : entry.field === "assignees"
          ? EActivityFilterType.ASSIGNEE
          : EActivityFilterType.ACTIVITY,
});
const detail = {
  comment: {
    getSortedCommentsByIssueId: (issueId: string, order: E_SORT_ORDER) =>
      fixtureState.commentsReady
        ? sorted(
            fixtureState.comments.filter((entry) => entry.issue === issueId),
            order
          )
        : undefined,
    getCommentById: (id: string) => fixtureState.comments.find((entry) => entry.id === id),
  },
  activity: {
    getActivityItemsByIssueId: (issueId: string, order: E_SORT_ORDER) =>
      fixtureState.activitiesReady
        ? sorted(fixtureState.activities.filter((entry) => entry.issue === issueId).map(descriptor), order)
        : undefined,
    getActivityById: (id: string) => fixtureState.activities.find((entry) => entry.id === id),
  },
};

export const useIssueDetail = () => detail;
export const useProject = () => ({ getProjectById: (id: string) => ({ id, anchor: "published", identifier: "TEST" }) });
export const useWorkspace = () => ({ getWorkspaceBySlug: () => ({ id: "workspace" }) });
export const useMember = () => ({ getUserDetails: () => actor });
export const useUser = () => ({ data: params.has("non-author") ? { ...actor, id: "other" } : actor });
export const useLabel = () => ({ getLabelById: () => undefined });
export const usePlatformOS = () => ({ isMobile: false });
export const useTimeLineRelationOptions = () => ({});
export const useTranslation = () => ({ t: (key: string) => key, currentLocale: "en" });

export const useWorkItemCommentOperations = (
  _workspace: string,
  _project: string,
  issueId: string
): TCommentsOperations =>
  useMemo(
    () => ({
      copyCommentLink: (id) => {
        window.location.hash = `comment-${id}`;
      },
      createComment: async (data) => {
        const entry = comment(issueId, 10 + fixtureState.submitted.length, data.comment_html ?? "");
        entry.comment_html = data.comment_html ?? "";
        runInAction(() => {
          fixtureState.submitted.push({ issueId, html: entry.comment_html });
          fixtureState.comments.push(entry);
        });
        return entry;
      },
      updateComment: async (id, data) => {
        runInAction(() => {
          const entry = detail.comment.getCommentById(id);
          if (entry) Object.assign(entry, data);
        });
      },
      removeComment: async (id) => {
        runInAction(() => {
          fixtureState.comments = fixtureState.comments.filter((entry) => entry.id !== id);
        });
      },
      uploadCommentAsset: async () => {
        throw new Error("File uploads are outside this activity fixture");
      },
      duplicateCommentAsset: async () => {
        throw new Error("File uploads are outside this activity fixture");
      },
      addCommentReaction: async () => {},
      deleteCommentReaction: async () => {},
      react: async () => {},
      reactionIds: () => ({}),
      userReactions: () => [],
      getReactionUsers: () => "",
    }),
    [issueId]
  );

export class FileService {
  async updateBulkProjectAssetsUploadStatus() {
    throw new Error("File uploads are outside this activity fixture");
  }
  async updateBulkWorkspaceAssetsUploadStatus() {
    throw new Error("File uploads are outside this activity fixture");
  }
}
