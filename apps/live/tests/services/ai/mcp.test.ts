import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transport: vi.fn(),
  connect: vi.fn(),
  listTools: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  getDefaultEnvironment: () => ({ PATH: "/usr/bin" }),
  StdioClientTransport: class {
    constructor(options: unknown) {
      mocks.transport(options);
    }
    close = mocks.close;
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mocks.connect;
    listTools = mocks.listTools;
  },
}));

import { connectPlaneMcp } from "@/services/ai/mcp";
import { input } from "./fixtures";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.close.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue(undefined);
  mocks.listTools.mockResolvedValue({ tools: [] });
});

describe("official Plane MCP subprocess", () => {
  it("uses only trusted backend URL and token, suppresses payload logs, and never passes the model key", async () => {
    const control = new AbortController();
    const connection = await connectPlaneMcp(input, "http://api:8000", control.signal);
    expect(mocks.transport).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["stdio"],
        stderr: "ignore",
        maxBufferSize: 2 * 1024 * 1024,
        env: {
          PATH: "/usr/bin",
          PLANE_API_KEY: input.plane_api_token,
          PLANE_WORKSPACE_SLUG: "team",
          PLANE_BASE_URL: "http://api:8000",
          PLANE_INTERNAL_BASE_URL: "http://api:8000",
          LOG_PAYLOADS: "false",
          FASTMCP_CHECK_FOR_UPDATES: "off",
        },
      })
    );
    expect(JSON.stringify(mocks.transport.mock.calls)).not.toContain(input.model_config.api_key);
    control.abort();
    await connection.close();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("cleans a partially started child and sanitizes startup errors", async () => {
    mocks.connect.mockRejectedValue(new Error("secret upstream error"));
    await expect(connectPlaneMcp(input, "http://api:8000", new AbortController().signal)).rejects.toThrow(
      "Plane tools are unavailable."
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("bounds catalogue pagination", async () => {
    mocks.listTools.mockResolvedValue({ tools: [], nextCursor: "endless" });
    await expect(connectPlaneMcp(input, "http://api:8000", new AbortController().signal)).rejects.toThrow();
    expect(mocks.listTools).toHaveBeenCalledTimes(4);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("does not spawn a process for an already disconnected request", async () => {
    await expect(connectPlaneMcp(input, "http://api:8000", AbortSignal.abort())).rejects.toThrow();
    expect(mocks.transport).not.toHaveBeenCalled();
  });
});
