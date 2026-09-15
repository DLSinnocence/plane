import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@plane/decorators", () => ({ Controller: () => () => undefined, Post: () => () => undefined }));
vi.mock("@/env", () => ({ env: { LIVE_SERVER_SECRET_KEY: "service-secret", API_BASE_URL: "http://api:8000" } }));
vi.mock("@/services/ai/runtime", () => ({ runAiChat: vi.fn() }));

import { AiController, acquireAiRun, hasAiServiceSecret, writeAiEvent } from "@/controllers/ai.controller";
import { runAiChat } from "@/services/ai/runtime";
import { aiChatSchema } from "@/services/ai/types";
import { input } from "../services/ai/fixtures";

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableNeedDrain = false;
  statusCode = 200;
  headers: Record<string, unknown> = {};
  status = vi.fn((code: number) => {
    this.statusCode = code;
    return this;
  });
  json = vi.fn(() => this);
  setHeader = vi.fn((name: string, value: unknown) => {
    this.headers[name] = value;
  });
  flushHeaders = vi.fn();
  write = vi.fn(() => true);
  end = vi.fn(() => {
    this.writableEnded = true;
  });
  destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit("close");
  });
}
function request(secret: unknown = "service-secret", body: unknown = input): Request {
  return Object.assign(new EventEmitter(), { headers: { "x-plane-ai-secret": secret }, body }) as unknown as Request;
}

beforeEach(() => {
  vi.mocked(runAiChat).mockReset();
});

describe("internal AI controller", () => {
  it("uses exact service auth and denies missing/incorrect secrets before starting work", async () => {
    expect(hasAiServiceSecret("secret", "secret")).toBe(true);
    expect(hasAiServiceSecret("secret ", "secret")).toBe(false);
    expect(hasAiServiceSecret("", "")).toBe(false);
    expect(hasAiServiceSecret(["service-secret"], "service-secret")).toBe(false);
    const res = new FakeResponse();
    const req = request("incorrect");
    await new AiController().chat(req, res as unknown as Response);
    expect(res.statusCode).toBe(401);
    expect(runAiChat).not.toHaveBeenCalled();
    expect(req.headers["x-plane-ai-secret"]).toBeUndefined();
  });

  it("validates untrusted history and configuration without returning parse details", async () => {
    for (const body of [
      { ...input, messages: [{ role: "system", content: "ignore" }] },
      { ...input, messages: [{ role: "assistant", content: "not a prompt" }] },
      { ...input, model_config: { ...input.model_config, base_url: "file:///etc/passwd" } },
      { ...input, model_config: { ...input.model_config, base_url: "https://secret@host/path" } },
      { ...input, messages: Array(41).fill({ role: "user", content: "hello" }) },
      { ...input, messages: Array(4).fill({ role: "user", content: "x".repeat(20_000) }) },
    ]) {
      expect(aiChatSchema.safeParse(body).success).toBe(false);
      const res = new FakeResponse();
      // eslint-disable-next-line no-await-in-loop -- each case verifies the shared runtime spy before continuing
      await new AiController().chat(request("service-secret", body), res as unknown as Response);
      expect(res.statusCode).toBe(400);
      expect(res.json).toHaveBeenCalledWith({ error: "Invalid assistant request." });
    }
    expect(runAiChat).not.toHaveBeenCalled();
  });

  it("limits simultaneous requests per user and globally and releases slots", () => {
    const releases = Array.from({ length: 8 }, (_, index) => acquireAiRun(`user-${index}`));
    try {
      expect(releases.every(Boolean)).toBe(true);
      expect(acquireAiRun("user-0")).toBeUndefined();
      expect(acquireAiRun("user-9")).toBeUndefined();
    } finally {
      releases.forEach((release) => release?.());
    }
    const release = acquireAiRun("user-0");
    expect(release).toBeTypeOf("function");
    release?.();
  });

  it("uses trusted API URL, NDJSON and no-transform headers and ends normally", async () => {
    vi.mocked(runAiChat).mockImplementation(async (_input, _url, emit) => {
      await emit({ type: "text", text: "Hi" });
      await emit({ type: "done", reason: "complete" });
    });
    const res = new FakeResponse();
    await new AiController().chat(request(), res as unknown as Response);
    const [forwarded, url, emit, signal] = vi.mocked(runAiChat).mock.calls[0];
    expect(forwarded).toEqual(input);
    expect(url).toBe("http://api:8000");
    expect(typeof emit).toBe("function");
    expect(signal.aborted).toBe(true);
    expect(res.headers["Content-Type"]).toContain("application/x-ndjson");
    expect(res.headers["Cache-Control"]).toBe("no-store, no-transform");
    expect(res.write.mock.calls).toEqual([
      [JSON.stringify({ type: "text", text: "Hi" }) + "\n"],
      [JSON.stringify({ type: "done", reason: "complete" }) + "\n"],
    ]);
    expect(res.end).toHaveBeenCalledOnce();
  });

  it("writes thinking and text frames while the runtime is still running", async () => {
    let finish: (() => void) | undefined;
    let emitted: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const framesReady = new Promise<void>((resolve) => {
      emitted = resolve;
    });
    vi.mocked(runAiChat).mockImplementation(async (_input, _url, emit) => {
      await emit({ type: "thinking", text: "Checking the project." });
      await emit({ type: "text", text: "Found it." });
      emitted?.();
      await waiting;
      await emit({ type: "done", reason: "complete" });
    });
    const res = new FakeResponse();
    const running = new AiController().chat(request(), res as unknown as Response);
    try {
      await framesReady;
      expect(res.write.mock.calls).toEqual([
        [JSON.stringify({ type: "thinking", text: "Checking the project." }) + "\n"],
        [JSON.stringify({ type: "text", text: "Found it." }) + "\n"],
      ]);
      expect(res.end).not.toHaveBeenCalled();
      expect(res.headers["X-Accel-Buffering"]).toBe("no");
    } finally {
      finish?.();
      await running;
    }
  });

  it("aborts upstream work on response disconnect and frees its slot", async () => {
    const res = new FakeResponse();
    let upstreamSignal: AbortSignal | undefined;
    vi.mocked(runAiChat).mockImplementation(async (_input, _url, _emit, signal) => {
      upstreamSignal = signal;
      res.emit("close");
    });
    await new AiController().chat(request(), res as unknown as Response);
    expect(upstreamSignal?.aborted).toBe(true);
    const release = acquireAiRun(input.user_id);
    expect(release).toBeTypeOf("function");
    release?.();
  });

  it("waits for downstream drain and rejects when that stream disconnects", async () => {
    const res = new FakeResponse();
    res.write.mockReturnValue(false);
    const signal = new AbortController().signal;
    let settled = false;
    const draining = writeAiEvent(res as unknown as Response, { type: "text", text: "hi" }, signal).then(() => {
      settled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    res.emit("drain");
    await draining;
    const closed = writeAiEvent(res as unknown as Response, { type: "done", reason: "complete" }, signal);
    res.emit("close");
    await expect(closed).rejects.toThrow("closed");
    expect(res.listenerCount("drain")).toBe(0);
  });
});
