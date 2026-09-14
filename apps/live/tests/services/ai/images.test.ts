import { describe, expect, it } from "vitest";
import { aiChatSchema } from "@/services/ai/types";
import { aiImageSchema, MAX_IMAGE_BYTES, validImageData } from "@/services/ai/images";
import { input } from "./fixtures";

export const pngImage = {
  mime_type: "image/png" as const,
  name: "screenshot.png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=",
};

describe("multimodal Agent input", () => {
  it("accepts custom HTTP endpoints and image-only user prompts when enabled", () => {
    const request = {
      ...input,
      model_config: { ...input.model_config, base_url: "http://my-model-gateway:8080/v1", supports_images: true },
      messages: [{ role: "user", content: "", images: [pngImage] }],
    };
    expect(aiChatSchema.safeParse(request).success).toBe(true);
    expect(
      aiChatSchema.safeParse({ ...request, model_config: { ...request.model_config, supports_images: false } }).success
    ).toBe(false);
  });
  it("rejects assistant images, spoofed formats, URL payloads and corrupt base64", () => {
    expect(aiImageSchema.safeParse(pngImage).success).toBe(true);
    for (const image of [
      { ...pngImage, mime_type: "image/jpeg" },
      { ...pngImage, data: "https://example.com/a.png" },
      { ...pngImage, data: pngImage.data + "!" },
      { ...pngImage, mime_type: "image/svg+xml" },
      { ...pngImage, data: Buffer.from("<svg/>").toString("base64") },
    ]) {
      expect(aiImageSchema.safeParse(image).success).toBe(false);
    }
    expect(
      aiChatSchema.safeParse({
        ...input,
        model_config: { ...input.model_config, supports_images: true },
        messages: [{ role: "assistant", content: "image", images: [pngImage] }, ...input.messages],
      }).success
    ).toBe(false);
  });
  it("bounds decoded image size and the number of images across history", () => {
    const bytes = Buffer.alloc(MAX_IMAGE_BYTES, 0);
    Buffer.from(pngImage.data, "base64").copy(bytes);
    expect(validImageData(bytes.toString("base64"), "image/png")).toBe(true);
    expect(validImageData(Buffer.concat([bytes, Buffer.from([0])]).toString("base64"), "image/png")).toBe(false);
    const request = {
      ...input,
      model_config: { ...input.model_config, supports_images: true },
      messages: [
        { role: "user", content: "earlier", images: [pngImage, pngImage] },
        { role: "assistant", content: "answer" },
        { role: "user", content: "later", images: [pngImage, pngImage] },
      ],
    };
    expect(aiChatSchema.safeParse(request).success).toBe(false);
  });
});
