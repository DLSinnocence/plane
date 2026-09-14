import { describe, expect, it } from "vitest";
import { parseToolPayload, projectToolDetails } from "@/services/ai/details";
import { sanitizeToolText } from "@/services/ai/tools";
import { input, projectId } from "./fixtures";

const id = "aaaaaaaa-1234-4234-8234-123456789abc";
const redact = (text: string) => sanitizeToolText(text, [input.model_config.api_key, input.plane_api_token]);
describe("safe tool details projection", () => {
  it("drops unknown fields recursively and redacts allowed strings", () => {
    const details = projectToolDetails(
      { action: "list", headers: { Authorization: "secret" } },
      {
        results: [
          {
            id,
            project: projectId,
            name: `Task ${input.model_config.api_key} ${input.plane_api_token}`,
            identifier: "TEST-42",
            metadata: { name: "secret" },
            state: { name: "Todo", api_key: "secret" },
          },
        ],
        headers: "secret",
      },
      true,
      redact
    );
    expect(details.workItems).toEqual([{ id, projectId, name: "Task [redacted] [redacted]", identifier: "TEST-42" }]);
    expect(JSON.stringify(details)).not.toMatch(/secret|Authorization|api_key|metadata|headers/);
    expect(details.output).toContain("Todo");
  });
  it("bounds huge, deep and cyclic payloads without invoking getters", () => {
    const payload: Record<string, unknown> = {
      results: Array.from({ length: 30 }, () => ({ id, project: projectId, name: "x".repeat(8000) })),
    };
    payload.data = payload;
    Object.defineProperty(payload, "name", {
      get() {
        throw new Error("getter must not execute");
      },
    });
    const details = projectToolDetails({ action: "list" }, payload, true, redact);
    expect(details.truncated).toBe(true);
    expect(details.input!.length).toBeLessThanOrEqual(6000);
    expect(details.output!.length).toBeLessThanOrEqual(6000);
    expect(details.workItems).toHaveLength(20);
    expect(details.workItems!.every((item) => item.name.length <= 300)).toBe(true);
    let nested: unknown = { name: "hidden" };
    for (let i = 0; i < 100; i++) nested = { data: nested };
    expect(projectToolDetails({}, nested, true, redact)).toMatchObject({ truncated: true });
  });
  it("only derives references from result envelopes and verified resource fields", () => {
    const record = { id, project: projectId, name: "Task" };
    expect(projectToolDetails(record, undefined, true, redact).workItems).toBeUndefined();
    expect(
      projectToolDetails({}, { metadata: record, state: record, project: record }, true, redact).workItems
    ).toBeUndefined();
    expect(projectToolDetails({}, ["Authorization: unknown-secret"], true, redact).output).toBe("[]");
    expect(projectToolDetails({}, record, true, (value) => sanitizeToolText(value, [id])).workItems).toBeUndefined();
    expect(
      projectToolDetails({}, { results: [{ ...record, success: false }] }, true, redact).workItems
    ).toBeUndefined();
    expect(projectToolDetails({}, record, false, redact).workItems).toBeUndefined();
    expect(projectToolDetails({}, { ...record, id: "../../unsafe" }, true, redact).workItems).toBeUndefined();
    expect(projectToolDetails({}, { id, name: "Missing project" }, true, redact).workItems).toBeUndefined();
    expect(projectToolDetails({}, { ...record, identifier: "../wrong" }, true, redact).workItems).toEqual([
      { id, projectId, name: "Task" },
    ]);
  });
  it("never treats arbitrary text, oversized JSON or malformed JSON as safe payloads", () => {
    for (const text of ["Authorization: secret", "{broken", "[" + " ".repeat(128000) + "]"]) {
      expect(parseToolPayload({}, [text])).toBeUndefined();
    }
  });
});
