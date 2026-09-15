import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent, AgentOptions } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream, getModel } from "@mariozechner/pi-ai";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { createChatModel, runAiChat } from "@/services/ai/runtime";
import type { AiStreamEvent } from "@/services/ai/types";
import { catalogue, input } from "./fixtures";

function harness(prompt?: (event: (value: AgentEvent) => Promise<void>, options: AgentOptions) => Promise<void>) {
  let listener: ((event: AgentEvent) => Promise<void>) | undefined;
  let options: AgentOptions;
  const events: AiStreamEvent[] = [];
  const connection = {
    tools: catalogue(),
    client: { callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }) },
    close: vi.fn().mockResolvedValue(undefined),
  };
  const agent = {
    state: { isStreaming: false },
    subscribe: vi.fn((fn: typeof listener) => {
      listener = fn;
      return vi.fn();
    }),
    prompt: vi.fn(async () => {
      if (listener) await prompt?.(listener, options);
    }),
    abort: vi.fn(),
    reset: vi.fn(),
  };
  const dependencies = {
    createAgent: vi.fn((value: AgentOptions) => {
      options = value;
      return agent as unknown as Agent;
    }),
    connectMcp: vi.fn().mockResolvedValue(connection),
    runMs: 120_000,
  };
  const emit = async (event: AiStreamEvent) => {
    events.push(event);
  };
  return { agent, events, connection, dependencies, emit };
}

function assistantMessage(
  model: { api: AssistantMessage["api"]; provider: string; id: string },
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop"
): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    content,
    stopReason,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

