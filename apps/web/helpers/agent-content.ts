/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
export type AgentContentKind = "text" | "thinking" | "tool-call" | "tool-result";
export type AgentContentPart = { kind: AgentContentKind; text: string; complete: boolean };

const tagKinds: Record<string, AgentContentKind> = {
  think: "thinking",
  thinking: "thinking",
  analysis: "thinking",
  reasoning: "thinking",
  tool_call: "tool-call",
  tool_calls: "tool-call",
  tool_use: "tool-call",
  function_call: "tool-call",
  tool_result: "tool-result",
  tool_response: "tool-result",
  function_result: "tool-result",
  function_response: "tool-result",
  final: "text",
  answer: "text",
  response: "text",
};
const tagNames = Object.keys(tagKinds);
const tagPattern =
  /^<\s*(\/?)\s*(think|thinking|analysis|reasoning|tool_calls|tool_call|tool_use|function_call|tool_result|tool_response|function_result|function_response|final|answer|response)(?:\s+(?:[^"'<>]|"[^"]*"|'[^']*')*)?\s*>/i;

function isPendingTag(text: string): boolean {
  const match = text.match(/^<\s*\/?\s*([a-z_]*)/i);
  if (!match || text.includes(">")) return false;
  const name = match[1].toLowerCase();
  const remainder = text.slice(match[0].length);
  return remainder.length === 0 ? tagNames.some((tag) => tag.startsWith(name)) : Boolean(tagKinds[name]);
}

/** Separate model-emitted semantic tags without treating literal code as markup.
 * These textual tool fragments are never execution records or executable commands.
 * Reparse the accumulated text while streaming so split opening/closing tags do not flash.
 */
export function parseAgentContent(content: string, streaming = false): AgentContentPart[] {
  const parts: AgentContentPart[] = [];
  const stack: { tag: string; kind: AgentContentKind }[] = [];
  let text = "";
  let position = 0;
  let fence: { marker: string; length: number } | undefined;
  const kind = () => stack.at(-1)?.kind ?? "text";
  const flush = (complete: boolean) => {
    if (text.trim()) parts.push({ kind: kind(), text, complete });
    text = "";
  };
  while (position < content.length) {
    const lineStart = position === 0 || content[position - 1] === "\n";
    if (lineStart) {
      const lineEnd = content.indexOf("\n", position);
      const end = lineEnd < 0 ? content.length : lineEnd + 1;
      const line = content.slice(position, end);
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fence) {
        text += line;
        if (
          marker &&
          marker[1][0] === fence.marker &&
          marker[1].length >= fence.length &&
          !line.slice(marker[0].length).trim()
        )
          fence = undefined;
        position = end;
        continue;
      }
      if (marker) {
        fence = { marker: marker[1][0], length: marker[1].length };
        text += line;
        position = end;
        continue;
      }
      if (/^( {4}|\t)/.test(line)) {
        text += line;
        position = end;
        continue;
      }
    }
    if (content[position] === "\\" && /[<`\\]/.test(content[position + 1] ?? "")) {
      text += content.slice(position, position + 2);
      position += 2;
      continue;
    }
    // Inline code spans (including multiline spans) preserve literal agent tags.
    if (content[position] === "`") {
      const run = content.slice(position).match(/^`+/)![0];
      let end = content.indexOf(run, position + run.length);
      while (end >= 0 && (content[end - 1] === "`" || content[end + run.length] === "`"))
        end = content.indexOf(run, end + run.length);
      if (end < 0) {
        text += content.slice(position);
        position = content.length;
      } else {
        text += content.slice(position, end + run.length);
        position = end + run.length;
      }
      continue;
    }
    if (content[position] === "<") {
      const tail = content.slice(position);
      const match = tail.match(tagPattern);
      if (match) {
        const tag = match[2].toLowerCase();
        flush(true);
        if (match[1]) {
          const index = stack.map((entry) => entry.tag).lastIndexOf(tag);
          if (index >= 0) stack.splice(index);
        } else {
          stack.push({ tag, kind: tagKinds[tag] });
        }
        position += match[0].length;
        continue;
      }
      if (streaming && isPendingTag(tail)) break;
    }
    text += content[position++];
  }
  flush(stack.length === 0);
  return parts;
}

/** Keep model thinking/tool fragments out of subsequent model context. */
export function agentAnswerContent(content: string): string {
  return parseAgentContent(content)
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}
