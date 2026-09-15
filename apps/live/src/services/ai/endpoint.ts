import type { AiChatInput } from "./types";

export interface AiEndpoint {
  api: "openai-completions" | "openai-responses" | "anthropic-messages";
  provider: AiChatInput["model_config"]["provider"];
  baseUrl: string;
}

// Resolve per request: saved settings remain exactly as entered by the user.
export function resolveAiEndpoint(baseUrl: string, provider: AiEndpoint["provider"]): AiEndpoint {
  const url = new URL(baseUrl);
  let path = url.pathname.replace(/\/+$/, "");
  let api: AiEndpoint["api"] = provider === "anthropic" ? "anthropic-messages" : "openai-completions";
  const suffix = ["/chat/completions", "/responses", "/messages", "/models"].find((value) => path.endsWith(value));
  if (suffix) {
    path = path.slice(0, -suffix.length);
    if (suffix === "/chat/completions") api = "openai-completions";
    if (suffix === "/responses") api = "openai-responses";
    if (suffix === "/messages") api = "anthropic-messages";
  }
  if (api === "anthropic-messages") {
    // Anthropic's SDK always appends /v1/messages. An explicit unversioned
    // /messages endpoint therefore uses /v1/messages with this adapter too.
    path = path.replace(/\/v1$/, "");
  } else if (!path && !suffix) {
    path = "/v1";
  }
  url.pathname = path;
  return {
    api,
    provider: api === "anthropic-messages" ? "anthropic" : "openai",
    baseUrl: url.toString().replace(/\/$/, ""),
  };
}
