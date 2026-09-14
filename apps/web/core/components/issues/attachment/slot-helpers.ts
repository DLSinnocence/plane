/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export function nextEmptyAttachmentName(names: string[], label: string): string {
  const existing = new Set(names.map((name) => name.trim().toLowerCase()));
  const prefix = [...label.trim()].slice(0, 90).join("") || "附件";
  if (!existing.has(prefix.toLowerCase())) return prefix;
  let index = 2;
  while (existing.has(`${prefix}${index}`.toLowerCase())) index += 1;
  return `${prefix}${index}`;
}

export function countAttachments(fileCount: number, slots?: { attachment: unknown }[]): number {
  return slots ? slots.length : fileCount;
}

export function validateAttachmentName(name: string, otherNames: string[]): "name" | "duplicate" | null {
  const value = name.trim();
  if (!value || [...value].length > 100) return "name";
  return otherNames.some((other) => other.trim().toLowerCase() === value.toLowerCase()) ? "duplicate" : null;
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
