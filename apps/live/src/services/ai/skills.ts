import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { AiToolDetails } from "./types";
import { writingPlaneRequirements } from "./skills/writing-plane-requirements";

// Bundled definitions are the only source of skill instructions; no user paths or MCP content are loaded.
export const BUILTIN_SKILLS = [writingPlaneRequirements] as const;
export const SKILL_FAILURE_OUTPUT = "The skill could not be loaded. Use an available skill name and try again.";

export function createSkillTool(
  takeCall: () => void,
  recordDetails: (id: string, name: string, details: AiToolDetails) => void
): AgentTool {
  return {
    name: "skill",
    label: "Load writing skill",
    description: "Load a built-in skill by its exact name from the available skills directory. This is read-only.",
    parameters: Type.Object(
      {
        action: Type.Literal("load"),
        name: Type.Union(BUILTIN_SKILLS.map((skill) => Type.Literal(skill.name))),
      },
      { additionalProperties: false }
    ),
    executionMode: "sequential",
    execute: async (id, raw, signal) => {
      signal?.throwIfAborted();
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        !("action" in raw) ||
        raw.action !== "load" ||
        !("name" in raw) ||
        Object.keys(raw).some((key) => key !== "action" && key !== "name")
      )
        throw new Error(SKILL_FAILURE_OUTPUT);
      const skill = BUILTIN_SKILLS.find((candidate) => candidate.name === raw.name);
      if (!skill) throw new Error(SKILL_FAILURE_OUTPUT);
      takeCall();
      signal?.throwIfAborted();
      const details: AiToolDetails = { input: skill.name, output: "Writing instructions loaded." };
      recordDetails(id, "skill", { ...details });
      return { content: [{ type: "text", text: skill.instructions }], details };
    },
  };
}
