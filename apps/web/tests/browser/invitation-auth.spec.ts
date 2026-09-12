/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { expect, test, type Page } from "@playwright/test";

const STORAGE_KEY = "plane-invitation-auth-fixture";
const INVITATION_ID = "invite-123";
const PROJECT_ID = "project-456";
const EMAIL = "invitee@example.test";
const TOKEN = "private+token&with=query/characters";
const FLOW = "workspace_settings.settings.members.invitation_flow";
const pageErrors = new WeakMap<Page, string[]>();
const unexpectedApiRequests = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  unexpectedApiRequests.set(page, []);
  page.on("pageerror", (error) => errors.push(error.message));
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page), "The real invitation page and auth wrapper must not throw browser errors").toEqual([]);
  expect(unexpectedApiRequests.get(page), "Every API request must match an explicit fixture response").toEqual([]);
});

function invitationPath(project = false) {
  const query = new URLSearchParams({ invitation_id: INVITATION_ID, slug: "workspace", token: TOKEN });
  if (project) query.set("project_id", PROJECT_ID);
  return `/workspace-invitations/?${query}`;
}

function endpoint(project = false) {
  return project
    ? `/api/workspaces/workspace/projects/${PROJECT_ID}/join/${INVITATION_ID}/`
    : `/api/workspaces/workspace/invitations/${INVITATION_ID}/join/`;
}

type FixtureOptions = {
  authenticated?: boolean;
  email?: string;
  onboarded?: boolean;
  invalidInitialUser?: boolean;
  project?: boolean;
  detail?: unknown;
  detailStatus?: number;
  acceptStatus?: number;
  restoration?: Promise<void>;
};

type RecordedRequest = { method: string; path: string; data?: unknown; authenticated?: boolean };

async function installFixture(page: Page, options: FixtureOptions = {}) {
  await page.addInitScript(
    ({ key, session }) => {
      if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, JSON.stringify(session));
    },
    {
      key: STORAGE_KEY,
      session: {
        authenticated: options.authenticated ?? false,
        email: options.email ?? EMAIL,
        onboarded: options.onboarded ?? false,
        invalidInitialUser: options.invalidInitialUser ?? false,
      },
    }
  );
  const requests: RecordedRequest[] = [];
  const details =
    options.detail === undefined
      ? {
          id: INVITATION_ID,
          email: EMAIL,
          accepted: false,
          responded_at: null,
          workspace: { slug: "workspace", name: "Invitation workspace" },
          ...(options.project ? { project: { id: PROJECT_ID, name: "Invitation project" } } : {}),
        }
      : options.detail;

  // All network API calls are fulfilled locally. The form only simulates session
  // establishment; InvitationService/APIService still make their real requests.
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/api/users/me/" && method === "GET") {
      const authenticated = request.headers()["x-fixture-authenticated"] === "true";
      requests.push({ method, path, authenticated });
      await options.restoration;
      await route.fulfill({
        status: authenticated ? 200 : 401,
        json: authenticated
          ? {
              id: "session-user",
              email: request.headers()["x-fixture-email"] ?? EMAIL,
              display_name: "Invitation user",
            }
          : { detail: "Authentication credentials were not provided." },
      });
      return;
    }
    requests.push({ method, path, ...(method === "POST" ? { data: request.postDataJSON() } : {}) });
    if (path === endpoint(options.project) && method === "GET") {
      await route.fulfill({ status: options.detailStatus ?? 200, json: details });
      return;
    }
    if (path === endpoint(options.project) && method === "POST") {
      if (options.acceptStatus === 401) {
        await page.evaluate((key) => {
          const saved = JSON.parse(sessionStorage.getItem(key)!);
          sessionStorage.setItem(key, JSON.stringify({ ...saved, authenticated: false }));
        }, STORAGE_KEY);
      }
      await route.fulfill({
        status: options.acceptStatus ?? 200,
        json: options.acceptStatus === 401 ? { detail: "Session expired" } : { message: "Invitation accepted" },
      });
      return;
    }
    if (path === "/api/users/me/workspaces/" && method === "GET") {
      await route.fulfill({ json: [{ id: "workspace", slug: "workspace", name: "Invitation workspace" }] });
      return;
    }
    if (path === "/api/users/me/settings/" && method === "GET") {
      await route.fulfill({ json: { workspace: { last_workspace_slug: "workspace" } } });
      return;
    }
    unexpectedApiRequests.get(page)?.push(`${method} ${path}`);
    await route.fulfill({ status: 500, json: { detail: "Unexpected fixture API request" } });
  });
  return requests;
}

async function expectSignInReturn(page: Page, invitation: string) {
  await expect(page.getByRole("form", { name: "Simulated session login" })).toBeVisible();
  const url = new URL(page.url());
  expect(url.pathname).toBe("/");
  expect(url.search).toBe(`?next_path=${encodeURIComponent(invitation)}`);
  expect(url.searchParams.get("next_path")).toBe(invitation);
  expect(url.searchParams.has("token")).toBe(false);
}

