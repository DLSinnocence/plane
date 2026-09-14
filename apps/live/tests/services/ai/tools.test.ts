import { describe, expect, it, vi } from "vitest";
import {
  CE_ACTIONS,
  createCeTools,
  createTextRedactor,
  prepareCeArguments,
  sanitizeToolText,
} from "@/services/ai/tools";
import { catalogue, projectId } from "./fixtures";

// These tests enforce the compatibility/security boundary independently of the
// provider. The published MCP advertises more actions than CE can implement.
describe("Plane CE MCP adapter", () => {
  it("filters legacy/cloud tools and removes unsupported actions and fields", () => {
    const tools = createCeTools(
      [...catalogue(), { name: "bash", inputSchema: { type: "object" } }],
      { callTool: vi.fn() },
      projectId,
      [],
      () => undefined
    );
    expect(tools.map((tool) => tool.name)).toEqual(Object.keys(CE_ACTIONS));
    for (const tool of tools) {
      expect(tool.executionMode).toBe("sequential");
      const schema = tool.parameters as { properties: Record<string, { enum?: string[] }> };
      expect(schema.properties.pql).toBeUndefined();
      expect(schema.properties.type_id).toBeUndefined();
      expect(schema.properties.action.enum).not.toContain("delete");
    }
    expect(() =>
      createCeTools(
        [{ name: "list_projects", inputSchema: { type: "object" } }],
        { callTool: vi.fn() },
        null,
        [],
        () => undefined
      )
    ).toThrow("version");
  });

  it("rejects forbidden actions and requires project scope while retaining explicit projects", () => {
    expect(() => prepareCeArguments("workitem", { action: "count" }, projectId)).toThrow();
    expect(() => prepareCeArguments("workitem", { action: "list", pql: "priority=urgent" }, projectId)).toThrow();
    expect(() => prepareCeArguments("state", { action: "list" }, null)).toThrow("project");
    expect(prepareCeArguments("workitem", { action: "list" }, projectId).project_id).toBe(projectId);
    const otherProject = "aaaaaaaa-1234-4234-8234-123456789abc";
    expect(prepareCeArguments("workitem", { action: "list", project_id: otherProject }, projectId).project_id).toBe(
      otherProject
    );
    expect(prepareCeArguments("workitem", { action: "search", query: "login" }, null).project_id).toBeUndefined();
    expect(() => prepareCeArguments("project", { action: "retrieve", project_id: "../../users" }, null)).toThrow(
      "UUID"
    );
    expect(() =>
      prepareCeArguments("cycle", { action: "manage_workitems", add_ids: Array(17).fill("id") }, projectId)
    ).toThrow("16");
    expect(() =>
      prepareCeArguments(
        "workitem",
        {
          action: "retrieve_by_identifier",
          workitem_identifier: "../../users-1",
        },
        null
      )
    ).toThrow("identifier");
    expect(() => prepareCeArguments("project", { action: "list", per_page: 1000 }, null)).toThrow("Page size");
  });

  it("passes cancellation and a fixed timeout, scrubs successful results and caps output", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValue({ content: [{ type: "text", text: `model-secret plane_api_token ${"x".repeat(40_000)}` }] });
    const takeCall = vi.fn();
    const tool = createCeTools(catalogue(), { callTool }, projectId, ["model-secret", "plane_api_token"], takeCall)[0];
    const signal = new AbortController().signal;
    const result = await tool.execute("call", { action: "list" }, signal);
    expect(callTool).toHaveBeenCalledWith(
      { name: "project", arguments: { action: "list" } },
      undefined,
      expect.objectContaining({ signal, timeout: 20_000, resetTimeoutOnProgress: false })
    );
    expect(takeCall).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("model-secret");
    expect(JSON.stringify(result)).not.toContain("plane_api_token");
    expect(JSON.stringify(result)).toContain("truncated");
  });

  it.each([
    { content: [{ type: "text", text: "Authorization: Bearer secret" }], isError: true },
    { content: [{ type: "text", text: "Error: upstream secret" }] },
  ])("turns upstream error payloads into fixed safe errors without retry", async (upstream) => {
    const callTool = vi.fn().mockResolvedValue(upstream);
    const tool = createCeTools(catalogue(), { callTool }, projectId, [], () => undefined)[0];
    await expect(tool.execute("call", { action: "list" })).rejects.toThrow("Plane could not complete");
    expect(callTool).toHaveBeenCalledOnce();
  });

  it("projects cyclic structured MCP payloads safely and isolates recorded details", async () => {
    const payload: Record<string, unknown> = {
      name: "Safe model-secret",
      headers: { Authorization: "unknown-secret" },
    };
    payload.data = payload;
    const record = vi.fn();
    const tool = createCeTools(
      catalogue(),
      { callTool: vi.fn().mockResolvedValue({ structuredContent: payload }) },
      projectId,
      ["model-secret"],
      () => undefined,
      record
    )[0];
    const result = await tool.execute("call", { action: "list" });
    expect(result.details).toMatchObject({ truncated: true });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(record).toHaveBeenCalledWith("call", "project", result.details);
    expect(record.mock.calls[0][2]).not.toBe(result.details);
  });

  it("redacts secrets across chunk boundaries without losing ordinary trailing text", () => {
    const redactor = createTextRedactor(["model-secret", "plane_api_token", "abcab"]);
    const result = [
      redactor.push("Hello model-se"),
      redactor.push("cret plane_api_to"),
      redactor.push("ken abc"),
      redactor.push("ab team"),
      redactor.finish(),
    ].join("");
    expect(result).toBe("Hello [redacted] [redacted] [redacted] team");
  });

  it("does not call MCP for cancellation or an invalid action", async () => {
    const callTool = vi.fn();
    const tool = createCeTools(catalogue(), { callTool }, projectId, [], () => undefined)[0];
    await expect(tool.execute("call", { action: "delete" })).rejects.toThrow();
    await expect(tool.execute("call", { action: "list" }, AbortSignal.abort())).rejects.toThrow();
    expect(callTool).not.toHaveBeenCalled();
    expect(sanitizeToolText("plane_api_unknown", [])).toBe("[redacted]");
  });
});
