import { z } from "zod";
import { aiMessageSchema, MAX_CHAT_IMAGES } from "./images";

export const AI_LIMITS = {
  runMs: 120_000,
  toolMs: 20_000,
  turns: 8,
  calls: 16,
  toolResultChars: 32_000,
  outputChars: 100_000,
  concurrentRuns: 8,
} as const;

// Django validates the user's chosen HTTP(S) model endpoint and credentials.
// This internal endpoint accepts only service-authenticated requests.
const modelUrl = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  });

export const aiChatSchema = z
  .object({
    user_id: z.string().uuid(),
    workspace_slug: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[a-zA-Z0-9_-]+$/),
    project_id: z.string().uuid().nullable(),
    messages: z.array(aiMessageSchema).min(1).max(40),
    model_config: z
      .object({
        provider: z.enum(["openai", "anthropic"]),
        base_url: modelUrl,
        model: z.string().trim().min(1).max(255),
        api_key: z.string().min(1).max(4096),
        supports_images: z.boolean().optional(),
        supports_reasoning: z.boolean().optional(),
      })
      .strict(),
    plane_api_token: z.string().min(1).max(255),
  })
  .strict()
  .refine((value) => value.messages.at(-1)?.role === "user")
  .refine((value) => value.messages.reduce((size, message) => size + message.content.length, 0) <= 60_000)
  .refine(
    (value) => value.messages.reduce((count, message) => count + (message.images?.length ?? 0), 0) <= MAX_CHAT_IMAGES
  )
  .refine((value) => value.model_config.supports_images || !value.messages.some((message) => message.images?.length));

export type AiChatInput = z.infer<typeof aiChatSchema>;
export type AiDoneReason = "complete" | "error" | "cancelled" | "limit";
export interface AiToolDetails {
  input?: string;
  output?: string;
  truncated?: boolean;
  workItems?: Array<{ id: string; projectId: string; identifier?: string; name: string }>;
}
export type AiStreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      action: string;
      status: "running" | "complete" | "error";
      details?: AiToolDetails;
    }
  | { type: "error"; code?: string; message: string; may_have_changes?: boolean }
  | { type: "done"; reason: AiDoneReason };
export type AiEmit = (event: AiStreamEvent) => Promise<void>;
