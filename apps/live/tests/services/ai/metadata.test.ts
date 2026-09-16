import { describe, expect, it, vi } from "vitest";
import { createMetadataCaller, workitemMetadataTool } from "@/services/ai/metadata";
import { createCeTools } from "@/services/ai/tools";
import { catalogue, input, projectId } from "./fixtures";

const workitemId = "aaaaaaaa-1234-4234-8234-123456789abc";
const parentId = "bbbbbbbb-1234-4234-8234-123456789abc";
const stateId = "cccccccc-1234-4234-8234-123456789abc";
const otherState = "dddddddd-1234-4234-8234-123456789abc";
const args = { action: "update", project_id: projectId, workitem_id: workitemId };
const response = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 });

function harness() {
  const fetchApi = vi.fn<typeof fetch>();
  const call = createMetadataCaller(input, "http://api:8000/", fetchApi);
  const record = vi.fn();
  const onMutation = vi.fn();
  const callTool = vi.fn(
    (
      request: { name: string; arguments?: Record<string, unknown> },
      _schema?: unknown,
      options?: { signal?: AbortSignal }
    ) => call(request.arguments ?? {}, options?.signal)
  );
  const tool = createCeTools(
    catalogue(),
    { callTool },
    projectId,
    [input.plane_api_token],
    () => undefined,
    record,
    onMutation
  ).find((entry) => entry.name === workitemMetadataTool.name)!;
  return { fetchApi, call, tool, record, onMutation, callTool };
}

describe("work item metadata adapter", () => {
  it("reads parent and assignments with the scoped token and returns safe details", async () => {
    const h = harness();
    const payload = {
      id: workitemId,
      project: projectId,
      name: "Client task",
      parent: parentId,
      state_assignees: { [stateId]: [input.user_id] },
      headers: { secret: "hidden" },
    };
    h.fetchApi.mockResolvedValue(response(payload));
    const result = await h.tool.execute("read", { action: "retrieve", workitem_id: workitemId });
    const [url, options] = h.fetchApi.mock.calls[0];
    expect(String(url)).toContain(`/api/v1/workspaces/team/projects/${projectId}/work-items/${workitemId}/?fields=`);
    expect(options).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { "X-API-Key": input.plane_api_token },
    });
    expect(JSON.stringify(options)).not.toContain(input.model_config.api_key);
    expect(JSON.parse(result.details.output!)).toMatchObject({
      parent: parentId,
      state_assignees: payload.state_assignees,
    });
    expect(JSON.stringify(result.details)).not.toContain("hidden");
    expect(result.details.workItems).toEqual([{ id: workitemId, projectId, name: "Client task" }]);
    expect(h.onMutation).not.toHaveBeenCalled();
  });

  it("merges requested stage assignments and preserves all other stages", async () => {
    const h = harness();
    const current = { state_assignees: { [stateId]: [input.user_id], [otherState]: [parentId] } };
    h.fetchApi.mockResolvedValueOnce(response(current)).mockResolvedValueOnce(response({ ...current, id: workitemId }));
    await h.tool.execute("update", { ...args, state_assignees: { [stateId]: [] }, parent: parentId });
    expect(h.fetchApi).toHaveBeenCalledTimes(2);
    expect(JSON.parse(h.fetchApi.mock.calls[1][1]!.body as string)).toEqual({
      parent: parentId,
      state_assignees: { [stateId]: [], [otherState]: [parentId] },
    });
    expect(h.onMutation).toHaveBeenCalledOnce();
  });

  it.each([parentId, null])("writes parent=%s without changing stage assignments", async (parent) => {
    const h = harness();
    h.fetchApi.mockResolvedValue(response({ id: workitemId, parent }));
    await h.tool.execute("parent", { ...args, parent });
    expect(h.fetchApi).toHaveBeenCalledOnce();
    expect(h.fetchApi.mock.calls[0][1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ parent }) });
  });

  it.each([
    { ...args },
    { ...args, parent: "../../secret" },
    { ...args, parent: workitemId },
    { ...args, parent: undefined },
    { ...args, state_assignees: null },
    { ...args, state_assignees: { [stateId]: "person" } },
    { ...args, state_assignees: { [stateId]: ["person"] } },
    { ...args, state_assignees: { wrong: [input.user_id] } },
    { ...args, state_assignees: { [stateId]: Array(17).fill(input.user_id) } },
    { ...args, parent: parentId, state: stateId },
    { ...args, parent: parentId, project_id: "invalid" },
    { ...args, parent: parentId, workitem_id: "invalid" },
    { ...args, action: "retrieve", parent: null },
  ])("rejects invalid metadata before dispatch: %j", async (invalid) => {
    const h = harness();
    await expect(h.tool.execute("invalid", invalid)).rejects.toThrow();
    expect(h.callTool).not.toHaveBeenCalled();
    expect(h.fetchApi).not.toHaveBeenCalled();
    expect(h.onMutation).not.toHaveBeenCalled();
  });

  it.each([{}, { state_assignees: null }, { state_assignees: { wrong: [] } }])(
    "does not overwrite unreadable assignments: %j",
    async (current) => {
      const h = harness();
      h.fetchApi.mockResolvedValue(response(current));
      await expect(h.tool.execute("update", { ...args, state_assignees: { [stateId]: [] } })).rejects.toThrow(
        "Plane could not complete"
      );
      expect(h.fetchApi).toHaveBeenCalledOnce();
      expect(h.fetchApi.mock.calls[0][1]?.method).toBe("GET");
    }
  );

  it.each([400, 403, 500])("preserves API permission and validation failures without retry (%s)", async (status) => {
    const h = harness();
    h.fetchApi.mockResolvedValue(new Response("secret upstream failure", { status }));
    await expect(h.tool.execute("update", { ...args, parent: parentId })).rejects.toThrow("Plane could not complete");
    expect(h.fetchApi).toHaveBeenCalledOnce();
    expect(h.record).not.toHaveBeenCalled();
  });

  it("stops before PATCH if cancelled while reading assignments", async () => {
    const h = harness();
    const control = new AbortController();
    h.fetchApi.mockImplementationOnce(async () => {
      control.abort();
      return response({ state_assignees: { [stateId]: [input.user_id] } });
    });
    await expect(
      h.tool.execute("update", { ...args, state_assignees: { [stateId]: [] } }, control.signal)
    ).rejects.toThrow();
    expect(h.fetchApi).toHaveBeenCalledOnce();
    expect(h.fetchApi.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
