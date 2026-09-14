import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { omitAiRequestLogs, sanitizeAiBodyErrors } from "@/lib/ai-logging";

describe("AI request privacy", () => {
  it("omits private requests including parser failures while preserving normal logs", async () => {
    const app = express();
    const logged = vi.fn();
    app.use(
      omitAiRequestLogs((req, _res, next) => {
        logged(req.path);
        next();
      }, "/live")
    );
    app.use(express.json());
    app.use(sanitizeAiBodyErrors("/live"));
    app.post("/live/ai/chat", (_req, res) => {
      res.json({ ok: true });
    });
    app.get("/health", (_req, res) => {
      res.json({ ok: true });
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const failed = await fetch(`${url}/live/ai/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-plane-ai-secret": "private-service-key" },
        body: '{"api_key":"private-model-key',
      });
      expect(failed.status).toBe(400);
      expect(await failed.json()).toEqual({ error: "Invalid assistant request." });
      const success = await fetch(`${url}/live/ai/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"api_key":"private-model-key"}',
      });
      expect(success.status).toBe(200);
      expect(logged).not.toHaveBeenCalled();
      await fetch(`${url}/health`);
      expect(logged).toHaveBeenCalledExactlyOnceWith("/health");
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
});
