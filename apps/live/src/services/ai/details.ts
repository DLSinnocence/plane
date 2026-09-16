import type { AiToolDetails } from "./types";

export const TOOL_FAILURE_OUTPUT =
  "Plane could not complete this operation. Check permissions and inputs; verify changes before retrying.";
const MAX_TEXT = 6000;
const fields = [
  "action",
  "id",
  "project_id",
  "workitem_id",
  "parent",
  "parent_id",
  "created_by",
  "state_id",
  "label_id",
  "comment_id",
  "link_id",
  "cycle_id",
  "module_id",
  "workitem_identifier",
  "identifier",
  "name",
  "description",
  "description_stripped",
  "priority",
  "sequence_id",
  "start_date",
  "target_date",
  "completed_at",
  "created_at",
  "updated_at",
  "color",
  "group",
  "sort_order",
  "query",
  "search",
  "cursor",
  "next_cursor",
  "prev_cursor",
  "per_page",
  "count",
  "total_count",
  "next_page_results",
  "prev_page_results",
  "display_name",
  "first_name",
  "last_name",
  "is_active",
  "add_ids",
  "remove_ids",
  "add_user_id",
  "remove_user_id",
  "add_label_id",
  "remove_label_id",
  "success",
] as const;
const containers = ["results", "data", "items", "workitems", "project", "state", "labels", "assignees"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Read only own data properties: getters, prototypes and unknown metadata are never traversed.
function own(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

export function projectToolDetails(
  args: unknown,
  payload: unknown,
  workitemResult: boolean,
  redact: (text: string) => string
): AiToolDetails {
  let truncated = false;
  let nodes = 0;
  const seen = new WeakSet<object>();
  const text = (value: string, limit = 2000) => {
    // Redact before slicing so a credential straddling the boundary cannot escape.
    // eslint-disable-next-line no-control-regex -- remove nonprinting controls from browser text
    const safe = redact(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    if (safe.length > limit) truncated = true;
    return safe.slice(0, limit);
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 500 || depth > 5) {
      truncated = true;
      return undefined;
    }
    if (typeof value === "string") return text(value);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (!value || typeof value !== "object") return undefined;
    if (seen.has(value)) {
      truncated = true;
      return undefined;
    }
    seen.add(value);
    if (own(value, "error") || own(value, "success") === false || own(value, "isError") === true)
      return TOOL_FAILURE_OUTPUT;
    if (Array.isArray(value)) {
      if (value.length > 20) truncated = true;
      const result: unknown[] = [];
      for (let i = 0; i < Math.min(value.length, 20); i++) {
        const child = own(value, String(i));
        if (!child || typeof child !== "object") continue;
        const safe = visit(child, depth + 1);
        if (safe !== undefined) result.push(safe);
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const key of fields) {
      const child = own(value, key);
      // Scalar fields cannot smuggle arbitrary objects or nested error bodies.
      if (child !== undefined && (child === null || ["string", "number", "boolean"].includes(typeof child))) {
        const safe = visit(child, depth + 1);
        if (safe !== undefined) result[key] = safe;
      }
    }
    for (const key of containers) {
      const child = own(value, key);
      if (
        child &&
        (typeof child === "object" ||
          (["project", "state"].includes(key) && typeof child === "string" && uuid.test(child)))
      ) {
        const safe = visit(child, depth + 1);
        if (safe !== undefined) result[key] = safe;
      }
    }
    const assignments = own(value, "state_assignees");
    if (assignments && typeof assignments === "object" && !Array.isArray(assignments)) {
      const safeAssignments: Record<string, string[]> = {};
      const keys = Object.keys(assignments);
      if (keys.length > 100) truncated = true;
      for (const key of keys.slice(0, 100)) {
        const users = own(assignments, key);
        if (!uuid.test(key) || redact(key) !== key || !Array.isArray(users)) continue;
        if (users.length > 16) truncated = true;
        const safeUsers: string[] = [];
        for (let i = 0; i < Math.min(users.length, 16); i++) {
          const user = own(users, String(i));
          if (typeof user === "string" && uuid.test(user) && redact(user) === user) safeUsers.push(user);
        }
        safeAssignments[key] = safeUsers;
      }
      result.state_assignees = safeAssignments;
    }
    return result;
  };
  const serialize = (value: unknown) => {
    const safe = visit(value, 0);
    const json = JSON.stringify(safe ?? {}, null, 2);
    if (json.length > MAX_TEXT) truncated = true;
    return json.length > MAX_TEXT ? `${json.slice(0, MAX_TEXT - 14)}\n[truncated]` : json;
  };
  const details: AiToolDetails = { input: serialize(args) };
  if (payload !== undefined) details.output = serialize(payload);
  const refs: NonNullable<AiToolDetails["workItems"]> = [];
  const refSeen = new WeakSet<object>();
  let refNodes = 0;
  const collect = (value: unknown, depth = 0) => {
    if (!value || typeof value !== "object") return;
    if (++refNodes > 200 || depth > 5 || refSeen.has(value)) {
      truncated = true;
      return;
    }
    refSeen.add(value);
    if (own(value, "error") || own(value, "success") === false || own(value, "isError") === true) return;
    if (Array.isArray(value)) {
      if (value.length > 20) truncated = true;
      for (let i = 0; i < Math.min(value.length, 20); i++) collect(own(value, String(i)), depth + 1);
      return;
    }
    const id = own(value, "id");
    const project = own(value, "project");
    const projectId =
      own(value, "project_id") ??
      (typeof project === "string" ? project : project && typeof project === "object" ? own(project, "id") : undefined);
    const name = own(value, "name");
    if (
      typeof id === "string" &&
      uuid.test(id) &&
      typeof projectId === "string" &&
      uuid.test(projectId) &&
      redact(id) === id &&
      redact(projectId) === projectId &&
      typeof name === "string" &&
      name.trim()
    ) {
      if (refs.length === 20) {
        truncated = true;
        return;
      }
      const identifier = own(value, "identifier");
      refs.push({
        id,
        projectId,
        name: text(name, 300),
        ...(typeof identifier === "string" && /^[a-zA-Z0-9_-]+-[0-9]+$/.test(identifier) && identifier.length <= 100
          ? { identifier: text(identifier, 100) }
          : {}),
      });
    }
    // Only resource/result envelopes, never arbitrary nested metadata or project/state records.
    for (const key of ["results", "data", "items", "workitems"]) collect(own(value, key), depth + 1);
  };
  if (workitemResult) collect(payload);
  if (refs.length) details.workItems = refs;
  if (truncated) details.truncated = true;
  return details;
}

export function parseToolPayload(result: { structuredContent?: unknown }, texts: string[]): unknown {
  if (result.structuredContent !== undefined) {
    return result.structuredContent && typeof result.structuredContent === "object"
      ? result.structuredContent
      : undefined;
  }
  // Plain upstream text is not an allowlisted result and must never become browser details.
  if (texts.length !== 1 || texts[0].length > 128_000) return undefined;
  try {
    const payload: unknown = JSON.parse(texts[0]);
    return payload && typeof payload === "object" ? payload : undefined;
  } catch {
    return undefined;
  }
}
