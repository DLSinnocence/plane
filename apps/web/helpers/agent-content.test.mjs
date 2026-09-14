import assert from "node:assert/strict";
import { test } from "node:test";
import { agentAnswerContent, parseAgentContent } from "./agent-content.ts";

test("Agent thoughts, tool fragments and final text are distinct", () => {
  const value =
    '<think>Reviewing the request</think><tool_call>{"name":"workitem"}</tool_call><tool_result>{"ok":true}</tool_result><final>**Done**</final>';
  const parts = parseAgentContent(value);
  assert.deepEqual(
    parts.map((p) => p.kind),
    ["thinking", "tool-call", "tool-result", "text"]
  );
  assert.equal(parts[3].text, "**Done**");
  assert.equal(agentAnswerContent(value), "**Done**");
  assert.ok(parts.every((p) => p.complete));
});

test("streamed opening and closing tag fragments do not flash into body text", () => {
  const source = "<thinking>Look up the task</thinking><answer>Here is the answer.</answer>";
  for (let length = 1; length <= source.length; length++) {
    const parts = parseAgentContent(source.slice(0, length), true);
    const body = parts
      .filter((p) => p.kind === "text")
      .map((p) => p.text)
      .join("");
    assert.ok(!body.includes("Look up"), `thought leaked at ${length}`);
    assert.ok(!/<\/?(?:thi|ans)/i.test(body), `tag leaked at ${length}`);
  }
  assert.equal(agentAnswerContent(source), "Here is the answer.");
  assert.deepEqual(parseAgentContent("<think>unfinished</thi", true), [
    { kind: "thinking", text: "unfinished", complete: false },
  ]);
});

test("alternate native-model textual tags and whitespace/case are accepted", () => {
  for (const tag of ["think", "thinking", "analysis", "reasoning"]) {
    assert.equal(parseAgentContent(`<${tag.toUpperCase()} >body</${tag} >`)[0].kind, "thinking");
  }
  assert.equal(parseAgentContent('<tool_use name="lookup">{}</tool_use>')[0].kind, "tool-call");
  assert.equal(parseAgentContent('<function_call name="a>b">{}</function_call>')[0].text, "{}");
  assert.equal(parseAgentContent("<function_result>ok</function_result>")[0].kind, "tool-result");
  assert.equal(parseAgentContent("<tool_response>ok</tool_response>")[0].kind, "tool-result");
  assert.equal(parseAgentContent("<function_response>ok</function_response>")[0].kind, "tool-result");
  assert.equal(parseAgentContent("<tool_calls>[]</tool_calls>")[0].kind, "tool-call");
  assert.equal(agentAnswerContent("<response>Answer</response>"), "Answer");
});

test("literal Agent tags inside fenced and inline code are not interpreted", () => {
  const values = [
    "```xml\n<think>literal</think>\n```",
    "~~~xml\n<tool_call>{}</tool_call>\n~~~",
    "````xml\n```\n<analysis>literal</analysis>\n````",
    "Example `<think>literal</think>` and ``<tool_call>`x`</tool_call>``.",
    "```xml\n<think>unfinished fence",
  ];
  for (const content of values) {
    assert.deepEqual(
      parseAgentContent(content, true).map((p) => p.kind),
      ["text"]
    );
    assert.equal(agentAnswerContent(content), content);
  }
});

test("escaped tags and ordinary HTML remain Markdown and nested wrappers are safe", () => {
  assert.equal(agentAnswerContent("\\<think>example\\</think>"), "\\<think>example\\</think>");
  assert.equal(parseAgentContent("    <think>example</think>")[0].kind, "text");
  assert.equal(agentAnswerContent("&lt;think&gt;example&lt;/think&gt;"), "&lt;think&gt;example&lt;/think&gt;");
  assert.equal(
    agentAnswerContent("<details><summary>More</summary>Body</details>"),
    "<details><summary>More</summary>Body</details>"
  );
  const value = "<analysis>outer<think>inner</think>end</analysis><final>done</final>";
  assert.equal(agentAnswerContent(value), "done");
  assert.equal(parseAgentContent("x < 3", true)[0].text, "x < 3");
  assert.equal(parseAgentContent("").length, 0);
});
