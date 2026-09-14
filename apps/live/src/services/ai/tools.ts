import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import { AI_LIMITS } from "./types";
import type { AiToolDetails } from "./types";
import { parseToolPayload, projectToolDetails, TOOL_FAILURE_OUTPUT } from "./details";

// Plane MCP 0.3.2 action names, checked against this CE checkout's /api/v1
// URL table. Do not expose its legacy aliases, PQL, dependencies/custom relations,
// workspace state APIs, feature toggles, pages, or other commercial resources.
export const CE_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  project: ["list", "retrieve", "create", "update"],
  member: ["me", "list_workspace", "list_project"],
  workitem: [
    "list",
    "retrieve",
    "retrieve_by_identifier",
    "search",
    "create",
    "update",
    "manage_assignee",
    "manage_label",
  ],
  state: ["list", "retrieve", "create", "update"],
  label: ["list", "retrieve", "create", "update"],
  workitem_comment: ["list", "retrieve", "create", "update"],
  workitem_link: ["list", "retrieve", "create", "update"],
  cycle: ["list", "retrieve", "create", "update", "list_workitems", "manage_workitems"],
  module: ["list", "retrieve", "create", "update", "list_workitems", "manage_workitems"],
};

const unsupportedParameters = new Set([
  "pql",
  "filters",
  "type_id",
  "point",
  "is_draft",
  "is_time_tracking_enabled",
  "workitem_types",
  "epics",
  "parallel_cycles",
  "project_updates",
  "workflows",
  "modules",
  "cycles",
  "views",
  "pages",
  "intakes",
  "archived",
  "archive",
  "group_by",
  "sub_group_by",
  "role_slug",
  "namespace",
  "role_id",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idParameters = /^(project_id|workitem_id|state_id|label_id|comment_id|link_id|cycle_id|module_id)$/;

export function sanitizeToolText(text: string, secrets: readonly string[]): string {
  let safe = text;
  for (const secret of secrets) {
    if (secret) safe = safe.replaceAll(secret, "[redacted]");
  }
  return safe.replace(/plane_api_[a-zA-Z0-9_-]+/g, "[redacted]");
}

// Retain only suffixes that could be the beginning of a secret, so normal
// text streams immediately while split credential echoes cannot escape.
export function createTextRedactor(secrets: readonly string[]) {
  let pending = "";
  return {
    push(chunk: string): string {
      let text = pending + chunk;
      for (const secret of secrets) {
        if (secret) text = text.replaceAll(secret, "[redacted]");
      }
      let keep = 0;
      for (const secret of secrets) {
        for (let length = Math.min(secret.length - 1, text.length); length > keep; length--) {
          if (text.endsWith(secret.slice(0, length))) {
            keep = length;
            break;
          }
        }
      }
      pending = keep ? text.slice(-keep) : "";
      return sanitizeToolText(keep ? text.slice(0, -keep) : text, secrets);
    },
    finish(): string {
      const tail = sanitizeToolText(pending, secrets);
      pending = "";
      return tail;
    },
  };
}

export function prepareCeArguments(name: string, raw: Record<string, unknown>, projectId: string | null) {
  const args = { ...raw };
  if (typeof args.action !== "string" || !CE_ACTIONS[name]?.includes(args.action)) {
    throw new Error("This Plane action is unavailable.");
  }
  for (const key of unsupportedParameters) {
    if (key in args) throw new Error("This parameter is unavailable in Plane Community Edition.");
  }
  const workspaceAction =
    (name === "project" && ["list", "create"].includes(args.action)) ||
    (name === "member" && ["me", "list_workspace"].includes(args.action)) ||
    (name === "workitem" && ["search", "retrieve_by_identifier"].includes(args.action));
  if (!workspaceAction && !args.project_id && projectId) args.project_id = projectId;
  if (!workspaceAction && !args.project_id) throw new Error("Select or supply a project first.");
  if (
    args.workitem_identifier !== undefined &&
    (typeof args.workitem_identifier !== "string" || !/^[a-zA-Z0-9_-]+-[0-9]+$/.test(args.workitem_identifier))
  ) {
    throw new Error("Use a work item identifier such as PROJECT-123.");
  }
  for (const [key, value] of Object.entries(args)) {
    if (idParameters.test(key) && (typeof value !== "string" || !uuid.test(value))) {
      throw new Error("Plane resource IDs must be UUIDs.");
    }
    if (Array.isArray(value) && value.length > 16) throw new Error("Use at most 16 values per operation.");
    if (typeof value === "string" && value.length > 16_000) throw new Error("Tool input is too large.");
    if (
      ["add_ids", "remove_ids", "add_user_id", "remove_user_id", "add_label_id", "remove_label_id"].includes(key) &&
      typeof value === "string" &&
      value.split(",").length > 16
    ) {
      throw new Error("Use at most 16 values per operation.");
    }
  }
  if (
    args.per_page !== undefined &&
    (typeof args.per_page !== "number" || !Number.isInteger(args.per_page) || args.per_page < 1 || args.per_page > 100)
  )
    throw new Error("Page size must be between 1 and 100.");
  return args;
}

function ceDescription(tool: Tool, actions: readonly string[]): string {
  // Keep only action documentation that the backend can actually execute. The
  // server's global instructions describe unsupported cloud features and PQL.
  const lines = (tool.description ?? "").split("\n");
  const allowedLines = lines.flatMap((line) => {
    // Pinned 0.3.2 toolkit/spec.py renders: action (required; optional fields) -- note.
    const match = line.match(/^\s*([a-z_]+) \((.*?)\)/);
    if (!match || !actions.includes(match[1])) return [];
    const [required, optional] = match[2].split("; optional ");
    const supported = optional?.split(", ").filter((key) => !unsupportedParameters.has(key));
    return [`${match[1]} (${required}${supported?.length ? `; optional ${supported.join(", ")}` : ""})`];
  });
  return (
    `${tool.name} in the current Plane workspace. Allowed actions: ${actions.join(", ")}. ` +
    "Use project_id for project resources. List IDs before writing. No PQL or workspace-wide workitem list. " +
    "Paginated results may be incomplete; follow next_cursor before claiming totals. " +
    allowedLines.join("\n")
  );
}

export function createCeTools(
  listed: Tool[],
  client: Pick<Client, "callTool">,
  projectId: string | null,
  secrets: readonly string[],
  takeCall: () => void,
  recordDetails?: (id: string, name: string, details: AiToolDetails) => void
): AgentTool[] {
  // A 0.2 per-operation catalogue is incompatible with this adapter.
  if (!listed.some((tool) => tool.name === "workitem") || !listed.some((tool) => tool.name === "project")) {
    throw new Error("The configured Plane MCP version is unsupported.");
  }
  return listed.flatMap((tool): AgentTool[] => {
    const actions = CE_ACTIONS[tool.name];
    if (!actions) return [];
    const properties: Record<string, unknown> = Object.fromEntries(
      Object.entries(tool.inputSchema.properties ?? {}).filter(([key]) => !unsupportedParameters.has(key))
    );
    const originalAction = properties.action;
    if (
      !originalAction ||
      typeof originalAction !== "object" ||
      !("enum" in originalAction) ||
      !Array.isArray(originalAction.enum)
    )
      return [];
    const advertisedActions = originalAction.enum;
    if (actions.some((action) => !advertisedActions.includes(action))) return [];
    properties.action = { type: "string", enum: [...actions] };
    const parameters = Type.Unsafe<Record<string, unknown>>({
      ...tool.inputSchema,
      type: "object",
      properties,
      required: (tool.inputSchema.required ?? []).filter((key) => !unsupportedParameters.has(key)),
      additionalProperties: false,
    });
    return [
      {
        name: tool.name,
        label: tool.name.replaceAll("_", " "),
        description: ceDescription(tool, actions),
        parameters,
        executionMode: "sequential",
        execute: async (id, raw, signal) => {
          if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw new Error("Tool arguments must be an object.");
          const args = prepareCeArguments(tool.name, raw as Record<string, unknown>, projectId);
          takeCall();
          signal?.throwIfAborted();
          try {
            const result = await client.callTool({ name: tool.name, arguments: args }, undefined, {
              signal,
              timeout: AI_LIMITS.toolMs,
              maxTotalTimeout: AI_LIMITS.toolMs,
              resetTimeoutOnProgress: false,
            });
            // Never feed upstream exception payloads (URLs, headers, tokens) to the
            // model; it could repeat them in its answer. Do not retry mutations.
            if (result.isError) throw new Error("tool_failed");
            const blocks = Array.isArray(result.content) ? result.content : [];
            const texts = blocks.flatMap((block: unknown) => {
              if (
                block &&
                typeof block === "object" &&
                "type" in block &&
                block.type === "text" &&
                "text" in block &&
                typeof block.text === "string"
              )
                return [block.text];
              return [];
            });
            const payload = parseToolPayload({ structuredContent: result.structuredContent }, texts);
            if (
              payload &&
              typeof payload === "object" &&
              (Object.getOwnPropertyDescriptor(payload, "error")?.value ||
                Object.getOwnPropertyDescriptor(payload, "success")?.value === false)
            )
              throw new Error("tool_failed");
            const details = projectToolDetails(
              args,
              payload,
              tool.name === "workitem" || (["cycle", "module"].includes(tool.name) && args.action === "list_workitems"),
              (value) => sanitizeToolText(value, secrets)
            );
            if (payload === undefined) {
              details.output = "Plane completed this operation.";
              if (texts.length > 1 || texts.some((value) => value.length > 128_000)) details.truncated = true;
            }
            let text: string;
            try {
              text = texts.length ? texts.join("\n") : JSON.stringify(result.structuredContent ?? null);
            } catch {
              text = details.output ?? "Plane completed this operation.";
            }
            // FastMCP can encode input failures as successful text results.
            if (/^\s*(?:Error:|Traceback\b)/i.test(text)) throw new Error("tool_failed");
            const safe = sanitizeToolText(text, secrets);
            recordDetails?.(id, tool.name, structuredClone(details));
            return {
              content: [
                {
                  type: "text",
                  text:
                    safe.length > AI_LIMITS.toolResultChars
                      ? `${safe.slice(0, AI_LIMITS.toolResultChars)}\n[Result truncated. Request a smaller page or sparse fields.]`
                      : safe,
                },
              ],
              details,
            };
          } catch {
            throw new Error(TOOL_FAILURE_OUTPUT);
          }
        },
      },
    ];
  });
}
