/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import type { AgentToolEvent, AgentWorkItem } from "./agent-stream";

export function agentWorkItemHref(workspaceSlug: string, item: AgentWorkItem): string {
  return `/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(item.projectId)}/issues/${encodeURIComponent(item.id)}/`;
}

export function collectAgentWorkItems(tools: AgentToolEvent[]): AgentWorkItem[] {
  const items = new Map<string, AgentWorkItem>();
  for (const tool of tools) {
    if (tool.status !== "complete") continue;
    for (const item of tool.details?.workItems ?? []) {
      const key = `${item.projectId}:${item.id}`;
      items.set(key, { ...items.get(key), ...item });
    }
  }
  return [...items.values()].slice(-100);
}

export type AgentToolProgress = AgentToolEvent & { key: string };
export function updateAgentTools(previous: AgentToolProgress[], event: AgentToolEvent): AgentToolProgress[] {
  const key = event.id || `${event.name}:${event.action ?? ""}`;
  const index = previous.findIndex((tool) => tool.key === key);
  const existing = previous[index];
  const next = {
    ...existing,
    ...event,
    key,
    ...(existing?.details || event.details ? { details: { ...existing?.details, ...event.details } } : {}),
  };
  return index < 0 ? [...previous, next] : previous.map((tool, position) => (position === index ? next : tool));
}
export function agentToolLabelKeys(tool: AgentToolEvent): { action: string; entity: string } {
  const entities = [
    "project",
    "member",
    "workitem",
    "state",
    "label",
    "workitem_comment",
    "workitem_link",
    "cycle",
    "module",
  ];
  const actions: Record<string, string> = {
    list: "read",
    retrieve: "read",
    retrieve_by_identifier: "read",
    search: "search",
    create: "create",
    update: "update",
    me: "read",
    list_workspace: "read",
    list_project: "read",
    list_workitems: "read",
    manage_assignee: "update",
    manage_label: "update",
    manage_workitems: "update",
  };
  return {
    action: `account_settings.ai.action_${actions[tool.action ?? ""] ?? "run"}`,
    entity: `account_settings.ai.entity_${entities.includes(tool.name) ? tool.name : "workspace"}`,
  };
}
export function canSendAgentMessage(draft: string, busy: boolean, configured: boolean | null, imageCount = 0): boolean {
  return Boolean((draft.trim() || imageCount > 0) && !busy && configured);
}
