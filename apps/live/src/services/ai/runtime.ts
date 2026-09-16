import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentOptions, AgentMessage } from "@mariozechner/pi-agent-core";
import { clampThinkingLevel, getModels, getProviders, streamSimple } from "@mariozechner/pi-ai";
import type { Api, ImageContent, Model, TextContent } from "@mariozechner/pi-ai";
import { connectPlaneMcp } from "./mcp";
import type { AiMcpConnection } from "./mcp";
import { CE_ACTIONS, createCeTools, createTextRedactor } from "./tools";
import { AI_LIMITS } from "./types";
import type { AiChatInput, AiDoneReason, AiEmit, AiStreamEvent, AiToolDetails } from "./types";
import { TOOL_FAILURE_OUTPUT } from "./details";
import { resolveAiEndpoint } from "./endpoint";
import { createSystemPrompt } from "./prompts";
import { createSkillTool, SKILL_FAILURE_OUTPUT } from "./skills";

function reasoningLevelMap(config: AiChatInput["model_config"]): Model<Api>["thinkingLevelMap"] {
  // Match exact IDs only. A gateway's OpenAI transport does not identify its model vendor.
  const candidates = getProviders().flatMap((provider) =>
    getModels(provider).filter((model) => model.id === config.model || `${provider}/${model.id}` === config.model)
  );
  const origin = new URL(config.base_url).origin;
  const native = candidates.filter((model) => URL.canParse(model.baseUrl) && new URL(model.baseUrl).origin === origin);
  const namespaced = candidates.filter((model) => `${model.provider}/${model.id}` === config.model);
  const matches = native.length ? native : namespaced.length ? namespaced : candidates;
  const map = matches[0]?.thinkingLevelMap;
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
  // Unknown/ambiguous gateway IDs keep the existing fallback, without guessing metadata.
  return matches.every((model) => levels.every((level) => model.thinkingLevelMap?.[level] === map?.[level]))
    ? map
    : undefined;
}

export function createChatModel(config: AiChatInput["model_config"]): Model<Api> {
  const endpoint = resolveAiEndpoint(config.base_url, config.provider);
  return {
    id: config.model,
    name: config.model,
    ...endpoint,
    reasoning: config.supports_reasoning === true,
    thinkingLevelMap: config.supports_reasoning ? reasoningLevelMap(config) : undefined,
    input: config.supports_images ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    // Reasoning and visible answers share the completion budget on many models.
    maxTokens: config.supports_reasoning ? 16_384 : 4096,
    compat:
      endpoint.api === "openai-completions"
        ? {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: config.supports_reasoning ? undefined : false,
            supportsStrictMode: false,
            maxTokensField:
              config.supports_reasoning && new URL(config.base_url).hostname === "api.openai.com"
                ? "max_completion_tokens"
                : "max_tokens",
          }
        : endpoint.api === "anthropic-messages"
          ? { supportsEagerToolInputStreaming: false }
          : undefined,
  };
}

export function userMessageContent(message: AiChatInput["messages"][number]): string | (TextContent | ImageContent)[] {
  if (!message.images?.length) return message.content;
  return [
    ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
    ...message.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mime_type })),
  ];
}

