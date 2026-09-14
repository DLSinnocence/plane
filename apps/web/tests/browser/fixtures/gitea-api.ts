/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { expect, type Page } from "@playwright/test";
import type { GiteaConfig, GiteaHooks } from "@plane/types";

// Inert transport fixtures; production Python/Git generation is covered by API tests.
export const generatedHooks: GiteaHooks = {
  pre_receive: {
    filename: "pre-receive",
    content: "#!/usr/bin/env python3\n# pre-receive fixture\nSECRET = 'fixture-hook-secret'\n",
  },
  post_receive: {
    filename: "post-receive",
    content: "#!/usr/bin/env python3\n# post-receive fixture\nSECRET = 'fixture-hook-secret'\n",
  },
};
export const config: GiteaConfig = {
  enabled: true,
  has_secret: true,
  validation_url: "https://plane.example.test/api/integrations/gitea/workspace/validate/",
  commits_url: "https://plane.example.test/api/integrations/gitea/workspace/commits/",
  lookup_url: "https://plane.example.test/api/integrations/gitea/workspace/work-items/{identifier}/",
  issue_url_template: "https://plane.example.test/api/integrations/gitea/workspace/work-items/{identifier}/",
};

export async function mockGiteaApi(page: Page, initial: GiteaConfig = config) {
  const requests: { method: string; pathname: string; body: unknown }[] = [];
  const configs = new Map<string, GiteaConfig>();
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postDataJSON();
    requests.push({ method, pathname, body });
    const match = pathname.match(/^\/api\/workspaces\/(workspace|other)\/integrations\/gitea\/(.*)$/);
    if (!match) throw new Error(`Unexpected fixture API path: ${pathname}`);
    const [, workspace, suffix] = match;
    const current = configs.get(workspace) ?? { ...initial };
    configs.set(workspace, current);
    if (!suffix && method === "GET") {
      await route.fulfill({ json: current });
    } else if (!suffix && method === "PATCH") {
      expect(Object.keys(body)).toEqual(["enabled"]);
      const updated = { ...current, enabled: body.enabled, has_secret: current.has_secret || body.enabled };
      configs.set(workspace, updated);
      await route.fulfill({ json: updated });
    } else if (suffix === "hooks/" && method === "POST") {
      expect(body).toEqual({});
      await route.fulfill({ json: generatedHooks });
    } else if (suffix === "rotate-token/" && method === "POST") {
      expect(body).toEqual({});
      await route.fulfill({ json: current });
    } else {
      await route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
      throw new Error(`Unexpected fixture API request: ${method} ${pathname}`);
    }
  });
  return requests;
}

export async function expectNoStoredSecret(page: Page, secret: string) {
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(JSON.stringify(storage)).not.toContain(secret);
}
