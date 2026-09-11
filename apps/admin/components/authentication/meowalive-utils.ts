/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export function isMeowAliveConfigured(
  config:
    | {
        MEOWALIVE_ISSUER_URL?: string;
        MEOWALIVE_CLIENT_ID?: string;
        MEOWALIVE_CLIENT_SECRET?: string;
      }
    | undefined
): boolean {
  return (
    !!config?.MEOWALIVE_CLIENT_ID?.trim() &&
    !!config?.MEOWALIVE_CLIENT_SECRET?.trim() &&
    isValidMeowAliveIssuer(config?.MEOWALIVE_ISSUER_URL || DEFAULT_MEOWALIVE_ISSUER_URL)
  );
}

export const DEFAULT_MEOWALIVE_ISSUER_URL = "https://sso.meowalive.com";

export function isValidMeowAliveIssuer(value: string): boolean {
  if (
    value !== value.trim() ||
    /[?#\\\s]/.test(value) ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    !/^https:\/\/[^/@]+(?:\/|$)/i.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function getMeowAliveCallbackURLs(origin: string) {
  const base = origin ? new URL(origin).origin : "";
  return {
    web: `${base}/auth/meowalive/callback/`,
    spaces: `${base}/auth/spaces/meowalive/callback/`,
  };
}