const completionChunk = (delta: Record<string, string>, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ id: "local", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const anthropicChunk = (event: { type: string; [key: string]: unknown }) =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

afterEach(() => vi.useRealTimers());

describe("ephemeral Pi runtime", () => {
  it("supports arbitrary OpenAI-compatible and Anthropic model IDs and endpoints", () => {
    expect(createChatModel(input.model_config)).toMatchObject({
      api: "openai-completions",
      id: "custom-model",
      baseUrl: "https://example.com/v1",
    });
    expect(createChatModel({ ...input.model_config, provider: "anthropic", model: "private-claude" })).toMatchObject({
      api: "anthropic-messages",
      id: "private-claude",
      reasoning: false,
    });
  });

  it.each([
    { model: "deepseek-v4-flash", base_url: "https://api.deepseek.com" },
    { model: "deepseek-v4-pro", base_url: "https://example.com/v1" },
    { model: "deepseek/deepseek-v4-pro", base_url: "https://example.com/gateway" },
  ])("keeps the configured transport while resolving effort metadata for $model", ({ model, base_url }) => {
    const resolved = createChatModel({ ...input.model_config, model, base_url, supports_reasoning: true });
    expect(resolved).toMatchObject({
      id: model,
      baseUrl: base_url === "https://api.deepseek.com" ? `${base_url}/v1` : base_url,
      provider: "openai",
      api: "openai-completions",
      maxTokens: 16_384,
      thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
    });
    expect(resolved.compat).toEqual({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: undefined,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    });
  });

  it.each([
    { base_url: "https://api.openai.com/v1", maxTokensField: "max_completion_tokens" },
    { base_url: "https://example.com/gateway/v1", maxTokensField: "max_tokens" },
  ])("ignores empty SDK endpoints when resolving o3 on $base_url", ({ base_url, maxTokensField }) => {
    expect(getModel("azure-openai-responses", "o3").baseUrl).toBe("");
    const resolved = createChatModel({ ...input.model_config, model: "o3", base_url, supports_reasoning: true });
    expect(resolved).toMatchObject({
      id: "o3",
      baseUrl: base_url,
      provider: "openai",
      api: "openai-completions",
      reasoning: true,
      compat: { maxTokensField },
    });
    if (base_url === "https://api.openai.com/v1")
      expect(resolved.thinkingLevelMap).toEqual(getModel("openai", "o3").thinkingLevelMap);
  });

  it.each(["custom-model", "deepseek-v4-pro-private"])("does not guess reasoning metadata for %s", (model) => {
    const resolved = createChatModel({ ...input.model_config, model, supports_reasoning: true });
    expect(resolved.id).toBe(model);
    expect(resolved.thinkingLevelMap).toBeUndefined();
  });

  it("enables thinking only for models with known support and leaves room for the answer", async () => {
    const h = harness();
    await runAiChat(
      { ...input, model_config: { ...input.model_config, supports_reasoning: true } },
      "http://api:8000",
      h.emit,
      new AbortController().signal,
      h.dependencies
    );
    expect(h.dependencies.createAgent.mock.calls[0][0].initialState).toMatchObject({
      thinkingLevel: "low",
      model: { reasoning: true, maxTokens: 16_384 },
    });
    expect(createChatModel(input.model_config)).toMatchObject({ reasoning: false, maxTokens: 4096 });
    expect(
      createChatModel({
        ...input.model_config,
        base_url: "https://api.openai.com/v1",
        supports_reasoning: true,
      }).compat
    ).toMatchObject({ maxTokensField: "max_completion_tokens", supportsReasoningEffort: undefined });
  });

  it("forwards only text and safe tool metadata; constructs sequential tools and closes the process", async () => {
    const h = harness(async (event) => {
      await event({ type: "turn_start" });
      await event({
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: { type: "text_delta", delta: "Hello", contentIndex: 0, partial: {} as never },
      });
      await event({
        type: "tool_execution_start",
        toolCallId: "unsafe-model-secret",
        toolName: "project",
        args: { action: "list", api_key: "model-secret" },
      });
      await event({
        type: "tool_execution_end",
        toolCallId: "unsafe-model-secret",
        toolName: "project",
        result: {
          leaked: "model-secret",
          details: {
            input: "model-secret",
            output: "forged",
            workItems: [{ id: input.user_id, projectId: input.project_id, name: "forged" }],
          },
        },
        isError: false,
      });
    });
    await runAiChat(input, "http://api:8000", h.emit, new AbortController().signal, h.dependencies);
    expect(h.events).toEqual([
      { type: "text", text: "Hello" },
      { type: "tool", id: "tool-1", name: "project", action: "list", status: "running" },
      { type: "tool", id: "tool-1", name: "project", action: "list", status: "complete" },
      { type: "done", reason: "complete" },
    ]);
    const options = h.dependencies.createAgent.mock.calls[0][0];
    expect(options.toolExecution).toBe("sequential");
    expect(options.getApiKey?.("openai")).toBe("model-secret");
    expect(options.initialState?.systemPrompt).not.toContain("model-secret");
    expect(h.connection.close).toHaveBeenCalledOnce();
    expect(h.agent.reset).toHaveBeenCalledOnce();
  });

  it("passes user images to Pi and retains prior visual context without leaking image bytes to browser events", async () => {
    const h = harness();
    const image = {
      mime_type: "image/png" as const,
      name: "screen.png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=",
    };
    const request = {
      ...input,
      model_config: { ...input.model_config, supports_images: true },
      messages: [
        { role: "user" as const, content: "Look at this", images: [image] },
        { role: "assistant" as const, content: "I see the screen" },
        { role: "user" as const, content: "", images: [image] },
      ],
    };
    await runAiChat(request, "http://api:8000", h.emit, new AbortController().signal, h.dependencies);
    const options = h.dependencies.createAgent.mock.calls[0][0];
    expect(options.initialState?.model?.input).toEqual(["text", "image"]);
    expect(options.initialState?.messages?.[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "Look at this" },
        { type: "image", data: image.data, mimeType: "image/png" },
      ],
    });
    expect(h.agent.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: [{ type: "image", data: image.data, mimeType: "image/png" }] })
    );
    expect(JSON.stringify(h.events)).not.toContain(image.data);
    expect(createChatModel({ ...input.model_config, provider: "anthropic", supports_images: true }).input).toContain(
      "image"
    );
  });

  it("sends images through the actual OpenAI-compatible provider and streams its answer", async () => {
    const h = harness();
    const bodies: { messages: { role: string; content: unknown }[] }[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      bodies.push(JSON.parse(body));
      const chunk = {
        id: "chatcmpl-local",
        object: "chat.completion.chunk",
        created: 0,
        model: "vision-custom",
        choices: [{ index: 0, delta: { role: "assistant", content: "A red square." }, finish_reason: null }],
      };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const image = {
      mime_type: "image/png" as const,
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=",
    };
    try {
      await runAiChat(
        {
          ...input,
          model_config: {
            ...input.model_config,
            base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
            supports_images: true,
          },
          messages: [{ role: "user", content: "Describe it", images: [image] }],
        },
        "http://api:8000",
        h.emit,
        new AbortController().signal,
        { ...h.dependencies, createAgent: (options) => new Agent(options) }
      );
      expect(bodies).toHaveLength(1);
      expect(bodies[0].messages.find((message) => message.role === "user")?.content).toEqual(
        expect.arrayContaining([
          { type: "text", text: "Describe it" },
          expect.objectContaining({
            type: "image_url",
            image_url: expect.objectContaining({ url: `data:image/png;base64,${image.data}` }),
          }),
        ])
      );
      expect(h.events).toContainEqual({ type: "text", text: "A red square." });
      expect(h.events.at(-1)).toEqual({ type: "done", reason: "complete" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it.each([
    { field: "reasoning_content", supports_reasoning: undefined, path: "", route: "/v1/chat/completions" },
    { field: "reasoning", supports_reasoning: undefined, path: "/", route: "/v1/chat/completions" },
    { field: "reasoning_text", supports_reasoning: undefined, path: "/v1", route: "/v1/chat/completions" },
    {
      field: "reasoning_content",
      supports_reasoning: true,
      path: "/v1/chat/completions",
      route: "/v1/chat/completions",
    },
    { field: "reasoning_content", supports_reasoning: true, path: "/chat/completions", route: "/chat/completions" },
    { field: "reasoning_content", supports_reasoning: true, path: "/models", route: "/chat/completions" },
    {
      field: "reasoning_content",
      supports_reasoning: true,
      path: "/proxy/openai",
      route: "/proxy/openai/chat/completions",
    },
  ])(
    "streams native $field before completion using $path (supported=$supports_reasoning)",
    async ({ field, supports_reasoning, path, route }) => {
      const h = harness();
      let receivedThinking: (() => void) | undefined;
      const thinkingDelivered = new Promise<void>((resolve) => {
        receivedThinking = resolve;
      });
      let receivedText: (() => void) | undefined;
      const textDelivered = new Promise<void>((resolve) => {
        receivedText = resolve;
      });
      const requests: { method: string | undefined; path: string | undefined; authorization: string | undefined }[] =
        [];
      let requestBody: Record<string, unknown> | undefined;
      let providerEnded = false;
      const server = createServer(async (req, res) => {
        requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
        if (req.url !== route) {
          res.writeHead(404).end();
          return;
        }
        let body = "";
        for await (const chunk of req) body += String(chunk);
        requestBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(completionChunk({ [field]: "Checking your project. " }));
        // A real handshake: the provider cannot send an answer or finish until
        // Plane has delivered thinking, so buffering until done fails this test.
        await thinkingDelivered;
        res.write(completionChunk({ content: "Your project is ready." }));
        await textDelivered;
        providerEnded = true;
        res.end(completionChunk({}, "stop") + "data: [DONE]\n\n");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        await runAiChat(
          {
            ...input,
            model_config: {
              ...input.model_config,
              supports_reasoning,
              // Deliberately select Anthropic for explicit OpenAI endpoints.
              provider: path.endsWith("/chat/completions") ? "anthropic" : "openai",
              base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
            },
          },
          "http://api:8000",
          async (event) => {
            if (event.type === "thinking") {
              expect(providerEnded).toBe(false);
              receivedThinking?.();
            }
            if (event.type === "text") {
              expect(providerEnded).toBe(false);
              receivedText?.();
            }
            await h.emit(event);
          },
          new AbortController().signal,
          { ...h.dependencies, runMs: 2000, createAgent: (options) => new Agent(options) }
        );
        expect(requests).toEqual([{ method: "POST", path: route, authorization: "Bearer model-secret" }]);
        expect(requestBody).toMatchObject({
          model: input.model_config.model,
          stream: true,
          max_tokens: supports_reasoning ? 16_384 : 4096,
        });
        if (supports_reasoning) expect(requestBody).toHaveProperty("reasoning_effort", "low");
        else expect(requestBody).not.toHaveProperty("reasoning_effort");
        expect(h.events).toEqual([
          { type: "thinking", text: "Checking your project. " },
          { type: "text", text: "Your project is ready." },
          { type: "done", reason: "complete" },
        ]);
      } finally {
        receivedThinking?.();
        receivedText?.();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );

  it.each(["deepseek-v4-flash", "deepseek-v4-pro"])("sends a supported effort to native %s", async (model) => {
    const h = harness();
    let requestBody: Record<string, unknown> | undefined;
    let requestUrl: string | undefined;
    // Intercept transport only: keep the native origin so Pi uses its DeepSeek format.
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const request = new Request(url, init);
      requestUrl = request.url;
      requestBody = (await request.json()) as Record<string, unknown>;
      return new Response(
        completionChunk({ reasoning_content: "Checking your project. " }) +
          completionChunk({ content: "Your project is ready." }) +
          completionChunk({}, "stop") +
          "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } }
      );
    });
    const createAgent = vi.fn((options: AgentOptions) => new Agent(options));
    try {
      await runAiChat(
        {
          ...input,
          model_config: {
            ...input.model_config,
            model,
            base_url: "https://api.deepseek.com",
            supports_reasoning: true,
          },
        },
        "http://api:8000",
        h.emit,
        new AbortController().signal,
        { ...h.dependencies, createAgent }
      );
      expect(fetch).toHaveBeenCalledOnce();
      expect(requestUrl).toBe("https://api.deepseek.com/v1/chat/completions");
      expect(requestBody).toMatchObject({
        model,
        stream: true,
        thinking: { type: "enabled" },
        reasoning_effort: "high",
        max_tokens: 16_384,
      });
      expect(createAgent.mock.calls[0][0].initialState?.thinkingLevel).toBe("high");
      expect(h.events).toEqual([
        { type: "thinking", text: "Checking your project. " },
        { type: "text", text: "Your project is ready." },
        { type: "done", reason: "complete" },
      ]);
    } finally {
      fetch.mockRestore();
    }
  });

  it.each([
    { model: "claude-sonnet-4-5", thinking: { type: "enabled", budget_tokens: 2048 }, path: "", route: "/v1/messages" },
    { model: "claude-sonnet-4-6", thinking: { type: "adaptive" }, path: "/v1", route: "/v1/messages" },
    {
      model: "claude-sonnet-4-5",
      thinking: { type: "enabled", budget_tokens: 2048 },
      path: "/v1/messages",
      route: "/v1/messages",
    },
    {
      model: "claude-sonnet-4-5",
      thinking: { type: "enabled", budget_tokens: 2048 },
      path: "/proxy/v1/messages",
      route: "/proxy/v1/messages",
    },
    {
      model: "claude-sonnet-4-5",
      thinking: { type: "enabled", budget_tokens: 2048 },
      path: "/proxy/v1",
      route: "/proxy/v1/messages",
    },
    {
      model: "claude-sonnet-4-5",
      thinking: { type: "enabled", budget_tokens: 2048 },
      path: "/messages",
      route: "/v1/messages",
    },
  ])("streams Anthropic thinking for $model using $path", async ({ model, thinking, path, route }) => {
    const h = harness();
    let receivedThinking: (() => void) | undefined;
    const thinkingDelivered = new Promise<void>((resolve) => {
      receivedThinking = resolve;
    });
    let requestBody: Record<string, unknown> | undefined;
    const requests: { method: string | undefined; path: string | undefined; apiKey: string | string[] | undefined }[] =
      [];
    let providerEnded = false;
    const server = createServer(async (req, res) => {
      requests.push({ method: req.method, path: req.url, apiKey: req.headers["x-api-key"] });
      if (req.url !== route) {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const part of req) body += String(part);
      requestBody = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        anthropicChunk({
          type: "message_start",
          message: {
            id: "msg-local",
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        }) +
          anthropicChunk({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) +
          anthropicChunk({
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Checking your project. " },
          })
      );
      await thinkingDelivered;
      res.write(
        anthropicChunk({ type: "content_block_stop", index: 0 }) +
          anthropicChunk({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }) +
          anthropicChunk({
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "Your project is ready." },
          }) +
          anthropicChunk({ type: "content_block_stop", index: 1 })
      );
      providerEnded = true;
      res.end(
        anthropicChunk({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }) +
          anthropicChunk({ type: "message_stop" })
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      await runAiChat(
        {
          ...input,
          model_config: {
            ...input.model_config,
            provider: path.endsWith("/messages") ? "openai" : "anthropic",
            model,
            base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
            supports_reasoning: true,
          },
        },
        "http://api:8000",
        async (event) => {
          if (event.type === "thinking") {
            expect(providerEnded).toBe(false);
            receivedThinking?.();
          }
          await h.emit(event);
        },
        new AbortController().signal,
        { ...h.dependencies, runMs: 2000, createAgent: (options) => new Agent(options) }
      );
      expect(requests).toEqual([{ method: "POST", path: route, apiKey: "model-secret" }]);
      expect(requestBody).toMatchObject({ model, stream: true, max_tokens: 16_384, thinking });
      if (thinking.type === "adaptive") expect(requestBody).toHaveProperty("output_config.effort", "low");
      expect(h.events).toEqual([
        { type: "thinking", text: "Checking your project. " },
        { type: "text", text: "Your project is ready." },
        { type: "done", reason: "complete" },
      ]);
    } finally {
      receivedThinking?.();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["/responses", "/v1/responses", "/proxy/responses/"])(
    "uses the real Responses adapter for %s with one POST",
    async (path) => {
      const h = harness();
      const requests: { method: string | undefined; path: string | undefined; authorization: string | undefined }[] =
        [];
      let requestBody: Record<string, unknown> | undefined;
      let receivedText: (() => void) | undefined;
      const textDelivered = new Promise<void>((resolve) => {
        receivedText = resolve;
      });
      let providerEnded = false;
      const route = path.replace(/\/$/, "");
      const item = {
        id: "msg_local",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Your project is ready.", annotations: [] }],
      };
      const server = createServer(async (req, res) => {
        requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
        if (req.url !== route) {
          res.writeHead(404).end();
          return;
        }
        let body = "";
        for await (const part of req) body += String(part);
        requestBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          anthropicChunk({ type: "response.created", response: { id: "resp_local" } }) +
            anthropicChunk({
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, status: "in_progress", content: [] },
            }) +
            anthropicChunk({
              type: "response.content_part.added",
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            }) +
            anthropicChunk({
              type: "response.output_text.delta",
              output_index: 0,
              content_index: 0,
              delta: "Your project is ready.",
            })
        );
        await textDelivered;
        providerEnded = true;
        res.end(
          anthropicChunk({ type: "response.output_item.done", output_index: 0, item }) +
            anthropicChunk({
              type: "response.completed",
              response: {
                id: "resp_local",
                status: "completed",
                output: [item],
                usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
              },
            })
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const config = Object.freeze({
        ...input.model_config,
        provider: "anthropic" as const,
        model: "private-response-model",
        base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
        supports_reasoning: true,
      });
      try {
        const model = createChatModel(config);
        expect(model).toMatchObject({ api: "openai-responses", provider: "openai", id: config.model });
        expect(model.compat).toBeUndefined();
        await runAiChat(
          { ...input, model_config: config },
          "http://api:8000",
          async (event) => {
            if (event.type === "text") {
              expect(providerEnded).toBe(false);
              receivedText?.();
            }
            await h.emit(event);
          },
          new AbortController().signal,
          { ...h.dependencies, runMs: 2000, createAgent: (options) => new Agent(options) }
        );
        expect(requests).toEqual([{ method: "POST", path: route, authorization: "Bearer model-secret" }]);
        expect(requestBody).toMatchObject({
          model: config.model,
          stream: true,
          max_output_tokens: 16_384,
          reasoning: { effort: "low" },
          input: expect.any(Array),
        });
        expect(requestBody).not.toHaveProperty("max_tokens");
        expect(requestBody).not.toHaveProperty("messages");
        expect(config.base_url).toBe(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
        expect(h.events).toEqual([
          { type: "text", text: "Your project is ready." },
          { type: "done", reason: "complete" },
        ]);
      } finally {
        receivedText?.();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );

  it.each([404, 500])("does not retry or probe another endpoint after HTTP %s", async (status) => {
    const h = harness();
    const requests: { method: string | undefined; path: string | undefined; model: unknown }[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const part of req) body += String(part);
      requests.push({ method: req.method, path: req.url, model: JSON.parse(body).model });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unavailable" } }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const config = Object.freeze({
      ...input.model_config,
      base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });
    try {
      await runAiChat({ ...input, model_config: config }, "http://api:8000", h.emit, new AbortController().signal, {
        ...h.dependencies,
        runMs: 2000,
        createAgent: (options) => new Agent(options),
      });
      expect(requests).toEqual([{ method: "POST", path: "/v1/chat/completions", model: input.model_config.model }]);
      expect(config.base_url).toBe(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      expect(h.events.at(-2)).toMatchObject({ type: "error", code: "ai_model_error" });
      expect(h.events.at(-1)).toEqual({ type: "done", reason: "error" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reconstructs text-only history without accepting browser tools or system messages", async () => {
    const h = harness();
    await runAiChat(
      {
        ...input,
        messages: [
          { role: "user", content: "earlier" },
          { role: "assistant", content: "answer" },
          { role: "user", content: "now" },
        ],
      },
      "http://api:8000",
      h.emit,
      new AbortController().signal,
      h.dependencies
    );
    const messages = h.dependencies.createAgent.mock.calls[0][0].initialState?.messages;
    expect(messages?.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(h.agent.prompt).toHaveBeenCalledWith("now");
  });

  it("sanitizes unexpected provider/startup failures and still emits done", async () => {
    const h = harness(async () => {
      throw new Error("Authorization model-secret plane_api_test-secret");
    });
    await runAiChat(input, "http://api:8000", h.emit, new AbortController().signal, h.dependencies);
    expect(h.events.at(-1)).toEqual({ type: "done", reason: "error" });
    expect(h.events[0]).toMatchObject({ type: "error", code: "ai_model_error", may_have_changes: false });
    expect(JSON.stringify(h.events)).not.toContain("secret");
    expect(h.connection.close).toHaveBeenCalledOnce();
  });

  it.each([
    { action: "create", project_id: input.project_id, changed: true, calls: 1 },
    { action: "update", project_id: input.project_id, changed: true, calls: 1 },
    { action: "manage_assignee", project_id: input.project_id, changed: true, calls: 1 },
    { action: "list", project_id: input.project_id, changed: false, calls: 1 },
    { action: "create", project_id: "invalid-id", changed: false, calls: 0 },
    { action: "delete", project_id: input.project_id, changed: false, calls: 0 },
  ])(
    "tracks actual wrapper dispatch after validation: $action / $project_id",
    async ({ action, project_id, changed, calls }) => {
      const h = harness();
      let modelCalls = 0;
      const createAgent = (options: AgentOptions) =>
        new Agent({
          ...options,
          streamFn: (model) => {
            if (modelCalls++ > 0) throw new Error("private-provider-url model-secret");
            const message: AssistantMessage = {
              role: "assistant",
              api: model.api,
              provider: model.provider,
              model: model.id,
              timestamp: Date.now(),
              stopReason: "toolUse",
              content: [{ type: "toolCall", id: "write-1", name: "workitem", arguments: { action, project_id } }],
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            };
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: "toolUse", message });
            return stream;
          },
        });
      await runAiChat(input, "http://api:8000", h.emit, new AbortController().signal, {
        ...h.dependencies,
        createAgent,
      });
      expect(h.connection.client.callTool).toHaveBeenCalledTimes(calls);
      expect(h.events.at(-2)).toEqual({
        type: "error",
        code: "ai_model_error",
        may_have_changes: changed,
        message: "The model could not complete this request. Check your personal AI settings and try again.",
      });
      expect(h.events.at(-1)).toEqual({ type: "done", reason: "error" });
      expect(JSON.stringify(h.events)).not.toMatch(/private-provider-url|model-secret/);
    }
  );

  it.each(["missing-executable", "mcp-connect", "unsupported-catalogue"])(
    "reports unavailable tools without claiming changes: %s",
    async (failure) => {
      const h = harness();
      if (failure === "unsupported-catalogue") h.connection.tools = [];
      else h.dependencies.connectMcp.mockRejectedValue(new Error(`${failure} private-url model-secret`));
      await runAiChat(input, "http://api:8000", h.emit, new AbortController().signal, h.dependencies);
      expect(h.events).toEqual([
        {
          type: "error",
          code: "ai_tools_unavailable",
          may_have_changes: false,
          message: "Plane tools are unavailable. Please try again later.",
        },
        { type: "done", reason: "error" },
      ]);
      expect(h.dependencies.createAgent).not.toHaveBeenCalled();
    }
  );

  it("does not treat provider mutation announcements as actual calls", async () => {
    const h = harness(async (event) => {
      await event({
        type: "tool_execution_start",
        toolCallId: "fake",
        toolName: "workitem",
        args: { action: "create" },
      });
      throw new Error("provider failure");
    });
    await runAiChat(input, "http://api:8000", h.emit, new AbortController().signal, h.dependencies);
    expect(h.events.at(-2)).toMatchObject({ code: "ai_model_error", may_have_changes: false });
    expect(h.connection.client.callTool).not.toHaveBeenCalled();
  });

  it("bounds hanging providers by elapsed time and discards late output", async () => {
    vi.useFakeTimers();
    let sendLate: ((event: AgentEvent) => Promise<void>) | undefined;
    const h = harness(async (event) => {
      sendLate = event;
      await new Promise(() => undefined);
    });
    const running = runAiChat(input, "http://api:8000", h.emit, new AbortController().signal, h.dependencies);
    await vi.advanceTimersByTimeAsync(120_001);
    await running;
    expect(h.agent.abort).toHaveBeenCalled();
    expect(h.connection.close).toHaveBeenCalledOnce();
    expect(h.events.at(-1)).toEqual({ type: "done", reason: "limit" });
    const count = h.events.length;
    await sendLate?.({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "text_delta", delta: "late", contentIndex: 0, partial: {} as never },
    });
    expect(h.events).toHaveLength(count);
  });

  it("cancels on disconnect without output and cleans the connection", async () => {
    const control = new AbortController();
    const h = harness(async () => {
      control.abort();
      await new Promise(() => undefined);
    });
    await runAiChat(input, "http://api:8000", h.emit, control.signal, h.dependencies);
    expect(h.agent.abort).toHaveBeenCalled();
    expect(h.connection.close).toHaveBeenCalledOnce();
    expect(h.events).toEqual([]);
  });

  it("stops after sixteen MCP calls and does not execute the seventeenth", async () => {
    const h = harness(async (_event, options) => {
      const tool = options.initialState!.tools![0];
      // eslint-disable-next-line no-await-in-loop -- model tool execution is deliberately sequential
      for (let index = 0; index < 17; index++) await tool.execute(`call-${index}`, { action: "list" });
    });
    await runAiChat(input, "http://api:8000", h.emit, new AbortController().signal, h.dependencies);
    expect(h.connection.client.callTool).toHaveBeenCalledTimes(16);
    expect(h.events.at(-1)).toEqual({ type: "done", reason: "limit" });
  });

  it.each([false, true])(
    "executes official MCP schemas through the real Pi agent loop (failure=%s)",
    async (failure) => {
      const h = harness();
      h.connection.client.callTool.mockResolvedValue({
        isError: failure,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              results: [
                {
                  id: input.user_id,
                  project: input.project_id,
                  name: `Task ${input.model_config.api_key} ${input.plane_api_token}`,
                  identifier: "TEAM-12",
                  headers: { Authorization: "untrusted-credential" },
                  metadata: { secret: "untrusted-credential" },
                },
              ],
            }),
          },
        ],
      });
      let modelCalls = 0;
      const createAgent = (options: AgentOptions) =>
        new Agent({
          ...options,
          streamFn: (model) => {
            const first = modelCalls++ === 0;
            const message: AssistantMessage = {
              role: "assistant",
              api: model.api,
              provider: model.provider,
              model: model.id,
              timestamp: Date.now(),
              content: first
                ? [{ type: "toolCall", id: "call-1", name: "workitem", arguments: { action: "list" } }]
                : [{ type: "text", text: "Found your tasks." }],
              stopReason: first ? "toolUse" : "stop",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            };
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "start", partial: message });
            if (!first)
              stream.push({ type: "text_delta", contentIndex: 0, delta: "Found your tasks.", partial: message });
            stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
            return stream;
          },
        });
      await runAiChat(input, "http://api:8000", h.emit, new AbortController().signal, {
        ...h.dependencies,
        createAgent,
      });
      expect(h.connection.client.callTool).toHaveBeenCalledOnce();
      expect(h.connection.client.callTool.mock.calls[0][0]).toEqual({
        name: "workitem",
        arguments: { action: "list", project_id: input.project_id },
      });
      expect(modelCalls).toBe(2);
      const completed = h.events.find((event) => event.type === "tool" && event.status !== "running");
      expect(completed).toMatchObject({
        status: failure ? "error" : "complete",
        details: failure
          ? {
              output:
                "Plane could not complete this operation. Check permissions and inputs; verify changes before retrying.",
            }
          : {
              workItems: [
                {
                  id: input.user_id,
                  projectId: input.project_id,
                  name: "Task [redacted] [redacted]",
                  identifier: "TEAM-12",
                },
              ],
            },
      });
      expect(JSON.stringify(h.events)).not.toMatch(
        /model-secret|plane_api_test-secret|untrusted-credential|Authorization/
      );
      expect(h.events).toContainEqual({ type: "text", text: "Found your tasks." });
      expect(h.events.at(-1)).toEqual({ type: "done", reason: "complete" });
    }
  );

  it.each([
    { action: "list", final: "empty" },
    { action: "create", final: "empty" },
    { action: "create", final: "thinking" },
    { action: "create", final: "answer" },
  ])("checks the final assistant message after $action with $final content", async ({ action, final }) => {
    const h = harness();
    let modelCalls = 0;
    let sawToolResult = false;
    const announcement = "I will check that. ";
    await runAiChat(input, "http://api:8000", h.emit, new AbortController().signal, {
      ...h.dependencies,
      createAgent: (options) =>
        new Agent({
          ...options,
          streamFn: (model, context) => {
            const first = modelCalls++ === 0;
            if (!first) sawToolResult = context.messages.some((message) => message.role === "toolResult");
            const finalContent: AssistantMessage["content"] =
              final === "answer"
                ? [{ type: "text", text: "Done." }]
                : final === "thinking"
                  ? [{ type: "thinking", thinking: "Checked." }]
                  : [];
            const message = assistantMessage(
              model,
              first
                ? [
                    { type: "text", text: announcement },
                    {
                      type: "toolCall",
                      id: "call-1",
                      name: "workitem",
                      arguments: { action, project_id: input.project_id },
                    },
                  ]
                : finalContent,
              first ? "toolUse" : "stop"
            );
            const stream = createAssistantMessageEventStream();
            if (first) {
              stream.push({ type: "start", partial: message });
              stream.push({ type: "text_delta", contentIndex: 0, delta: announcement, partial: message });
              stream.push({ type: "text_end", contentIndex: 0, content: announcement, partial: message });
            }
            // The second message has no deltas and reuses index 0 with shorter content.
            stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
            return stream;
          },
        }),
    });
    expect(modelCalls).toBe(2);
    expect(sawToolResult).toBe(true);
    expect(h.connection.client.callTool).toHaveBeenCalledOnce();
    expect(h.connection.client.callTool.mock.calls[0][0]).toEqual({
      name: "workitem",
      arguments: { action, project_id: input.project_id },
    });
    expect(h.events).toContainEqual(expect.objectContaining({ type: "tool", action, status: "complete" }));
    expect(h.events.filter((event) => event.type === "text")).toEqual([
      { type: "text", text: announcement },
      ...(final === "answer" ? [{ type: "text", text: "Done." }] : []),
    ]);
    if (final === "thinking") expect(h.events).toContainEqual({ type: "thinking", text: "Checked." });
    if (final === "answer") {
      expect(h.events.some((event) => event.type === "error")).toBe(false);
      expect(h.events.at(-1)).toEqual({ type: "done", reason: "complete" });
    } else {
      expect(h.events.at(-2)).toMatchObject({
        type: "error",
        code: "ai_empty_response",
        may_have_changes: action === "create",
      });
      expect(h.events.at(-1)).toEqual({ type: "done", reason: "error" });
    }
  });

  it.each(["none", "partial", "all"] as const)(
    "reconciles final assistant blocks without duplicating %s streamed text",
    async (deltas) => {
      const h = harness();
      const createAgent = (options: AgentOptions) =>
        new Agent({
          ...options,
          streamFn: (model) => {
            const message = assistantMessage(model, [
              { type: "thinking", thinking: "Checking model-secret. " },
              { type: "text", text: "Found model-secret." },
              { type: "text", text: " Done." },
            ]);
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "start", partial: message });
            if (deltas !== "none") {
              stream.push({ type: "thinking_delta", contentIndex: 0, delta: "Checking model-se", partial: message });
              stream.push({
                type: "text_delta",
                contentIndex: 1,
                delta: deltas === "all" ? "Found model-secret." : "Found model-se",
                partial: message,
              });
            }
            stream.push({ type: "text_end", contentIndex: 1, content: "Found model-secret.", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            return stream;
          },
        });
      await runAiChat(input, "http://api:8000", h.emit, new AbortController().signal, {
        ...h.dependencies,
        createAgent,
      });
      expect(
        h.events
          .filter((event) => event.type === "text")
          .map((event) => event.text)
          .join("")
      ).toBe("Found [redacted]. Done.");
      expect(
        h.events
          .filter((event) => event.type === "thinking")
          .map((event) => event.text)
          .join("")
      ).toBe("Checking [redacted]. ");
      expect(h.events.at(-1)).toEqual({ type: "done", reason: "complete" });
      expect(JSON.stringify(h.events)).not.toContain("model-secret");
    }
  );

  it.each([
    { stopReason: "stop", text: "", reason: "error", code: "ai_empty_response" },
    { stopReason: "stop", text: "  ", reason: "error", code: "ai_empty_response" },
    { stopReason: "length", text: "", reason: "limit", code: "ai_run_limit" },
    { stopReason: "length", text: "Partial answer", reason: "limit", code: "ai_run_limit" },
  ] as const)("reports $stopReason with '$text' as $code", async ({ stopReason, text, reason, code }) => {
    const h = harness();
    await runAiChat(input, "http://api:8000", h.emit, new AbortController().signal, {
      ...h.dependencies,
      createAgent: (options) =>
        new Agent({
          ...options,
          streamFn: (model) => {
            const message = assistantMessage(
              model,
              [
                { type: "thinking", thinking: "Checking the project." },
                { type: "text", text },
              ],
              stopReason
            );
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "done", reason: stopReason, message });
            return stream;
          },
        }),
    });
    expect(h.events).toContainEqual({ type: "thinking", text: "Checking the project." });
    if (text) expect(h.events).toContainEqual({ type: "text", text });
    expect(h.events.at(-2)).toMatchObject({ type: "error", code, may_have_changes: false });
    expect(h.events.at(-1)).toEqual({ type: "done", reason });
  });

  it("serializes slow stream writes before delivering done", async () => {
    const h = harness(async (event) => {
      for (const text of ["first", "second"]) {
        void event({
          type: "message_update",
          message: {} as never,
          assistantMessageEvent: { type: "text_delta", delta: text, contentIndex: 0, partial: {} as never },
        });
      }
    });
    let inFlight = 0;
    let maximum = 0;
    const delivered: string[] = [];
    await runAiChat(
      input,
      "http://api:8000",
      async (event) => {
        maximum = Math.max(maximum, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        delivered.push(event.type === "text" ? event.text : event.type);
        inFlight--;
      },
      new AbortController().signal,
      h.dependencies
    );
    expect(maximum).toBe(1);
    expect(delivered).toEqual(["first", "second", "done"]);
  });

  it("handles rejected output without unhandled subscriber promises", async () => {
    const h = harness(async (event) => {
      void event({
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: { type: "text_delta", delta: "hello", contentIndex: 0, partial: {} as never },
      });
    });
    const emit = vi.fn().mockRejectedValue(new Error("disconnected"));
    await runAiChat(input, "http://api:8000", emit, new AbortController().signal, h.dependencies);
    expect(emit).toHaveBeenCalledOnce();
    expect(h.agent.abort).toHaveBeenCalled();
    expect(h.connection.close).toHaveBeenCalledOnce();
  });

  it("forwards native thinking with independent incremental redaction and keeps generation off", async () => {
    const h = harness(async (event) => {
      for (const [type, delta] of [
        ["thinking_delta", "Plan model-se"],
        ["text_delta", "Answer "],
        ["thinking_delta", "cret plane_api_test-"],
        ["thinking_delta", "secret done"],
      ] as const) {
        // eslint-disable-next-line no-await-in-loop -- simulate ordered provider deltas
        await event({
          type: "message_update",
          message: {} as never,
          assistantMessageEvent: { type, delta, contentIndex: 0, partial: {} as never },
        });
      }
    });
    await runAiChat(input, "http://api:8000", h.emit, new AbortController().signal, h.dependencies);
    expect(
      h.events
        .filter((event) => event.type === "thinking")
        .map((event) => event.text)
        .join("")
    ).toBe("Plan [redacted] [redacted] done");
    expect(h.events).toContainEqual({ type: "text", text: "Answer " });
    expect(h.dependencies.createAgent.mock.calls[0][0].initialState?.thinkingLevel).toBe("off");
    expect(JSON.stringify(h.events)).not.toContain("secret");
  });

  it("bounds native thinking output", async () => {
    const h = harness(async (event) => {
      await event({
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: {
          type: "thinking_delta",
          delta: "x".repeat(100001),
          contentIndex: 0,
          partial: {} as never,
        },
      });
    });
    await runAiChat(input, "http://api:8000", h.emit, new AbortController().signal, h.dependencies);
    expect(h.events.some((event) => event.type === "thinking")).toBe(false);
    expect(h.events.at(-1)).toEqual({ type: "done", reason: "limit" });
  });

  it("stops excessive LLM turns", async () => {
    const h = harness(async (event) => {
      // eslint-disable-next-line no-await-in-loop -- simulate successive model turns
      for (let index = 0; index < 9; index++) await event({ type: "turn_start" });
    });
    await runAiChat(input, "http://api:8000", h.emit, new AbortController().signal, h.dependencies);
    expect(h.events.at(-1)).toEqual({ type: "done", reason: "limit" });
  });
});
