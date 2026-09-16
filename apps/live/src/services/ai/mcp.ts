import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AiChatInput } from "./types";
import { createMetadataCaller, workitemMetadataTool } from "./metadata";

export interface AiMcpConnection {
  client: Pick<Client, "callTool">;
  tools: Tool[];
  close: () => Promise<void>;
}

export async function connectPlaneMcp(
  input: AiChatInput,
  apiBaseUrl: string,
  signal: AbortSignal
): Promise<AiMcpConnection> {
  signal.throwIfAborted();
  const transport = new StdioClientTransport({
    // Executable path is administrator configuration, never supplied by a chat.
    command: process.env.PLANE_MCP_COMMAND || "/opt/plane-mcp/bin/plane-mcp-server",
    args: ["stdio"],
    env: {
      ...getDefaultEnvironment(),
      PLANE_API_KEY: input.plane_api_token,
      PLANE_WORKSPACE_SLUG: input.workspace_slug,
      PLANE_BASE_URL: apiBaseUrl,
      PLANE_INTERNAL_BASE_URL: apiBaseUrl,
      LOG_PAYLOADS: "false",
      FASTMCP_CHECK_FOR_UPDATES: "off",
    },
    stderr: "ignore",
    maxBufferSize: 2 * 1024 * 1024,
  });
  const client = new Client({ name: "plane-embedded-agent", version: "1.0.0" });
  let closing: Promise<void> | undefined;
  const close = () => {
    signal.removeEventListener("abort", onAbort);
    // StdioClientTransport.close terminates the child, escalating to SIGKILL.
    closing ??= transport.close().catch(() => undefined);
    return closing;
  };
  const onAbort = () => {
    void close();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await client.connect(transport, { signal, timeout: 20_000 });
    const tools: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      // eslint-disable-next-line no-await-in-loop -- each page requires the preceding cursor
      const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 20_000 });
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    if (cursor || tools.length > 100) throw new Error("Unsupported tool catalogue.");
    signal.throwIfAborted();
    const callMetadata = createMetadataCaller(input, apiBaseUrl);
    return {
      client: {
        callTool: (params, schema, options) =>
          params.name === workitemMetadataTool.name
            ? callMetadata(params.arguments ?? {}, options?.signal)
            : client.callTool(params, schema, options),
      },
      tools: [...tools.filter((tool) => tool.name !== workitemMetadataTool.name), workitemMetadataTool],
      close,
    };
  } catch {
    await close();
    throw new Error("Plane tools are unavailable.");
  }
}
