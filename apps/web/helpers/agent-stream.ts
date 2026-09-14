/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
export type AgentMessage = { role: "user" | "assistant"; content: string };
export type AgentWorkItem = { id: string; projectId: string; identifier?: string; name: string };
export type AgentToolDetails = {
  input?: string;
  output?: string;
  truncated?: boolean;
  workItems?: AgentWorkItem[];
};
export type AgentToolEvent = {
  type: "tool";
  name: string;
  status: "running" | "complete" | "error";
  id?: string;
  action?: string;
  details?: AgentToolDetails;
};

const invalid = () => new Error("Invalid assistant tool details");

function readToolDetails(value: unknown): AgentToolDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const fields = value as Record<string, unknown>;
  const details: AgentToolDetails = {};
  for (const key of ["input", "output"] as const) {
    if (fields[key] !== undefined) {
      if (typeof fields[key] !== "string" || fields[key].length > 6000) throw invalid();
      details[key] = fields[key];
    }
  }
  if (fields.truncated !== undefined) {
    if (typeof fields.truncated !== "boolean") throw invalid();
    details.truncated = fields.truncated;
  }
  if (fields.workItems !== undefined) {
    if (!Array.isArray(fields.workItems) || fields.workItems.length > 20) throw invalid();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    details.workItems = fields.workItems.map((item: unknown) => {
      if (!item || typeof item !== "object") throw invalid();
      const ref = item as Record<string, unknown>;
      if (
        typeof ref.id !== "string" ||
        !uuid.test(ref.id) ||
        typeof ref.projectId !== "string" ||
        !uuid.test(ref.projectId) ||
        typeof ref.name !== "string" ||
        ref.name.length > 500
      )
        throw invalid();
      if (
        ref.identifier !== undefined &&
        (typeof ref.identifier !== "string" ||
          ref.identifier.length > 150 ||
          !/^[a-z0-9_-]+-\d+$/i.test(ref.identifier))
      )
        throw invalid();
      const itemReference: AgentWorkItem = { id: ref.id, projectId: ref.projectId, name: ref.name };
      if (typeof ref.identifier === "string") itemReference.identifier = ref.identifier;
      return itemReference;
    });
  }
  return details;
}
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | AgentToolEvent
  | { type: "error"; message: string }
  | { type: "done"; reason?: string };

export async function readAgentStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const consume = (line: string) => {
    if (!line.trim() || completed) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error("Invalid assistant stream event");
    }
    if (!event || typeof event !== "object") throw new Error("Invalid assistant stream event");
    const frame = event as Record<string, unknown>;
    if ((frame.type === "text" || frame.type === "thinking") && typeof frame.text === "string") {
      onEvent({ type: frame.type, text: frame.text });
    } else if (frame.type === "tool" && typeof frame.name === "string") {
      const status = frame.status;
      if (status !== "running" && status !== "complete" && status !== "error")
        throw new Error("Invalid assistant stream event");
      onEvent({
        type: "tool",
        name: frame.name,
        status,
        ...(typeof frame.id === "string" ? { id: frame.id } : {}),
        ...(typeof frame.action === "string" ? { action: frame.action } : {}),
        ...(frame.details !== undefined ? { details: readToolDetails(frame.details) } : {}),
      });
    } else if (frame.type === "error" && typeof frame.message === "string") throw new Error(frame.message);
    else if (frame.type === "done") {
      if (frame.reason && frame.reason !== "complete")
        throw new Error("Assistant response interrupted before completion");
      completed = true;
      onEvent({ type: "done", ...(typeof frame.reason === "string" ? { reason: frame.reason } : {}) });
    } else throw new Error("Invalid assistant stream event");
  };
  try {
    // consume() sets completed when the server sends its final event.
    // eslint-disable-next-line no-unmodified-loop-condition
    while (!completed) {
      signal?.throwIfAborted();
      // Stream reads must remain sequential to preserve NDJSON and UTF-8 boundaries.
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (done) {
        consume(buffer);
        break;
      }
    }
    if (!completed) throw new Error("Assistant response interrupted before completion");
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
