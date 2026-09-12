/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { FALLBACK_LANGUAGE, LANGUAGE_STORAGE_KEY, SUPPORTED_LANGUAGES } from "../constants/language";
import type { TLanguage } from "../types";

export function normalizeLanguage(language: unknown): TLanguage {
  return SUPPORTED_LANGUAGES.find((option) => option.value === language)?.value ?? FALLBACK_LANGUAGE;
}

export function getInitialLanguage(): TLanguage {
  try {
    if (typeof window === "undefined") return FALLBACK_LANGUAGE;
    return normalizeLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    // Browsers can deny even reading the localStorage property.
    return FALLBACK_LANGUAGE;
  }
}

export function persistLanguagePreference(language: unknown): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, normalizeLanguage(language));
    }
  } catch {
    // Storage restrictions must not prevent changing the current session language.
  }
}

export function updateDocumentLanguage(language: unknown): void {
  if (typeof document !== "undefined") document.documentElement.lang = normalizeLanguage(language);
}
