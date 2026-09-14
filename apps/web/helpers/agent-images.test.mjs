import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canAddAgentImages,
  detectAgentImageType,
  imagePreviewUrl,
  readAgentImage,
  MAX_AGENT_IMAGE_BYTES,
} from "./agent-images.ts";
import { canSendAgentMessage } from "./agent-chat.ts";

test("image MIME is detected from binary bytes and active formats only", () => {
  assert.equal(detectAgentImageType(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])), "image/png");
  assert.equal(detectAgentImageType(Uint8Array.from([255, 216, 255])), "image/jpeg");
  assert.equal(detectAgentImageType(new TextEncoder().encode("RIFFxxxxWEBP")), "image/webp");
  assert.equal(detectAgentImageType(new TextEncoder().encode("<svg></svg>")), undefined);
  assert.equal(detectAgentImageType(new TextEncoder().encode("GIF89a")), undefined);
});
test("image limits span existing conversation and draft and permit image-only sending", () => {
  assert.equal(canAddAgentImages(2, 1), true);
  assert.equal(canAddAgentImages(2, 2), false);
  assert.equal(canAddAgentImages(0, 0), false);
  assert.equal(canSendAgentMessage("", false, true, 1), true);
  assert.equal(canSendAgentMessage("", true, true, 1), false);
  assert.equal(canSendAgentMessage("", false, false, 1), false);
  assert.equal(imagePreviewUrl({ data: "abc", mime_type: "image/png" }), "data:image/png;base64,abc");
});
test("rejects oversized images and aborted reads before allocating FileReader", async () => {
  await assert.rejects(
    readAgentImage({ size: MAX_AGENT_IMAGE_BYTES + 1 }, new AbortController().signal),
    /image_invalid/
  );
  await assert.rejects(readAgentImage({ size: 1 }, AbortSignal.abort()), { name: "AbortError" });
});
