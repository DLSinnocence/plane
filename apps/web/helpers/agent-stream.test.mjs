/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readAgentStream } from "./agent-stream.ts";
const encoder = new TextEncoder();
const stream = (parts) =>
  new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
test("delivers thinking and answer chunks while the connection remains open", async () => {
  let writer;
  let finished = false;
  const received = [];
  const next = new Map();
  const arrival = (type) => new Promise((resolve) => next.set(type, resolve));
  const thinking = arrival("thinking");
  const text = arrival("text");
  const pending = readAgentStream(
    new ReadableStream({
      start(controller) {
        writer = controller;
      },
    }),
    (event) => {
      received.push(event);
      next.get(event.type)?.();
    }
  ).then(() => {
    finished = true;
    return undefined;
  });
  writer.enqueue(encoder.encode('{"type":"thinking","text":"检查中"}\n'));
  await thinking;
  assert.equal(finished, false);
  writer.enqueue(encoder.encode('{"type":"text","text":"你好"}\n'));
  await text;
  assert.equal(finished, false);
  writer.enqueue(encoder.encode('{"type":"text","text":"，世界"}\n{"type":"done","reason":"complete"}\n'));
  await pending;
  assert.deepEqual(
    received.map((event) => event.type),
    ["thinking", "text", "text", "done"]
  );
  assert.equal(
    received
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join(""),
    "你好，世界"
  );
});

test("native thinking and projected tool details are preserved independently", async () => {
  const ref = {
    id: "12345678-1234-4234-8234-123456789abc",
    projectId: "87654321-1234-4234-8234-123456789abc",
    identifier: "ENG-42",
    name: "Fix login",
  };
  const details = { input: '{"action":"create"}', output: '{"name":"Fix login"}', truncated: true, workItems: [ref] };
  const frames = [
    { type: "thinking", text: "Checking context" },
    { type: "tool", id: "1", name: "workitem", status: "complete", details: { ...details, unknown: "omit" } },
    { type: "text", text: "Done" },
    { type: "done" },
  ];
  const events = [];
  await readAgentStream(stream([encoder.encode(frames.map((value) => JSON.stringify(value)).join("\n"))]), (event) =>
    events.push(event)
  );
  assert.deepEqual(events[0], { type: "thinking", text: "Checking context" });
  assert.deepEqual(events[1].details, details);
});

test("malformed or oversized tool details cannot enter the UI", async () => {
  const candidates = [
    null,
    { output: "x".repeat(6001) },
    { truncated: "yes" },
    { workItems: [{ id: "../other", projectId: "bad", name: "x" }] },
    { workItems: Array(21).fill({}) },
  ];
  await Promise.all(
    candidates.map((details) =>
      assert.rejects(
        readAgentStream(
          stream([encoder.encode(JSON.stringify({ type: "tool", name: "workitem", status: "complete", details }))]),
          () => {}
        ),
        /Invalid assistant tool details/
      )
    )
  );
});

test("streams split UTF8 frames, blank heartbeats, extra fields and an unterminated done", async () => {
  const bytes = encoder.encode(
    '\n{"type":"text","text":"你好 🌎"}\n\n{"type":"tool","name":"create_issue","status":"complete","id":"1","action":"write"}\n{"type":"done"}'
  );
  const events = [];
  await readAgentStream(stream(Array.from(bytes, (byte) => new Uint8Array([byte]))), (event) => events.push(event));
  assert.deepEqual(
    events.map((event) => event.type),
    ["text", "tool", "done"]
  );
  assert.equal(events[0].text, "你好 🌎");
});
test("preserves canonical text and tool statuses with stable IDs", async () => {
  const frames = [
    { type: "text", text: "Hello" },
    { type: "tool", id: "tool-1", name: "project", action: "list", status: "running" },
    { type: "tool", id: "tool-1", name: "project", action: "list", status: "complete" },
    { type: "tool", id: "tool-2", name: "workitem", action: "create", status: "error" },
    { type: "done", reason: "complete" },
  ];
  const events = [];
  await readAgentStream(stream([encoder.encode(frames.map((frame) => JSON.stringify(frame)).join("\n"))]), (event) =>
    events.push(event)
  );
  assert.deepEqual(events[0], { type: "text", text: "Hello" });
  assert.deepEqual(
    events.slice(1, 4).map((event) => event.status),
    ["running", "complete", "error"]
  );
  assert.equal(events[1].id, events[2].id);
  assert.equal(events[1].action, "list");
});

test("preserves skill loading progress and safe details across stream chunks", async () => {
  const loading = { type: "tool", id: "skill-1", name: "skill", action: "load", status: "running" };
  const frames = [
    loading,
    {
      ...loading,
      status: "complete",
      details: { input: "writing-plane-requirements", output: "Loaded writing-plane-requirements." },
    },
    { ...loading, id: "skill-2" },
    { ...loading, id: "skill-2", status: "error", details: { output: "Skill unavailable." } },
    { type: "done", reason: "complete" },
  ];
  const bytes = encoder.encode(frames.map((frame) => JSON.stringify(frame)).join("\n"));
  const events = [];
  await readAgentStream(stream(Array.from(bytes, (byte) => new Uint8Array([byte]))), (event) => events.push(event));
  assert.deepEqual(events, frames);
});

test("rejects noncanonical text fields and tool statuses", async () => {
  const frames = [
    { type: "text", delta: "not canonical" },
    ...["started", "completed", "failed"].map((status) => ({ type: "tool", name: "project", status })),
  ];
  await Promise.all(
    frames.map((frame) =>
      assert.rejects(
        readAgentStream(stream([encoder.encode(JSON.stringify(frame))]), () => {}),
        /Invalid assistant stream event/
      )
    )
  );
});

test("accepts final text line but rejects missing done as interrupted", async () => {
  const events = [];
  await assert.rejects(
    readAgentStream(stream([encoder.encode('{"type":"text","text":"partial"}')]), (event) => events.push(event)),
    /interrupted/
  );
  assert.equal(events[0].text, "partial");
});
test("propagates provider errors and rejects malformed events", async () => {
  await Promise.all(
    [
      '{"type":"error","message":"Provider rejected request"}',
      '{"type":"tool","name":"x","status":"unknown"}',
      "{broken",
    ].map((line) => assert.rejects(readAgentStream(stream([encoder.encode(line)]), () => {})))
  );
});
test("preserves sanitized model errors and rejects unsuccessful done reasons", async () => {
  await assert.rejects(
    readAgentStream(
      stream([encoder.encode('{"type":"error","message":"Model is unavailable for this account."}')]),
      () => {}
    ),
    { message: "Model is unavailable for this account." }
  );
  await Promise.all(
    ["cancelled", "error", "limit"].map((reason) =>
      assert.rejects(
        readAgentStream(stream([encoder.encode(JSON.stringify({ type: "done", reason }))]), () => {}),
        /interrupted/
      )
    )
  );
});

test("abort interrupts a waiting reader without accepting completion", async () => {
  const controller = new AbortController();
  let canceled = false;
  const pending = readAgentStream(
    new ReadableStream({
      cancel() {
        canceled = true;
      },
    }),
    () => {},
    controller.signal
  );
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(canceled, true);
});
test("done cancels the reader and ignores any subsequent events", async () => {
  const events = [];
  await readAgentStream(stream([encoder.encode('{"type":"done"}\n{"type":"text","text":"ignored"}\n')]), (event) =>
    events.push(event)
  );
  assert.deepEqual(events, [{ type: "done" }]);
});
