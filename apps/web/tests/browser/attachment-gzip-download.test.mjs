// Copyright (c) 2023-present Plane Software, Inc. and contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Upload and download fixtures sequentially so a shared page's download events cannot race.
/* eslint-disable no-await-in-loop */

/**
 * Isolated Chromium transport contract: browser gzip -> multipart object upload ->
 * API redirect -> S3-shaped response -> browser download / fetch preview.
 *
 * Run: node --test apps/web/tests/browser/attachment-gzip-download.test.mjs
 * Needs Playwright plus its Chromium browser installed. For a provisioned runtime:
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs
 * CHROMIUM_PATH=/absolute/path/to/chrome node --test <this-file>
 *
 * No Plane, S3, credentials, or production network requests are used. The local
 * stub stores POST metadata and bytes; it does NOT validate AWS signatures or
 * replace a real MinIO/S3 integration test. PSD is a minimal RGB image, ZIP is a
 * valid empty archive, GZ is a real original gzip; MP4 is a synthetic byte fixture
 * with an ftyp box, NOT a playable-video/codec test. Temporary files are removed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const payload = Buffer.concat([Buffer.from("Binary 原始内容\0".repeat(1000)), Buffer.from([0, 255, 128, 1])]);
const originalGzip = gzipSync(payload);
const fixtures = [
  {
    id: "psd",
    name: "设计稿 原始.psd",
    type: "image/vnd.adobe.photoshop",
    // 1x1 RGB PSD: header, empty color/resources/layer sections, raw red pixel.
    body: Buffer.from("38425053000100000000000000030000000100000001000800030000000000000000000000000000ff0000", "hex"),
  },
  {
    id: "zip",
    name: "项目 原始.zip",
    type: "application/zip",
    body: Buffer.from("504b0506000000000000000000000000000000000000", "hex"),
  },
  { id: "gz", name: "备份 原始.gz", type: "application/gzip", body: originalGzip },
  { id: "xgzip", name: "旧式 原始.gz", type: "application/x-gzip", body: originalGzip },
  { id: "gzoctet", name: "二进制 原始.gz", type: "application/octet-stream", body: originalGzip },
  {
    id: "mp4",
    name: "视频 原始.mp4",
    type: "video/mp4",
    body: Buffer.concat([Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex"), payload]),
  },
];

const contentDisposition = (name) => `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
const objectPath = (fixture) => `/objects/${fixture.id}/${encodeURIComponent(fixture.name)}`;

test("Chromium preserves gzip attachment bytes and Unicode names through redirect", { timeout: 60_000 }, async (t) => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "@playwright/test");
  const uploaded = new Map();
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      requests.push({
        path: url.pathname,
        range: request.headers.range,
        acceptEncoding: request.headers["accept-encoding"],
      });
      if (url.pathname === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return response.end("<!doctype html><title>Isolated gzip attachment verification</title>");
      }
      if (url.pathname === "/fixtures") {
        response.writeHead(200, { "Content-Type": "application/json" });
        return response.end(
          JSON.stringify(fixtures.map(({ body, ...fixture }) => ({ ...fixture, base64: body.toString("base64") })))
        );
      }
      const id = url.pathname.split("/")[2];
      const fixture = fixtures.find((candidate) => candidate.id === id);
      if (!fixture) {
        response.writeHead(404);
        return response.end();
      }
      if (request.method === "POST" && url.pathname.startsWith("/upload/")) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const form = await new Request("http://127.0.0.1/upload", {
          method: "POST",
          headers: request.headers,
          body: Buffer.concat(chunks),
        }).formData();
        assert.equal(form.get("Content-Type"), fixture.type);
        assert.equal(form.get("Content-Encoding"), "gzip");
        assert.equal(form.get("Content-Disposition"), contentDisposition(fixture.name));
        assert.equal(form.get("file").name, fixture.name);
        const bytes = Buffer.from(await form.get("file").arrayBuffer());
        assert.deepEqual(gunzipSync(bytes), fixture.body);
        uploaded.set(id, {
          bytes,
          type: form.get("Content-Type"),
          encoding: form.get("Content-Encoding"),
          disposition: form.get("Content-Disposition"),
        });
        response.writeHead(204);
        return response.end();
      }
      if (url.pathname.startsWith("/download/")) {
        response.writeHead(302, { Location: objectPath(fixture) + url.search });
        return response.end();
      }
      if (url.pathname.startsWith("/objects/")) {
        const stored = uploaded.get(id);
        let bytes = stored.bytes;
        const headers = {
          "Content-Type": stored.type,
          "Content-Encoding": stored.encoding,
          "Content-Disposition": stored.disposition,
          "Content-Length": bytes.length,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        };
        if (url.searchParams.has("missingEncoding")) delete headers["Content-Encoding"];
        if (url.searchParams.has("range") && request.headers.range) {
          // S3 byte ranges address the STORED gzip bytes, not decoded media bytes.
          bytes = bytes.subarray(0, 50);
          headers["Content-Range"] = `bytes 0-${bytes.length - 1}/${stored.bytes.length}`;
          headers["Content-Length"] = bytes.length;
          response.writeHead(206, headers);
        } else response.writeHead(200, headers);
        return response.end(bytes);
      }
      response.writeHead(404);
      return response.end();
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const output = await mkdtemp(join(tmpdir(), "plane-attachment-gzip-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  t.after(() => browser.close());
  t.diagnostic(`Browser version: ${browser.version()}`);
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const sourceFixtures = await (await fetch("/fixtures")).json();
    for (const fixture of sourceFixtures) {
      const original = Uint8Array.from(atob(fixture.base64), (character) => character.charCodeAt(0));
      const compressed = await new Response(
        new Blob([original]).stream().pipeThrough(new CompressionStream("gzip"))
      ).blob();
      const form = new FormData();
      // These are S3 POST form fields, NOT the multipart HTTP request's headers.
      form.append("Content-Type", fixture.type);
      form.append("Content-Encoding", "gzip");
      form.append("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fixture.name)}`);
      form.append("file", compressed, fixture.name);
      const response = await fetch(`/upload/${fixture.id}`, { method: "POST", body: form });
      if (response.status !== 204) throw new Error(await response.text());
    }
  });

  for (const fixture of fixtures) {
    await t.test(`${fixture.type}: ${fixture.name}`, async () => {
      const downloadPromise = page.waitForEvent("download");
      await page.evaluate((id) => {
        const anchor = document.createElement("a");
        anchor.href = `/download/${id}`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }, fixture.id);
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), fixture.name);
      const destination = join(output, fixture.name);
      await download.saveAs(destination);
      assert.equal(await download.failure(), null);
      assert.deepEqual(await readFile(destination), fixture.body);

      const preview = await page.evaluate(async (id) => {
        const response = await fetch(`/download/${id}`);
        const blob = await response.blob();
        const bytes = await blob.arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return {
          status: response.status,
          type: blob.type,
          size: blob.size,
          hash: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
          encoding: response.headers.get("Content-Encoding"),
          contentLength: Number(response.headers.get("Content-Length")),
        };
      }, fixture.id);
      assert.equal(preview.status, 200);
      assert.equal(preview.type, fixture.type);
      assert.equal(preview.size, fixture.body.length);
      assert.equal(preview.hash, sha256(fixture.body));
      // Headers still describe the wire encoding even though fetch has decoded it.
      assert.equal(preview.encoding, "gzip");
      assert.equal(preview.contentLength, uploaded.get(fixture.id).bytes.length);
      t.diagnostic(
        `${fixture.id}: original=${fixture.body.length}, stored=${preview.contentLength}, sha256=${preview.hash}`
      );
    });
  }

  await t.test("missing Content-Encoding is NOT transparent (negative control)", async () => {
    const received = await page.evaluate(async () =>
      Array.from(new Uint8Array(await (await fetch("/download/psd?missingEncoding=1")).arrayBuffer()))
    );
    assert.deepEqual(Buffer.from(received), uploaded.get("psd").bytes);
    assert.notDeepEqual(Buffer.from(received), fixtures[0].body);
  });

  await t.test("partial ranges of stored gzip cannot serve decoded media ranges", async () => {
    const result = await page.evaluate(async () => {
      try {
        const response = await fetch("/objects/mp4/video.mp4?range=1", { headers: { Range: "bytes=0-49" } });
        await response.arrayBuffer();
        return { decoded: true };
      } catch (error) {
        return { decoded: false, error: String(error) };
      }
    });
    assert.equal(result.decoded, false, "Truncated gzip cannot be decoded as a complete media response");
    assert.ok(requests.some((request) => request.range === "bytes=0-49" && request.acceptEncoding === "identity"));
    t.diagnostic(`Encoded partial Range negative control: ${result.error}`);
  });
});
