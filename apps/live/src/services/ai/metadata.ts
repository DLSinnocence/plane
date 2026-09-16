import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { AI_LIMITS } from "./types";
import type { AiChatInput } from "./types";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = "id,project,name,sequence_id,parent,state,state_assignees,assignees,created_by";

// Local workflow fields are absent from the upstream MCP catalogue. Use the
// same scoped token and public API, so serializer permissions still apply.
export const workitemMetadataTool: Tool = {
  name: "workitem_metadata",
  description:
    "Read or update a work item's parent and stage assignments. " +
    "retrieve (project_id, workitem_id)\n" +
    "update (project_id, workitem_id; optional parent, state_assignees)\n" +
    "state_assignees maps verified state UUIDs to arrays of project member UUIDs; only supplied stages change. " +
    "parent is a verified work item UUID in the same project, or null to detach. " +
    "Omit fields to preserve them. Only the creator or administrators can change stage assignments; " +
    "backlog/completed/cancelled stages belong to the creator. Read states and project members before writing.",
  inputSchema: {
    type: "object",
    required: ["action", "workitem_id"],
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["retrieve", "update"] },
      project_id: { type: "string" },
      workitem_id: { type: "string" },
      parent: { anyOf: [{ type: "string" }, { type: "null" }] },
      state_assignees: {
        type: "object",
        additionalProperties: { type: "array", items: { type: "string" }, maxItems: 16 },
      },
    },
  },
};

function isAssignmentMap(value: unknown): value is Record<string, string[]> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([state, users]) =>
        uuid.test(state) && Array.isArray(users) && users.every((user) => typeof user === "string" && uuid.test(user))
    )
  );
}

export function validateMetadataArguments(args: Record<string, unknown>): void {
  if (
    Object.keys(args).some((key) => !["action", "project_id", "workitem_id", "parent", "state_assignees"].includes(key))
  )
    throw new Error("Unsupported work item metadata field.");
  if (args.action !== "retrieve" && args.action !== "update") throw new Error("Unsupported metadata action.");
  if (![args.project_id, args.workitem_id].every((id) => typeof id === "string" && uuid.test(id)))
    throw new Error("Project and work item IDs must be UUIDs.");
  const hasParent = Object.hasOwn(args, "parent");
  const hasAssignments = Object.hasOwn(args, "state_assignees");
  if (args.action === "retrieve" && (hasParent || hasAssignments)) throw new Error("Retrieve does not accept changes.");
  if (args.action === "update" && !hasParent && !hasAssignments)
    throw new Error("Supply a parent or stage assignment.");
  if (hasParent && args.parent !== null && (typeof args.parent !== "string" || !uuid.test(args.parent)))
    throw new Error("Parent must be a work item UUID or null.");
  if (hasParent && args.parent === args.workitem_id) throw new Error("A work item cannot be its own parent.");
  if (
    hasAssignments &&
    (!isAssignmentMap(args.state_assignees) ||
      Object.keys(args.state_assignees).length > 100 ||
      Object.values(args.state_assignees).some((users) => users.length > 16))
  )
    throw new Error("Stage assignments must map state UUIDs to arrays of at most 16 user UUIDs.");
}

export function createMetadataCaller(
  input: Pick<AiChatInput, "workspace_slug" | "plane_api_token">,
  apiBaseUrl: string,
  fetchApi: typeof fetch = fetch
) {
  return async (args: Record<string, unknown>, signal?: AbortSignal) => {
    validateMetadataArguments(args);
    const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(AI_LIMITS.toolMs)]);
    const url = `${apiBaseUrl.replace(/\/$/, "")}/api/v1/workspaces/${encodeURIComponent(input.workspace_slug)}/projects/${args.project_id}/work-items/${args.workitem_id}/?fields=${fields}`;
    const request = async (body?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      requestSignal.throwIfAborted();
      const response = await fetchApi(url, {
        method: body ? "PATCH" : "GET",
        headers: { "X-API-Key": input.plane_api_token, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: requestSignal,
        redirect: "error",
      });
      if (!response.ok) throw new Error("Metadata request failed.");
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new Error("Invalid metadata response.");
      return payload as Record<string, unknown>;
    };
    let payload: Record<string, unknown>;
    if (args.action === "retrieve") {
      payload = await request();
    } else {
      const body: Record<string, unknown> = {};
      if (Object.hasOwn(args, "parent")) body.parent = args.parent;
      if (Object.hasOwn(args, "state_assignees")) {
        const current = await request();
        // The API replaces the map. Merge only after reading it successfully so
        // updating one stage cannot reset another stage to the creator.
        if (!isAssignmentMap(current.state_assignees)) throw new Error("Stage assignments could not be read.");
        body.state_assignees = { ...current.state_assignees, ...(args.state_assignees as Record<string, string[]>) };
      }
      payload = await request(body);
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
  };
}
