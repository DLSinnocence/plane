import { describe, expect, it } from "vitest";
import { resolveAiEndpoint } from "@/services/ai/endpoint";

describe("request-time AI endpoint resolution", () => {
  it.each([
    ["", "/v1"],
    ["/", "/v1"],
    ["/v1", "/v1"],
    ["/v1/", "/v1"],
    ["/api/v1", "/api/v1"],
    ["/proxy/openai", "/proxy/openai"],
    ["/chat/completions", ""],
    ["/v1/chat/completions/", "/v1"],
    ["/proxy/chat/completions", "/proxy"],
    ["/models", ""],
    ["/v1/models", "/v1"],
  ])("resolves OpenAI %s to SDK base %s", (path, base) => {
    expect(resolveAiEndpoint(`https://example.com${path}`, "openai")).toEqual({
      api: "openai-completions",
      provider: "openai",
      baseUrl: `https://example.com${base}`,
    });
  });

  it.each([
    ["", ""],
    ["/", ""],
    ["/v1", ""],
    ["/v1/messages", ""],
    ["/v1/messages/", ""],
    ["/messages", ""],
    ["/proxy", "/proxy"],
    ["/proxy/v1", "/proxy"],
    ["/proxy/v1/messages", "/proxy"],
    ["/proxy/messages", "/proxy"],
    ["/models", ""],
    ["/v1/models", ""],
  ])("resolves Anthropic %s to SDK base %s", (path, base) => {
    expect(resolveAiEndpoint(`https://example.com${path}`, "anthropic")).toEqual({
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: `https://example.com${base}`,
    });
  });

  it.each([
    ["/responses", "", "openai-responses", "openai"],
    ["/v1/responses/", "/v1", "openai-responses", "openai"],
    ["/proxy/responses", "/proxy", "openai-responses", "openai"],
    ["/chat/completions", "", "openai-completions", "openai"],
    ["/v1/chat/completions", "/v1", "openai-completions", "openai"],
    ["/v1/messages", "", "anthropic-messages", "anthropic"],
    ["/proxy/v1/messages", "/proxy", "anthropic-messages", "anthropic"],
  ])("explicit %s overrides either selected provider", (path, base, api, provider) => {
    for (const selected of ["anthropic", "openai"] as const) {
      expect(resolveAiEndpoint(`https://example.com:8443${path}`, selected)).toEqual({
        api,
        provider,
        baseUrl: `https://example.com:8443${base}`,
      });
    }
  });
});
