/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_LIST_NESTING_LEVEL } from "../components/issues/issue-layouts/list/hierarchy";

const RETRY_DELAYS = [1000, 2000, 4000];

type TExpandedSubIssues = {
  workspaceSlug: string | undefined;
  projectId: string | null | undefined;
  issueId: string;
  subIssueCount: number | undefined;
  nestingLevel: number;
  isEpic?: boolean;
  fetchSubIssues: (workspaceSlug: string, projectId: string, issueId: string) => Promise<unknown>;
};

type TLoadState = { key: string; status: "loading" | "loaded" | "error" };

/** Expansion is a read operation and must not depend on work item edit permissions. */
export const useExpandedSubIssues = ({
  workspaceSlug,
  projectId,
  issueId,
  subIssueCount,
  nestingLevel,
  isEpic = false,
  fetchSubIssues,
}: TExpandedSubIssues) => {
  const canExpand = !isEpic && nestingLevel < MAX_LIST_NESTING_LEVEL;
  const [isExpanded, setExpanded] = useState(canExpand);
  const [loadState, setLoadState] = useState<TLoadState>();
  const [retryVersion, setRetryVersion] = useState(0);
  const requestRef = useRef<{ key: string; promise: Promise<unknown> } | undefined>(undefined);
  const key = JSON.stringify([workspaceSlug, projectId, issueId, subIssueCount]);
  const shouldLoad = Boolean(isExpanded && canExpand && workspaceSlug && projectId && issueId && subIssueCount);
  const retry = useCallback(() => setRetryVersion((version) => version + 1), []);

  useEffect(() => {
    // Counts can return to an earlier value after deletion/creation. Only reuse
    // the current snapshot, and invalidate it even when the parent becomes a leaf.
    if (requestRef.current?.key !== key) requestRef.current = undefined;
    if (!shouldLoad || !workspaceSlug || !projectId) return;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryCount = 0;

    const load = async () => {
      setLoadState({ key, status: "loading" });
      let request = requestRef.current?.promise;
      if (!request) {
        // Keep the promise so a new effect can observe an already pending request.
        // A Set of requested keys loses that subscription after collapse/reopen.
        request = Promise.resolve().then(() => fetchSubIssues(workspaceSlug, projectId, issueId));
        requestRef.current = { key, promise: request };
        void request.catch(() => {
          if (requestRef.current?.promise === request) requestRef.current = undefined;
        });
      }
      try {
        await request;
        if (!disposed) setLoadState({ key, status: "loaded" });
      } catch (error: unknown) {
        if (disposed) return;
        if (retryCount < RETRY_DELAYS.length) {
          retryTimer = setTimeout(() => void load(), RETRY_DELAYS[retryCount++]);
        } else {
          setLoadState({ key, status: "error" });
          console.error("Unable to load expanded sub-work items:", error);
        }
      }
    };

    void load();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
    };
  }, [shouldLoad, workspaceSlug, projectId, issueId, key, fetchSubIssues, retryVersion]);

  return {
    isExpanded: canExpand && isExpanded && Boolean(subIssueCount),
    setExpanded,
    isLoading: shouldLoad && (loadState?.key !== key || loadState.status === "loading"),
    hasError: shouldLoad && loadState?.key === key && loadState.status === "error",
    retry,
  };
};
