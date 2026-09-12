/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { makeAutoObservable, runInAction } from "mobx";

export const AUTH_FIXTURE_KEY = "plane-invitation-auth-fixture";

type FixtureSession = {
  authenticated: boolean;
  email: string;
  onboarded: boolean;
  invalidInitialUser?: boolean;
};
type FixtureUser = { id: string; email: string; display_name: string };
type InvalidUser = { detail: string };

export function authFixtureEnabled() {
  return sessionStorage.getItem(AUTH_FIXTURE_KEY) !== null;
}

function session(): FixtureSession {
  const saved = sessionStorage.getItem(AUTH_FIXTURE_KEY);
  return saved ? JSON.parse(saved) : { authenticated: false, email: "invitee@example.test", onboarded: false };
}

/** Simulated session data only: real invitation/auth components and API services are not mocked. */
class InvitationAuthState {
  data: FixtureUser | InvalidUser | undefined = session().invalidInitialUser
    ? { detail: "Authentication credentials were not provided." }
    : undefined;
  isLoading = false;
  profile = { id: "fixture-profile", is_onboarded: session().onboarded, start_of_the_week: 1 };
  settings: { workspace?: { last_workspace_slug?: string; fallback_workspace_slug?: string } } = {};
  loader = false;
  workspaces: Record<string, { id: string; name: string; slug: string }> = {};

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  async fetchCurrentUser() {
    this.isLoading = true;
    try {
      const current = session();
      const response = await fetch("/api/users/me/", {
        headers: {
          "X-Fixture-Authenticated": String(current.authenticated),
          "X-Fixture-Email": current.email,
        },
      });
      const data = await response.json();
      const validUser = response.ok && data && typeof data.id === "string" && typeof data.email === "string";
      runInAction(() => {
        this.data = validUser ? data : undefined;
        this.profile.is_onboarded = current.onboarded;
      });
      return this.data;
    } finally {
      runInAction(() => {
        this.isLoading = false;
      });
    }
  }

  async fetchWorkspaces() {
    const response = await fetch("/api/users/me/workspaces/");
    const rows = await response.json();
    runInAction(() => {
      this.workspaces = Object.fromEntries(rows.map((workspace: { id: string }) => [workspace.id, workspace]));
    });
    return this.workspaces;
  }

  async fetchCurrentUserSettings(_refresh = false) {
    const response = await fetch("/api/users/me/settings/");
    const settings = await response.json();
    runInAction(() => {
      this.settings = settings;
    });
    return this.settings;
  }

  async simulateLogin(email: string) {
    sessionStorage.setItem(AUTH_FIXTURE_KEY, JSON.stringify({ ...session(), authenticated: true, email }));
    await this.fetchCurrentUser();
  }
}

export const invitationAuthState = new InvitationAuthState();
