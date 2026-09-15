/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useTranslation } from "@plane/i18n";
import { Spinner } from "@plane/ui";

type Props = {
  isLoading: boolean;
  hasError: boolean;
  onRetry: () => void;
};

export function SubIssuesLoadStatus({ isLoading, hasError, onRetry }: Props) {
  const { t } = useTranslation();
  if (!isLoading && !hasError) return null;

  return (
    <div role="status" className="flex items-center gap-2 py-2 text-12 text-secondary">
      {isLoading ? (
        <>
          <Spinner className="size-3" />
          <span>{t("loading")}</span>
        </>
      ) : (
        <>
          <span>{t("something_went_wrong")}</span>
          <button
            type="button"
            className="text-accent-primary underline"
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
          >
            {t("common.retry")}
          </button>
        </>
      )}
    </div>
  );
}
