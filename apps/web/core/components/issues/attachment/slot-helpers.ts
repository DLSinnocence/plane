/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export function nextEmptyAttachmentName(names: string[], label: string): string {
  const existing = new Set(names.map((name) => name.trim().toLowerCase()));
  const prefix = [...label.trim()].slice(0, 90).join("") || "Empty attachment";
  let index = 1;
  while (existing.has(`${prefix} ${index}`.toLowerCase())) index += 1;
  return `${prefix} ${index}`;
}

export function countAttachments(fileCount: number, slots: { attachment: unknown }[]): number {
  return fileCount + slots.filter((slot) => !slot.attachment).length;
}

export function validateSlotNames(names: string[]): "name" | "count" | "duplicate" | null {
  if (names.length < 1 || names.length > 50) return "count";
  const trimmed = names.map((name) => name.trim());
  if (trimmed.some((name) => !name || [...name].length > 100)) return "name";
  if (new Set(trimmed.map((name) => name.toLowerCase())).size !== trimmed.length) return "duplicate";
  return null;
}

export function missingSlotNames(current: string[], incoming: string[]): string[] {
  const existing = new Set(current.map((name) => name.trim().toLowerCase()));
  return incoming
    .map((name) => name.trim())
    .filter((name) => {
      const key = name.toLowerCase();
      if (existing.has(key)) return false;
      existing.add(key);
      return true;
    });
}
