import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { workitemMetadataTool } from "@/services/ai/metadata";
import { CE_ACTIONS } from "@/services/ai/tools";
import type { AiChatInput } from "@/services/ai/types";

export const projectId = "12345678-1234-4234-8234-123456789abc";
export const input: AiChatInput = {
  user_id: "87654321-1234-4234-8234-123456789abc",
  workspace_slug: "team",
  project_id: projectId,
  messages: [{ role: "user", content: "List my tasks" }],
  model_config: {
    provider: "openai",
    model: "custom-model",
    base_url: "https://example.com/v1",
    api_key: "model-secret",
  },
  plane_api_token: "plane_api_test-secret",
};
export const catalogue = (): Tool[] =>
  Object.entries(CE_ACTIONS)
    .map<Tool>(([name, actions]) => ({
      name,
      description: "Cloud tool supporting all operations and PQL.",
      inputSchema: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", enum: [...actions, "delete"] },
          project_id: { type: "string" },
          ...(name === "workitem"
            ? {
                name: { type: "string" },
                workitem_id: { type: "string" },
                labels: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }], default: null },
              }
            : {}),
          pql: { type: "string" },
          type_id: { type: "string" },
        },
      },
    }))
    .map((tool) => (tool.name === workitemMetadataTool.name ? structuredClone(workitemMetadataTool) : tool));
