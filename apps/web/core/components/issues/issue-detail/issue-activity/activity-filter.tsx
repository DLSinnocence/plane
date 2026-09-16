/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { FilterOutline, TickOutline } from "@makeplane/propel/icons";
// plane imports
import type { TActivityFilters, TActivityFilterOption } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { PopoverMenu } from "@plane/ui";
// helper
import { cn } from "@plane/utils";
// constants

type TActivityFilter = {
  selectedFilters: TActivityFilters[];
  filterOptions: TActivityFilterOption[];
};

export const ActivityFilter = observer(function ActivityFilter(props: TActivityFilter) {
  const { selectedFilters = [], filterOptions } = props;

  // hooks
  const { t } = useTranslation();

  return (
    <PopoverMenu
      popoverClassName="w-auto"
      buttonClassName="relative rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent-strong"
      button={
        <span className="flex size-7 items-center justify-center rounded-sm text-secondary hover:bg-layer-1">
          <FilterOutline className="size-4" aria-hidden="true" />
          <span className="sr-only">{t("common.filters")}</span>
          {selectedFilters.length < filterOptions.length && (
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-accent-primary" />
          )}
        </span>
      }
      panelClassName="p-2 rounded-md border border-subtle bg-surface-1"
      data={filterOptions}
      keyExtractor={(item) => item.key}
      render={(item) => (
        <button
          type="button"
          key={item.key}
          aria-pressed={item.isSelected}
          disabled={item.isSelected && selectedFilters.length === 1}
          className="flex w-full cursor-pointer items-center gap-2 rounded-xs p-1 px-2 text-13 transition-all hover:bg-layer-1 focus-visible:outline-accent-strong disabled:cursor-default"
          onClick={item.onClick}
        >
          <span
            aria-hidden="true"
            className={cn(
              "flex h-3 w-3 flex-shrink-0 items-center justify-center rounded-xs bg-surface-2 transition-all",
              {
                "bg-accent-primary text-on-color": item.isSelected,
                "bg-layer-1 text-placeholder": item.isSelected && selectedFilters.length === 1,
                "bg-surface-2": !item.isSelected,
              }
            )}
          >
            {item.isSelected && <TickOutline className="h-2.5 w-2.5" />}
          </span>
          <span className={cn("whitespace-nowrap", item.isSelected ? "text-primary" : "text-secondary")}>
            {t(item.labelTranslationKey)}
          </span>
        </button>
      )}
    />
  );
});
