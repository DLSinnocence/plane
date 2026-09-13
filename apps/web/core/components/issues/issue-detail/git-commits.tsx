/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { getCommitDate, getSafeCommitUrl } from "@/helpers/gitea";
import { GiteaService } from "@/services/integrations/gitea.service";

const giteaService = new GiteaService();
type Props = { workspaceSlug: string; projectId: string; issueId: string };

export function IssueGitCommits(props: Props) {
  // Remount pagination when navigating between issues, including in peek mode.
  return (
    <IssueGitCommitsContent key={JSON.stringify([props.workspaceSlug, props.projectId, props.issueId])} {...props} />
  );
}

function IssueGitCommitsContent({ workspaceSlug, projectId, issueId }: Props) {
  const { t } = useTranslation();
  const [pages, setPages] = useState([1]);
  const page = pages[pages.length - 1];
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    ["issue-git-commits", workspaceSlug, projectId, issueId, page],
    () => giteaService.listIssueCommits(workspaceSlug, projectId, issueId, page),
    { shouldRetryOnError: false }
  );

  return (
    <section
      className="min-w-0 space-y-3 rounded-lg border border-subtle p-3"
      aria-label={t("gitea_integration.commits")}
    >
      <h3 className="text-13 font-medium">
        {t("gitea_integration.commits")}
        {data ? ` (${data.count})` : ""}
      </h3>
      <div aria-live="polite" aria-busy={isLoading}>
        {isLoading ? (
          <p className="text-13 text-secondary">{t("gitea_integration.loading")}</p>
        ) : error ? (
          <div className="flex flex-wrap items-center gap-2 text-13">
            <p role="alert">{t("gitea_integration.load_error")}</p>
            <button
              type="button"
              className="rounded px-2 py-1 text-accent-primary disabled:opacity-50"
              disabled={isValidating}
              onClick={() => void mutate().catch(() => undefined)}
            >
              {t("gitea_integration.retry")}
            </button>
          </div>
        ) : data?.results.length === 0 ? (
          <p className="text-13 text-secondary">{t("gitea_integration.empty_commits")}</p>
        ) : (
          <ul className="min-w-0 divide-y divide-subtle">
            {data?.results.map((commit) => {
              const url = getSafeCommitUrl(commit.url);
              const date = getCommitDate(commit.committed_at);
              return (
                <li key={commit.id} className="min-w-0 space-y-1 py-2 text-13">
                  <div className="min-w-0 [overflow-wrap:anywhere] break-words">
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent-primary hover:underline"
                      >
                        <code title={commit.sha}>{commit.short_sha}</code> {commit.title}
                      </a>
                    ) : (
                      <span>
                        <code title={commit.sha}>{commit.short_sha}</code> {commit.title}
                      </span>
                    )}
                  </div>
                  <dl className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-11 [overflow-wrap:anywhere] text-secondary">
                    <div className="min-w-0">
                      <dt className="sr-only">{t("gitea_integration.author")}</dt>
                      <dd>{commit.author_name}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="sr-only">{t("gitea_integration.repository")}</dt>
                      <dd>
                        {commit.repository_name.trim() || (url ? new URL(url).hostname : "")}
                        {commit.branch ? ` · ${commit.branch}` : ""}
                      </dd>
                    </div>
                    <div>
                      <dt className="sr-only">{t("gitea_integration.committed_at")}</dt>
                      <dd>
                        {date ? (
                          <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>
                        ) : (
                          t("gitea_integration.unknown_date")
                        )}
                      </dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {(pages.length > 1 || data?.next_page != null) && (
        <nav className="flex flex-wrap items-center justify-between gap-2" aria-label={t("gitea_integration.commits")}>
          <button
            type="button"
            className="rounded border border-subtle px-3 py-1 text-13 disabled:opacity-50"
            disabled={pages.length === 1 || isLoading}
            onClick={() => setPages((current) => current.slice(0, -1))}
          >
            {t("gitea_integration.previous")}
          </button>
          <button
            type="button"
            className="rounded border border-subtle px-3 py-1 text-13 disabled:opacity-50"
            disabled={isLoading || Boolean(error) || data?.next_page == null}
            onClick={() => {
              const nextPage = data?.next_page;
              if (nextPage != null) setPages((current) => [...current, nextPage]);
            }}
          >
            {t("gitea_integration.next")}
          </button>
        </nav>
      )}
    </section>
  );
}