async function expectInvitation(page: Page) {
  await expect(page.getByRole("button", { name: `${FLOW}.accept`, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: `${FLOW}.invited_to`, exact: true })).toBeVisible();
  await expect(page.getByRole("form", { name: "Simulated session login" })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/workspace-invitations/");
}

for (const project of [false, true]) {
  test(`anonymous ${project ? "project" : "workspace"} invitation keeps its exact return URL until simulated login`, async ({
    page,
  }) => {
    const requests = await installFixture(page, { project, invalidInitialUser: true });
    const path = invitationPath(project);
    await page.goto(path);
    await expectSignInReturn(page, path);
    expect(requests.filter((request) => request.path === endpoint(project))).toEqual([]);
    await page.getByRole("button", { name: "Simulate sign in", exact: true }).click();
    await expectInvitation(page);
    expect(new URL(page.url()).search).toBe(new URL(path, "https://fixture.test").search);
    expect(requests.filter((request) => request.path === endpoint(project) && request.method === "GET")).toHaveLength(
      1
    );
  });

  test(`authenticated new user accepts a ${project ? "project" : "workspace"} invite without workspace onboarding`, async ({
    page,
  }) => {
    const requests = await installFixture(page, { authenticated: true, onboarded: false, project });
    await page.goto(invitationPath(project));
    await expectInvitation(page);
    expect(page.url()).not.toContain("create-workspace");
    expect(page.url()).not.toContain("onboarding");
    await page.getByRole("button", { name: `${FLOW}.accept`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(project ? `/workspace/projects/${PROJECT_ID}/issues$` : "/workspace$"));
    expect(requests.filter((request) => request.method === "POST")).toEqual([
      { method: "POST", path: endpoint(project), data: { token: TOKEN, accepted: true } },
    ]);
    expect(requests.some((request) => request.path === "/api/users/me/workspaces/")).toBe(true);
    expect(requests.some((request) => request.path === "/api/users/me/settings/")).toBe(true);
  });
}

test("asynchronous session restoration completes before any invitation detail request", async ({ page }) => {
  let release!: () => void;
  const restoration = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests = await installFixture(page, { authenticated: true, restoration });
  const sessionRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/users/me/");
  await page.goto(invitationPath(), { waitUntil: "domcontentloaded" });
  await sessionRequest;
  await expect(page.getByRole("img", { name: "logo", exact: true })).toBeVisible();
  expect(requests.filter((request) => request.path === endpoint())).toEqual([]);
  release();
  await expectInvitation(page);
});

test("logged-in new user returns from signup directly to the invitation", async ({ page }) => {
  await installFixture(page, { authenticated: true, onboarded: false, project: true });
  const path = invitationPath(true);
  await page.goto(`/sign-up?next_path=${encodeURIComponent(path)}`);
  await expectInvitation(page);
  expect(new URL(page.url()).searchParams.get("project_id")).toBe(PROJECT_ID);
  expect(new URL(page.url()).searchParams.get("token")).toBe(TOKEN);
});

for (const detail of [
  null,
  [],
  { detail: "Authentication credentials were not provided." },
  { id: INVITATION_ID, email: EMAIL },
  { id: INVITATION_ID, workspace: null },
  { id: INVITATION_ID, workspace: { slug: "workspace" } },
]) {
  test(`malformed invitation response is a controlled invalid link: ${JSON.stringify(detail)}`, async ({ page }) => {
    const requests = await installFixture(page, { authenticated: true, detail });
    await page.goto(invitationPath());
    await expect(page.getByRole("heading", { name: `${FLOW}.invalid_link`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `${FLOW}.accept`, exact: true })).toHaveCount(0);
    await expect(page.getByText("Oops! Something went wrong.", { exact: true })).toHaveCount(0);
    expect(requests.filter((request) => request.method === "POST")).toEqual([]);
  });
}

for (const missing of ["invitation_id", "slug", "token"]) {
  test(`missing ${missing} displays the invalid-link guidance without a detail request`, async ({ page }) => {
    const requests = await installFixture(page, { authenticated: true });
    const url = new URL(invitationPath(), "https://fixture.test");
    url.searchParams.delete(missing);
    await page.goto(url.pathname + url.search);
    await expect(page.getByRole("heading", { name: `${FLOW}.invalid_link`, exact: true })).toBeVisible();
    expect(requests.filter((request) => request.path === endpoint())).toEqual([]);
  });
}

for (const expired of ["removed", "responded"]) {
  test(`${expired} invitation displays controlled expiry guidance`, async ({ page }) => {
    await installFixture(page, {
      authenticated: true,
      ...(expired === "removed"
        ? { detailStatus: 404, detail: { detail: "Not found" } }
        : {
            detail: {
              id: INVITATION_ID,
              email: EMAIL,
              workspace: { name: "Workspace", slug: "workspace" },
              responded_at: "2026-01-01T00:00:00Z",
            },
          }),
    });
    await page.goto(invitationPath());
    await expect(page.getByRole("heading", { name: `${FLOW}.invalid_link`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `${FLOW}.accept`, exact: true })).toHaveCount(0);
  });
}

test("a different signed-in email cannot submit acceptance", async ({ page }) => {
  const requests = await installFixture(page, { authenticated: true, email: "someone-else@example.test" });
  await page.goto(invitationPath());
  await expect(page.getByRole("alert")).toHaveText(`${FLOW}.wrong_email`);
  await expect(page.getByRole("button", { name: `${FLOW}.accept`, exact: true })).toHaveCount(0);
  expect(requests.filter((request) => request.method === "POST")).toEqual([]);
});

test("401 during acceptance preserves token and project return path for sign in again", async ({ page }) => {
  const requests = await installFixture(page, { authenticated: true, project: true, acceptStatus: 401 });
  const path = invitationPath(true);
  await page.goto(path);
  await expectInvitation(page);
  await page.getByRole("button", { name: `${FLOW}.accept`, exact: true }).click();
  await expectSignInReturn(page, path);
  expect(requests.filter((request) => request.method === "POST")).toEqual([
    { method: "POST", path: endpoint(true), data: { token: TOKEN, accepted: true } },
  ]);
  expect(requests.some((request) => request.path === "/api/users/me/workspaces/")).toBe(false);
});
