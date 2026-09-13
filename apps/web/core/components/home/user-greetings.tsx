/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useTranslation } from "@plane/i18n";
import type { IUser } from "@plane/types";
// helpers
import { getUserGreetingDetails } from "@/helpers/user-greetings";
// hooks
import { useCurrentTime } from "@/hooks/use-current-time";

export interface IUserGreetingsView {
  user: IUser;
}

export function UserGreetingsView(props: IUserGreetingsView) {
  const { user } = props;
  const { currentTime } = useCurrentTime();
  const { t, currentLocale } = useTranslation();
  const { greeting, dateTime } = getUserGreetingDetails(currentTime, currentLocale, user?.user_timezone);
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ");

  return (
    <div className="my-6 flex flex-col items-center">
      <h2 className="text-center text-20 font-semibold">{t(`greetings.${greeting}`, { name })}</h2>
      <h5 className="flex items-center gap-2 font-medium text-placeholder">
        <div>{greeting === "morning" ? "🌤️" : greeting === "afternoon" ? "🌥️" : "🌙️"}</div>
        <div>{dateTime}</div>
      </h5>
    </div>
  );
}
