import { z } from "zod";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_CHAT_IMAGES = 3;
const MAX_IMAGE_BASE64 = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

export function validImageData(data: string, mimeType: string): boolean {
  if (!data || data.length > MAX_IMAGE_BASE64 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    return false;
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== data) return false;
  if (mimeType === "image/png")
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mimeType === "image/webp")
    return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return false;
}

export const aiImageSchema = z
  .object({
    data: z.string().min(1).max(MAX_IMAGE_BASE64),
    mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
    name: z.string().max(255).optional(),
  })
  .strict()
  .refine((value) => validImageData(value.data, value.mime_type), "Invalid image data.");

export const aiMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(20_000),
    images: z.array(aiImageSchema).min(1).max(MAX_CHAT_IMAGES).optional(),
  })
  .strict()
  .refine((value) => value.role === "user" || !value.images, "Only user messages can contain images.")
  .refine((value) => Boolean(value.content.trim() || value.images?.length), "A message needs text or an image.");
