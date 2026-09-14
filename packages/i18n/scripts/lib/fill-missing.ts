/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export type TranslationTree = Record<string, unknown>;

function branch(value: unknown): value is TranslationTree {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Fill absent leaves from English without changing any existing translation. */
export function fillMissingKeys(source: TranslationTree, translated: TranslationTree, prefix = ""): number {
  let added = 0;
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(translated, key)) {
      Object.defineProperty(translated, key, {
        value: branch(value) ? {} : structuredClone(value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      if (!branch(value)) added += 1;
    }
    const current = translated[key];
    if (branch(value)) {
      if (!branch(current)) throw new Error(`Translation path conflict at ${path}`);
      added += fillMissingKeys(value, current, path);
    } else if (branch(current)) {
      throw new Error(`Translation path conflict at ${path}`);
    }
  }
  return added;
}
