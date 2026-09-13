/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { expect, test, type Page } from "@playwright/test";
import type { IssueGitCommit, IssueGitCommitsResponse } from "@plane/types";

const label = (key: string) => `gitea_integration.${key}`;
const commit: IssueGitCommit = {
  id: "commit-1",
  sha: "1234567890abcdef",
  short_sha: "1234567",
  title: "DEMO-42: Ship integration",
  author_name: "Ada Example",
  committed_at: "2026-01-02T03:04:05Z",
  url: "https://gitea.example.test/engineering/demo/commit/1234567890abcdef",
  repository_name: "engineering/demo",
  branch: "main",
};

async function mockCommits(page: Page, response: (page: number) => IssueGitCommitsResponse | null) {
  const pages: number[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    expect(request.method()).toBe("GET");
    expect(url.pathname).toBe("/api/workspaces/workspace/projects/project/issues/issue/git-commits/");
    expect([...url.searchParams.keys()]).toEqual(["page"]);
    const pageNumber = Number(url.searchParams.get("page"));
    pages.push(pageNumber);
    const json = response(pageNumber);
    await route.fulfill(json ? { json } : { status: 500, json: { error: "fixture-provider-secret" } });
  });
  return pages;
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

for (const presentation of ["list", "menu"] as const) {
  test.describe(presentation, () => {
    async function openFixture(page: Page) {
      await page.goto(presentation === "menu" ? "/?git-commits-menu" : "/?git-commits");
      if (presentation === "menu") {
        await page.getByTestId("detail-actions").locator('button[aria-haspopup="menu"]').click();
        await page.getByRole("menuitem", { name: label("commits"), exact: true }).click();
      }
    }

    test("commit metadata renders safe external links and unsafe URLs remain text", async ({ page }) => {
      const unsafeUrls = [
        "javascript:alert(1)",
        "data:text/html,hello",
        "//evil.example.test/commit",
        "https://user:secret@example.test/commit",
      ];
      const commits = [
        commit,
        ...unsafeUrls.map((url, index) => ({
          ...commit,
          id: `unsafe-${index}`,
          short_sha: `unsafe${index}`,
          title: `Unsafe URL ${index}`,
          url,
          committed_at: "not-a-date",
        })),
      ];
      const pages = await mockCommits(page, () => ({ results: commits, count: commits.length, next_page: null }));
      await openFixture(page);
      await expect(page.getByRole("heading", { name: `${label("commits")} (5)`, exact: true })).toBeVisible();
      const link = page.getByRole("link", { name: "1234567 DEMO-42: Ship integration" });
      await expect(link).toHaveAttribute("href", commit.url);
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
      await expect(page.locator("time")).toHaveAttribute("datetime", "2026-01-02T03:04:05.000Z");
      await expect(page.getByText("Ada Example", { exact: true })).toHaveCount(5);
      await expect(page.getByText("engineering/demo · main", { exact: true })).toHaveCount(5);
      await expect(page.getByText(label("unknown_date"), { exact: true })).toHaveCount(4);
      await Promise.all(
        unsafeUrls.flatMap((_, index) => [
          expect(page.getByText(`unsafe${index} Unsafe URL ${index}`, { exact: true })).toBeVisible(),
          expect(page.getByRole("link", { name: `unsafe${index} Unsafe URL ${index}` })).toHaveCount(0),
        ])
      );
      await expect(page.getByRole("link")).toHaveCount(1);
      expect(pages).toEqual([1]);
    });

    test("failed commit loading offers explicit retry and an empty response has no pagination", async ({ page }) => {
      let attempts = 0;
      const pages = await mockCommits(page, () =>
        ++attempts === 1 ? null : { results: [], count: 0, next_page: null }
      );
      await openFixture(page);
      await expect(page.getByRole("alert")).toHaveText(label("load_error"));
      await expect(page.getByText("fixture-provider-secret")).toHaveCount(0);
      expect(pages).toEqual([1]);
      await page.getByRole("button", { name: label("retry"), exact: true }).click();
      await expect(page.getByText(label("empty_commits"), { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: `${label("commits")} (0)`, exact: true })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByRole("navigation")).toHaveCount(0);
      expect(pages).toEqual([1, 1]);
    });

    test("one work item displays links reported from multiple repositories with hostname fallback", async ({
      page,
    }) => {
      await mockCommits(page, () => ({
        results: [
          commit,
          {
            ...commit,
            id: "other-repo",
            short_sha: "abcdef1",
            title: "OTHER-456 and PROJ-123",
            repository_name: "",
            url: "https://another-git.example.test/custom/commit/abcdef1",
            branch: "feature",
          },
        ],
        count: 2,
        next_page: null,
      }));
      await openFixture(page);
      await expect(page.getByText("engineering/demo · main", { exact: true })).toBeVisible();
      await expect(page.getByText("another-git.example.test · feature", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "abcdef1 OTHER-456 and PROJ-123" })).toHaveAttribute(
        "href",
        "https://another-git.example.test/custom/commit/abcdef1"
      );
    });

    test("later page error keeps previous navigation and retries the failed page", async ({ page }) => {
      let fail = true;
      const pages = await mockCommits(page, (number) =>
        number === 1
          ? { results: [commit], count: 2, next_page: 2 }
          : fail
            ? null
            : { results: [{ ...commit, id: "second", title: "Second page" }], count: 2, next_page: null }
      );
      await openFixture(page);
      await page.getByRole("button", { name: label("next"), exact: true }).click();
      await expect(page.getByRole("alert")).toHaveText(label("load_error"));
      await expect(page.getByRole("button", { name: label("previous"), exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: label("next"), exact: true })).toBeDisabled();
      fail = false;
      await page.getByRole("button", { name: label("retry"), exact: true }).click();
      await expect(page.getByRole("link", { name: "1234567 Second page" })).toBeVisible();
      expect(pages).toEqual([1, 2, 2]);
    });

    test("pagination follows next_page and previous returns to earlier commits", async ({ page }) => {
      const pages = await mockCommits(page, (pageNumber) =>
        pageNumber === 1
          ? { results: [commit], count: 2, next_page: 3 }
          : {
              results: [{ ...commit, id: "commit-2", short_sha: "abcdef0", title: "DEMO-42: Follow-up" }],
              count: 2,
              next_page: null,
            }
      );
      await openFixture(page);
      const previous = page.getByRole("button", { name: label("previous"), exact: true });
      const next = page.getByRole("button", { name: label("next"), exact: true });
      await expect(previous).toBeDisabled();
      await next.click();
      await expect(page.getByRole("link", { name: "abcdef0 DEMO-42: Follow-up" })).toBeVisible();
      await expect(page.getByRole("link", { name: "1234567 DEMO-42: Ship integration" })).toHaveCount(0);
      await expect(next).toBeDisabled();
      await previous.click();
      await expect(page.getByRole("link", { name: "1234567 DEMO-42: Ship integration" })).toBeVisible();
      await expect(previous).toBeDisabled();
      expect(pages.slice(0, 2)).toEqual([1, 3]);
      expect(pages.every((number) => number === 1 || number === 3)).toBe(true);
    });
  });
}
