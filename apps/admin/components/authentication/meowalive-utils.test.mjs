/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
const { DEFAULT_MEOWALIVE_ISSUER_URL, getMeowAliveCallbackURLs, isValidMeowAliveIssuer } = await import(
  new URL("./meowalive-utils.ts", import.meta.url).href
);

test("accepts HTTPS MeowAlive issuers including issuer paths", () => {
  for (const value of [
    DEFAULT_MEOWALIVE_ISSUER_URL,
    "https://identity.example/oidc",
    "https://identity.example:8443/",
  ]) {
    assert.equal(isValidMeowAliveIssuer(value), true, value);
  }
});

test("rejects insecure or malformed issuers and forbidden URL components", () => {
  for (const value of [
    "",
    "http://identity.example",
    "javascript:alert(1)",
    "identity.example",
    "https://",
    "https://@identity.example",
    "https://:secret@identity.example",
    "/oidc",
    "https:///identity.example",
    "https://identity.example\t/oidc",
    "https://identity.example\n/oidc",
    "https://identity.example\r/oidc",
    "\u0000https://identity.example",
    "https://identity.example/\u001f",
    "https://identity.example/\u007f",
    "https://host\u0000",
    "https://user:secret@identity.example",
    "https://user@identity.example",
    "https://identity.example?x=1",
    "https://identity.example?",
    "https://identity.example#fragment",
    "https://identity.example/#",
    "https://identity.example/?",
    "https://identity.example#",
    " https://identity.example",
    "https://identity.example/white space",
    "https://identity.example\\path",
  ]) {
    assert.equal(isValidMeowAliveIssuer(value), false, value);
  }
});

test("readiness requires trimmed credentials and a valid effective issuer", async () => {
  const { isMeowAliveConfigured } = await import(new URL("./meowalive-utils.ts", import.meta.url).href);
  const credentials = { MEOWALIVE_CLIENT_ID: "client", MEOWALIVE_CLIENT_SECRET: "secret" };
  assert.equal(isMeowAliveConfigured(credentials), true);
  assert.equal(isMeowAliveConfigured({ ...credentials, MEOWALIVE_ISSUER_URL: "" }), true);
  assert.equal(isMeowAliveConfigured({ ...credentials, MEOWALIVE_ISSUER_URL: "https://identity.example/oidc" }), true);
  assert.equal(isMeowAliveConfigured({ ...credentials, MEOWALIVE_ISSUER_URL: "http://identity.example" }), false);
  for (const blank of ["", " ", "\t\n"]) {
    assert.equal(isMeowAliveConfigured({ ...credentials, MEOWALIVE_CLIENT_ID: blank }), false);
    assert.equal(isMeowAliveConfigured({ ...credentials, MEOWALIVE_CLIENT_SECRET: blank }), false);
  }
  assert.equal(isMeowAliveConfigured(undefined), false);
});

test("both callback URLs preserve exact trailing slashes", () => {
  for (const origin of [
    "https://plane.example",
    "https://plane.example/",
    "https://plane.example/api/?query=1#fragment",
  ]) {
    assert.deepEqual(getMeowAliveCallbackURLs(origin), {
      web: "https://plane.example/auth/meowalive/callback/",
      spaces: "https://plane.example/auth/spaces/meowalive/callback/",
    });
  }
});
