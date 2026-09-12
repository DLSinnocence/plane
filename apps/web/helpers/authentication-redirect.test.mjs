import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

// Exercise the real shared validator without loading unrelated package/browser modules.
const urlSource = readFileSync(new URL("../../../packages/utils/src/url.ts", import.meta.url), "utf8");
const validatorSource = urlSource.slice(urlSource.indexOf("export function isValidNextPath"));
const isValidNextPath = new Function(
  `${stripTypeScriptTypes(validatorSource).replace("export function", "function")}; return isValidNextPath;`
)();
const redirectSource = readFileSync(new URL("./authentication-redirect.ts", import.meta.url), "utf8");
const helpers = new Function(
  "isValidNextPath",
  `${stripTypeScriptTypes(redirectSource.replace(/import .* from "@plane\/utils";\n/, "")).replaceAll("export function", "function")}; return {getSafeNextPath, getOnboardingPath, getSignInPath, getOAuthNextPathQuery};`
)(isValidNextPath);
const { getSafeNextPath, getOnboardingPath, getSignInPath, getOAuthNextPathQuery } = helpers;

test("preserve complete invitation destination through authentication and onboarding", () => {
  for (const invitation of [
    "/workspace-invitations/?invitation_id=invite&slug=team&token=private-token",
    "/workspace-invitations/?invitation_id=invite&slug=team&project_id=project&token=private-token",
  ]) {
    const onboarding = new URL(getOnboardingPath(invitation), "https://plane.example");
    assert.equal(onboarding.pathname, "/onboarding");
    assert.equal(onboarding.searchParams.get("next_path"), invitation);
    const login = new URL(
      getSignInPath(onboarding.pathname, onboarding.searchParams.toString()),
      "https://plane.example"
    );
    assert.equal(login.searchParams.get("next_path"), onboarding.pathname + onboarding.search);
    assert.equal(getSafeNextPath(onboarding.searchParams.get("next_path")), invitation);
  }
});

test("reject external, scheme-relative, backslash, and control-character destinations", () => {
  for (const value of [
    "https://evil.example/path",
    "http://plane.example/path",
    "//evil.example/path",
    "//localhost:9000/path",
    "javascript:alert(1)",
    "data:text/html,test",
    "/\\evil.example",
    "/\n/evil.example",
    "relative/path",
    "",
  ]) {
    assert.equal(getSafeNextPath(value), undefined, value);
    assert.equal(getOnboardingPath(value), "/onboarding", value);
  }
});

test("OAuth providers retain the entire invitation as one encoded redirect parameter", () => {
  const invitation = "/workspace-invitations/?invitation_id=invite&slug=team&project_id=project&token=private-token";
  for (const provider of ["meowalive", "google", "github", "gitlab", "gitea"]) {
    const url = new URL(`https://plane.example/auth/${provider}/${getOAuthNextPathQuery(invitation)}`);
    assert.equal(url.searchParams.get("next_path"), invitation);
    assert.equal(url.searchParams.has("token"), false);
    assert.equal(url.searchParams.has("project_id"), false);
  }
  assert.equal(getOAuthNextPathQuery("//evil.example"), "");
});

test("leave normal onboarding defaults and local destinations unchanged", () => {
  assert.equal(getOnboardingPath(undefined), "/onboarding");
  assert.equal(getOnboardingPath(null), "/onboarding");
  assert.equal(getSafeNextPath(" /team/issues "), "/team/issues");
  assert.equal(getSignInPath(null, ""), "/");
  assert.equal(
    new URL(getSignInPath("/onboarding", ""), "https://plane.example").searchParams.get("next_path"),
    "/onboarding"
  );
});
