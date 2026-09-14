import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent, AgentOptions } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
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
    expect(h.events[0]).toMatchObject({ type: "error", code: "agent_failed" });
    expect(JSON.stringify(h.events)).not.toContain("secret");
    expect(h.connection.close).toHaveBeenCalledOnce();
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
