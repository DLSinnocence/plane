/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { initPromise, i18nInstance } from "./instance";
import { normalizeLanguage, persistLanguagePreference, updateDocumentLanguage } from "./language-preference";
import type { TLanguage } from "../types";

export async function setLanguage(lng: TLanguage): Promise<void> {
  await initPromise;
  const language = normalizeLanguage(lng);
  await i18nInstance.changeLanguage(language);
  persistLanguagePreference(language);
  updateDocumentLanguage(i18nInstance.resolvedLanguage ?? i18nInstance.language);
}
