import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { Controller, Post } from "@plane/decorators";
import { env } from "@/env";
import { runAiChat } from "@/services/ai/runtime";
import { AI_LIMITS, aiChatSchema } from "@/services/ai/types";
import type { AiStreamEvent } from "@/services/ai/types";

const activeUsers = new Set<string>();

export function hasAiServiceSecret(received: unknown, expected: string): boolean {
  if (!expected || typeof received !== "string" || received.length > 4096) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}

export function acquireAiRun(userId: string): (() => void) | undefined {
  if (activeUsers.has(userId) || activeUsers.size >= AI_LIMITS.concurrentRuns) return;
  activeUsers.add(userId);
  return () => {
    activeUsers.delete(userId);
  };
}

export async function writeAiEvent(res: Response, event: AiStreamEvent, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (res.destroyed || res.writableEnded) throw new Error("Stream closed.");
  if (res.write(`${JSON.stringify(event)}\n`)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      res.off("drain", onDrain);
      res.off("close", onClose);
      signal.removeEventListener("abort", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Stream closed."));
    };
    const timer = setTimeout(onClose, 10_000);
    timer.unref();
    res.once("drain", onDrain);
    res.once("close", onClose);
    signal.addEventListener("abort", onClose, { once: true });
    if (signal.aborted || res.destroyed) onClose();
  });
}

@Controller("/ai")
export class AiController {
  @Post("/chat")
  async chat(req: Request, res: Response): Promise<void> {
    // Authentication before any configuration is used. Never include headers,
    // body, upstream errors or credentials in application logs.
    const authorized = hasAiServiceSecret(req.headers["x-plane-ai-secret"], env.LIVE_SERVER_SECRET_KEY);
    delete req.headers["x-plane-ai-secret"];
    if (!authorized) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    const parsed = aiChatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid assistant request." });
      return;
    }
    const release = acquireAiRun(parsed.data.user_id);
    if (!release) {
      res.setHeader("Retry-After", "5");
      res.status(429).json({ error: "An assistant request is already running or the service is busy." });
      return;
    }
    const control = new AbortController();
    const onClose = () => control.abort();
    req.once("aborted", onClose);
    res.once("close", onClose);
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    // compression's standard filter respects no-transform; avoid token buffering.
    res.setHeader("Cache-Control", "no-store, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.flushHeaders();
    // Empty lines are NDJSON whitespace, not user-visible events. They keep the
    // Django upstream read alive while the provider or a tool is working.
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write("\n");
    }, 5_000);
    heartbeat.unref();
    try {
      await runAiChat(
        parsed.data,
        env.API_BASE_URL,
        (event) => writeAiEvent(res, event, control.signal),
        control.signal
      );
    } catch {
      // A failed output write means the client is gone or cannot drain. Never
      // feed a raw exception to the shared logger or retry an operation.
      control.abort();
      res.destroy();
    } finally {
      clearInterval(heartbeat);
      control.abort();
      req.off("aborted", onClose);
      res.off("close", onClose);
      release();
      if (!res.destroyed && !res.writableEnded) res.end();
    }
  }
}
