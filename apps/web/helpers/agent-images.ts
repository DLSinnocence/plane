/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import type { AgentImage } from "./agent-stream";

export const MAX_AGENT_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_AGENT_IMAGES = 3;

export function detectAgentImageType(bytes: Uint8Array): AgentImage["mime_type"] | undefined {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value))
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  return undefined;
}

export function imagePreviewUrl(image: AgentImage): string {
  return `data:${image.mime_type};base64,${image.data}`;
}

export function canAddAgentImages(existing: number, added: number): boolean {
  return (
    Number.isInteger(existing) &&
    Number.isInteger(added) &&
    existing >= 0 &&
    added > 0 &&
    existing + added <= MAX_AGENT_IMAGES
  );
}

export async function readAgentImage(file: File, signal: AbortSignal): Promise<AgentImage> {
  signal.throwIfAborted();
  if (!file.size || file.size > MAX_AGENT_IMAGE_BYTES) throw new Error("image_invalid");
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      reader.removeEventListener("load", load);
      reader.removeEventListener("error", fail);
    };
    const abort = () => {
      cleanup();
      reader.abort();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const load = () => {
      cleanup();
      resolve(String(reader.result));
    };
    const fail = () => {
      cleanup();
      reject(new Error("image_invalid"));
    };
    signal.addEventListener("abort", abort, { once: true });
    reader.addEventListener("load", load, { once: true });
    reader.addEventListener("error", fail, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    reader.readAsDataURL(file);
  });
  signal.throwIfAborted();
  const data = url.slice(url.indexOf(",") + 1);
  const prefix = atob(data.slice(0, 32));
  const mime_type = detectAgentImageType(Uint8Array.from(prefix, (char) => char.charCodeAt(0)));
  if (!mime_type || (file.type && file.type !== "application/octet-stream" && file.type !== mime_type))
    throw new Error("image_invalid");
  return { data, mime_type, name: file.name.slice(0, 255) };
}