function historyMessages(input: AiChatInput, model: Model<Api>): AgentMessage[] {
  return input.messages.slice(0, -1).map((message) =>
    message.role === "user"
      ? {
          role: "user",
          content: userMessageContent(message),
          timestamp: Date.now(),
        }
      : {
          role: "assistant",
          content: [{ type: "text", text: message.content }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: "stop",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }
  );
}

export interface AiRuntimeDependencies {
  createAgent: (options: AgentOptions) => Agent;
  connectMcp: typeof connectPlaneMcp;
  idleMs: number;
}
const defaults: AiRuntimeDependencies = {
  createAgent: (options) => new Agent(options),
  connectMcp: connectPlaneMcp,
  idleMs: AI_LIMITS.idleMs,
};

// A request owns all context and credentials. Nothing is written to disk or a
// shared conversation store; the next request receives only browser text history.
export async function runAiChat(
  input: AiChatInput,
  apiBaseUrl: string,
  emit: AiEmit,
  externalSignal: AbortSignal,
  dependencies: AiRuntimeDependencies = defaults
): Promise<void> {
  const control = new AbortController();
  const outcome: { reason: AiDoneReason } = { reason: "complete" };
  let connection: AiMcpConnection | undefined;
  let agent: Agent | undefined;
  let unsubscribe: (() => void) | undefined;
  let active = true;
  let outputChars = 0;
  let hasAnswerText = false;
  // SDK final messages can contain blocks not accompanied by delta events.
  // Count raw characters per block before redaction to avoid replaying deltas.
  const streamedChars = new Map<number, number>();
  let mayHaveChanges = false;
  let errorCode = "ai_tools_unavailable";
  const toolEvents = new Map<string, { name: string; action: string }>();
  const browserToolIds = new Map<string, string>();
  const verifiedDetails = new Map<string, { name: string; details: AiToolDetails }>();
  const secrets = [input.model_config.api_key, input.plane_api_token];
  const textRedactor = createTextRedactor(secrets);
  const thinkingRedactor = createTextRedactor(secrets);
  const abort = (why: AiDoneReason) => {
    if (control.signal.aborted) return;
    outcome.reason = why;
    control.abort();
    agent?.abort();
  };
  let outputQueue = Promise.resolve();
  let outputFailed = false;
  const queueEvent = (event: AiStreamEvent) => {
    // Pi invokes subscribers synchronously; it does not await async callbacks.
    outputQueue = outputQueue
      .then(async () => {
        if (!outputFailed && !externalSignal.aborted) await emit(event);
        return undefined;
      })
      .catch(() => {
        outputFailed = true;
        abort("error");
      });
  };
  const streamContent = (type: "text" | "thinking", value: string, contentIndex: number, complete = false) => {
    const seen = streamedChars.get(contentIndex) ?? 0;
    const fresh = complete ? value.slice(seen) : value;
    streamedChars.set(contentIndex, seen + fresh.length);
    if (!fresh) return;
    const delta = (type === "text" ? textRedactor : thinkingRedactor).push(fresh);
    outputChars += delta.length;
    if (outputChars > AI_LIMITS.outputChars) {
      errorCode = "ai_output_limit";
      abort("limit");
      return;
    }
    if (type === "text" && fresh.trim()) hasAnswerText = true;
    if (delta) queueEvent({ type, text: delta });
  };
  const onDisconnect = () => abort("cancelled");
  externalSignal.addEventListener("abort", onDisconnect, { once: true });
  if (externalSignal.aborted) onDisconnect();
  const timer = setTimeout(() => {
    errorCode = "ai_idle_timeout";
    abort("error");
  }, dependencies.idleMs);
  timer.unref();
  let rejectAborted: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(new Error("Run stopped."));
    control.signal.addEventListener("abort", rejectAborted, { once: true });
  });
  // Avoid an unhandled rejection if cancellation precedes the race below.
  void aborted.catch(() => undefined);

  try {
    control.signal.throwIfAborted();
    const work = (async () => {
      connection = await dependencies.connectMcp(input, apiBaseUrl, control.signal);
      if (control.signal.aborted) {
        await connection.close();
        control.signal.throwIfAborted();
      }
      const model = createChatModel(input.model_config);
      const takeCall = () => control.signal.throwIfAborted();
      const recordDetails = (id: string, name: string, details: AiToolDetails) => {
        if (active && !control.signal.aborted) verifiedDetails.set(id, { name, details });
      };
      const tools = createCeTools(
        connection.tools,
        connection.client,
        input.project_id,
        secrets,
        takeCall,
        recordDetails,
        () => {
          mayHaveChanges = true;
        }
      );
      if (!tools.length) throw new Error("Tools unavailable.");
      tools.push(createSkillTool(takeCall, recordDetails));
      errorCode = "ai_model_error";
      agent = dependencies.createAgent({
        initialState: {
          model,
          tools,
          messages: historyMessages(input, model),
          thinkingLevel: model.reasoning ? clampThinkingLevel(model, "low") : "off",
          systemPrompt: createSystemPrompt(input),
        },
        toolExecution: "sequential",
        getApiKey: () => input.model_config.api_key,
        streamFn: (selectedModel, context, options) =>
          streamSimple(selectedModel, context, {
            ...options,
            apiKey: input.model_config.api_key,
            signal: control.signal,
            maxTokens: selectedModel.maxTokens,
            maxRetries: 0,
            timeoutMs: 60_000,
            maxRetryDelayMs: 1000,
            cacheRetention: "none",
          }),
      });
      unsubscribe = agent.subscribe((event) => {
        if (!active || control.signal.aborted) return;
        timer.refresh();
        if (event.type === "message_start" && event.message.role === "assistant") {
          streamedChars.clear();
          // Tool announcements in earlier turns are not a final answer.
          hasAnswerText = false;
        }
        if (event.type === "message_update") {
          const update = event.assistantMessageEvent;
          if (update.type === "text_delta" || update.type === "thinking_delta") {
            streamContent(update.type === "text_delta" ? "text" : "thinking", update.delta, update.contentIndex);
          } else if (update.type === "text_end" || update.type === "thinking_end") {
            streamContent(update.type === "text_end" ? "text" : "thinking", update.content, update.contentIndex, true);
          }
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          for (const [index, content] of event.message.content.entries()) {
            if (control.signal.aborted) break;
            if (content.type === "text") streamContent("text", content.text, index, true);
            if (content.type === "thinking") streamContent("thinking", content.thinking, index, true);
          }
          if (!control.signal.aborted && event.message.stopReason === "length") {
            errorCode = "ai_model_output_limit";
            abort("limit");
          }
          if (event.message.stopReason === "error" || event.message.stopReason === "aborted") outcome.reason = "error";
        }
        if (event.type === "tool_execution_start") {
          const action = typeof event.args?.action === "string" ? event.args.action : "";
          const allowed = event.toolName === "skill" ? action === "load" : CE_ACTIONS[event.toolName]?.includes(action);
          if (!allowed) return;
          // Use an application-generated ID: provider tool-call IDs are untrusted.
          const id = `tool-${toolEvents.size + 1}`;
          verifiedDetails.delete(event.toolCallId);
          toolEvents.set(event.toolCallId, { name: event.toolName, action });
          browserToolIds.set(event.toolCallId, id);
          queueEvent({ type: "tool", id, name: event.toolName, action, status: "running" });
        }
        if (event.type === "tool_execution_end") {
          const info = toolEvents.get(event.toolCallId);
          const id = browserToolIds.get(event.toolCallId);
          const verified = verifiedDetails.get(event.toolCallId);
          verifiedDetails.delete(event.toolCallId);
          if (info && id) {
            const details = event.isError
              ? { output: info.name === "skill" ? SKILL_FAILURE_OUTPUT : TOOL_FAILURE_OUTPUT }
              : verified?.name === info.name && event.toolName === info.name
                ? verified.details
                : undefined;
            queueEvent({
              type: "tool",
              id,
              ...info,
              status: event.isError ? "error" : "complete",
              ...(details ? { details } : {}),
            });
          }
        }
        // Pi converts thrown provider failures into agent_end without message_end.
        if (
          event.type === "agent_end" &&
          event.messages.some((message) => message.role === "assistant" && message.stopReason === "error")
        )
          outcome.reason = "error";
      });
      control.signal.throwIfAborted();
      const latest = input.messages.at(-1)!;
      if (latest.images?.length) {
        await agent.prompt({ role: "user", content: userMessageContent(latest), timestamp: Date.now() });
      } else {
        await agent.prompt(latest.content);
      }
    })();
    // abort() is propagated to provider + MCP. This race also bounds a stalled
    // adapter; inactive guards stop any late event from writing to the response.
    await Promise.race([work, aborted]);
  } catch {
    if (!control.signal.aborted) outcome.reason = "error";
  } finally {
    active = false;
    clearTimeout(timer);
    externalSignal.removeEventListener("abort", onDisconnect);
    if (rejectAborted) control.signal.removeEventListener("abort", rejectAborted);
    unsubscribe?.();
    control.abort();
    agent?.abort();
    await connection?.close();
    // Reset only settled agents; interrupted providers can settle later.
    if (agent && !agent.state.isStreaming) agent.reset();
  }
  await outputQueue;
  if (externalSignal.aborted || outputFailed) return;
  const thinkingTail = thinkingRedactor.finish();
  if (thinkingTail && outputChars + thinkingTail.length <= AI_LIMITS.outputChars) {
    outputChars += thinkingTail.length;
    await emit({ type: "thinking", text: thinkingTail });
  }
  const tail = textRedactor.finish();
  if (tail && outputChars + tail.length <= AI_LIMITS.outputChars) await emit({ type: "text", text: tail });
  if (outcome.reason === "complete" && !hasAnswerText) {
    outcome.reason = "error";
    errorCode = "ai_empty_response";
  }
  const { reason } = outcome;
  if (reason === "error" || reason === "limit") {
    await emit({
      type: "error",
      code: errorCode,
      may_have_changes: mayHaveChanges,
      message:
        errorCode === "ai_idle_timeout"
          ? "The assistant stopped because the model or tool did not respond for too long. Please try again."
          : errorCode === "ai_model_output_limit"
            ? "The model reached its response length limit before finishing. You can continue the conversation."
            : errorCode === "ai_output_limit"
              ? "The response is too large to display in one request. Ask to continue with a shorter answer."
              : errorCode === "ai_tools_unavailable"
                ? "Plane tools are unavailable. Please try again later."
                : errorCode === "ai_empty_response"
                  ? "The model finished without an answer. Try again or choose another model in your personal AI settings."
                  : "The model could not complete this request. Check your personal AI settings and try again.",
    });
  }
  await emit({ type: "done", reason });
}
