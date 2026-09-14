/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Usage: pnpm --filter @plane/i18n sync:fill
// Adds English source text for absent keys. Existing translations are preserved.
// Run check:sync afterwards; this command never disables the strict CI check.

import fs from "node:fs";
import path from "node:path";
import { fillMissingKeys } from "./lib/fill-missing.js";
import { LOCALES_DIR, listLocales, loadLocale } from "./lib/locale-io.js";

function main() {
  const source = loadLocale("en");
  const updates: { file: string; content: string }[] = [];
  const counts = new Map<string, number>();

  // Build every update first so a structural conflict cannot cause a partial sync.
  for (const locale of listLocales().filter((name) => name !== "en")) {
    const translated = loadLocale(locale);
    const namespaces = new Map(translated.namespaces.map((namespace) => [namespace.name, namespace.data]));
    let total = 0;
    for (const namespace of source.namespaces) {
      const data = namespaces.get(namespace.name) ?? {};
      const added = fillMissingKeys(namespace.data, data, `${locale}/${namespace.name}`);
      if (added > 0) {
        total += added;
        updates.push({
          file: path.join(LOCALES_DIR, locale, `${namespace.name}.json`),
          content: JSON.stringify(data, null, 2) + "\n",
        });
      }
    }
    if (total > 0) counts.set(locale, total);
  }

  for (const update of updates) fs.writeFileSync(update.file, update.content, "utf8");
  for (const [locale, count] of counts) console.log(`${locale}: added ${count} English fallback values`);
  console.log(
    updates.length
      ? `Updated ${updates.length} locale files; existing translations preserved.`
      : "No missing locale keys."
  );
}

try {
  main();
} catch (error) {
  console.error("Locale fill failed:", error);
  process.exitCode = 1;
}
