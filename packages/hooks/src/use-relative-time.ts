/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useTranslation } from "@plane/i18n";
import { calculateTimeAgo, calculateTimeAgoShort } from "@plane/utils";

/** Subscribe relative dates to the app's chosen language, including live switches. */
export function useRelativeTime() {
  const { currentLocale } = useTranslation();
  return {
    calculateTimeAgo: (time: string | number | Date | null) => calculateTimeAgo(time, currentLocale),
    calculateTimeAgoShort: (time: string | number | Date | null) => calculateTimeAgoShort(time, currentLocale),
  };
}
