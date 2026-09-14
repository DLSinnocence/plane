import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown, safeChatUrl } from "./chat-markdown";

const render = (
  content: string,
  workItems = [{ identifier: "ENG-42", href: "/issues/42", title: "Chat improvements" }]
) => renderToStaticMarkup(createElement(ChatMarkdown, { content, workItems }));

test("renders GFM tables, nested lists, disabled task boxes and strikethrough", () => {
  const html = render(
    "| Name | State |\n| --- | --- |\n| **Chat** | ~~old~~ |\n\n- [x] Complete\n- [ ] Pending\n  - Nested"
  );
  for (const fragment of [
    "<table>",
    "<strong>Chat</strong>",
    "<del>old</del>",
    'type="checkbox"',
    'disabled=""',
    'checked=""',
    "Nested",
  ])
    assert.ok(html.includes(fragment), fragment);
});

test("drops executable HTML, unsafe attributes and unsafe protocols", () => {
  const html = render(
    '<script>alert("script-secret")</script><style>style-secret</style><iframe>frame-secret</iframe><form>form-secret</form><svg><script>svg-secret</script></svg>\n\n<a href="jav&#x61;script:alert(1)" onclick="evil()">link</a><img src="data:image/svg+xml,evil" onerror="evil()"><p style="color:red" id="location">safe</p><custom-widget>text</custom-widget>'
  );
  for (const fragment of [
    "script-secret",
    "style-secret",
    "frame-secret",
    "form-secret",
    "svg-secret",
    "javascript:",
    "onclick",
    "onerror",
    "data:image",
    "style=",
    "id=",
    "custom-widget",
    "<script",
    "<form",
  ])
    assert.ok(!html.includes(fragment), fragment);
  assert.ok(html.includes("safe"));
  assert.ok(html.includes("text"));
});

test("retains safe HTML and constrains images and external links", () => {
  const html = render(
    "<details open><summary>More</summary><p><kbd>Esc</kbd> H<sub>2</sub> x<sup>2</sup><br><mark>note</mark></p></details>\n\n![Image](https://example.com/image.png)\n\n[External](https://example.com) [Relative](/local)"
  );
  for (const fragment of [
    "<details open",
    "<summary>More",
    "<kbd>Esc",
    "<sub>2",
    "<sup>2",
    "<mark>note",
    'loading="lazy"',
    'referrerPolicy="no-referrer"',
    'rel="noopener noreferrer"',
    'href="/local"',
  ])
    assert.ok(html.includes(fragment), fragment);
});

test("links only known whole identifiers outside existing anchors and code", () => {
  const html = render(
    "**ENG-42** ENG-420 XENG-42 ENG-42-extra ENG-99 `ENG-42` [ENG-42](/original)\n\n```text\nENG-42\n```\n\n<a href='/html'>ENG-42</a>"
  );
  assert.equal((html.match(/href="\/issues\/42"/g) ?? []).length, 1);
  assert.ok(html.includes('<strong><a href="/issues/42" title="Chat improvements">ENG-42</a></strong>'));
  assert.ok(html.includes('<a href="/original">ENG-42</a>'));
  assert.ok(html.includes('<a href="/html">ENG-42</a>'));
  assert.ok(!html.includes('href="/issues/99"'));
  assert.ok(!render("ENG-42", [{ identifier: "ENG-42", href: "javascript:alert(1)", title: "unsafe" }]).includes("<a"));
});

test("highlighted code remains escaped and unknown languages fall back", () => {
  const highlighted = render('```javascript\nconst value = "<script>";\n```');
  assert.ok(highlighted.includes("hljs-keyword"));
  assert.ok(!highlighted.includes("<script>"));
  const unknown = render("```unknown-language\n<widget>& text\n```");
  assert.ok(unknown.includes("&lt;widget&gt;&amp; text"));
  assert.ok(!unknown.includes("hljs-"));
  assert.ok(unknown.includes("Copy code"));
});

test("empty and unfinished streaming fences render and huge blocks skip highlighting", () => {
  for (const content of ["", "```", "```typescript", "```typescript\nconst partial =", "before\n\n~~~\nunclosed"])
    assert.doesNotThrow(() => render(content));
  const html = render(`\`\`\`javascript\n${"const n = 1;\n".repeat(2000)}\`\`\``);
  assert.ok(!html.includes("hljs-"));
});

test("URL checks reject executable schemes, whitespace and browser backslash normalization", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,evil",
    "vbscript:evil",
    "java\nscript:evil",
    "\\\\evil.test",
    "file:///tmp/file",
  ])
    assert.equal(safeChatUrl(url), undefined);
  for (const url of [
    "https://example.com",
    "http://example.com",
    "/relative",
    "../relative",
    "#heading",
    "mailto:hello@example.com",
    "//example.com",
  ])
    assert.equal(safeChatUrl(url), url);
  assert.equal(safeChatUrl("mailto:hello@example.com", true), undefined);
});
