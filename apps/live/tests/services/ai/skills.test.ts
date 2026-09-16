import { describe, expect, it, vi } from "vitest";
import { BUILTIN_SKILLS, createSkillTool, SKILL_FAILURE_OUTPUT } from "@/services/ai/skills";
import { createSystemPrompt } from "@/services/ai/prompts";
import { input } from "./fixtures";

const args = { action: "load", name: "writing-plane-requirements" };

describe("built-in writing skills", () => {
  it("loads the bundled instructions and records only a safe summary", async () => {
    const takeCall = vi.fn();
    const record = vi.fn();
    const tool = createSkillTool(takeCall, record);
    const result = await tool.execute("load-1", args);
    expect(result.content).toEqual([{ type: "text", text: BUILTIN_SKILLS[0].instructions }]);
    expect(record).toHaveBeenCalledWith("load-1", "skill", {
      input: args.name,
      output: "Writing instructions loaded.",
    });
    expect(takeCall).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][2]).not.toBe(result.details);
    expect(JSON.stringify(result.details)).not.toContain(BUILTIN_SKILLS[0].instructions);
    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
  });

  it.each([
    null,
    [],
    {},
    { ...args, name: "../../private" },
    { ...args, name: "toString" },
    { ...args, name: 42 },
    { ...args, action: "write" },
    { ...args, path: "/private" },
  ])("rejects unsupported arguments without recording a load: %j", async (raw) => {
    const takeCall = vi.fn();
    const record = vi.fn();
    await expect(createSkillTool(takeCall, record).execute("bad", raw)).rejects.toThrow(SKILL_FAILURE_OUTPUT);
    expect(takeCall).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("honors cancellation before returning instructions", async () => {
    const record = vi.fn();
    const takeCall = vi.fn();
    await expect(createSkillTool(takeCall, record).execute("cancelled", args, AbortSignal.abort())).rejects.toThrow();
    expect(takeCall).not.toHaveBeenCalled();
    takeCall.mockImplementation(() => {
      throw new Error("Run cancelled.");
    });
    await expect(createSkillTool(takeCall, record).execute("cancelled", args)).rejects.toThrow("cancelled");
    expect(record).not.toHaveBeenCalled();
  });

  it("advertises the same skill directory on every request without embedding its body or credentials", () => {
    const prompt = createSystemPrompt(input);
    for (const skill of BUILTIN_SKILLS) {
      expect(prompt).toContain(`${skill.name}: ${skill.description}`);
      expect(prompt).not.toContain(skill.instructions);
    }
    expect(prompt).toContain(`Current workspace: ${input.workspace_slug}. Current project ID: ${input.project_id}.`);
    expect(prompt).not.toContain(input.model_config.api_key);
    expect(prompt).not.toContain(input.plane_api_token);
    expect(createSystemPrompt({ workspace_slug: "other", project_id: null })).toContain("Current project ID: none.");
  });
});
