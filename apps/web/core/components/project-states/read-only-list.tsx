/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useTranslation } from "@plane/i18n";
import type { IState } from "@plane/types";

type Props = { groupedStates: Record<string, IState[]> };

/** No editing callbacks: platform-managed definitions are read-only, including for admins. */
export function ReadOnlyStateList({ groupedStates }: Props) {
  const { t } = useTranslation();
  return (
    <section className="space-y-5" aria-label={t("project_settings.states.heading")}>
      <p className="text-13 text-secondary">{t("workflows.fixed_states_description")}</p>
      {Object.entries(groupedStates).map(([group, states]) => (
        <div key={group} className="space-y-2 rounded-sm border border-subtle bg-surface-2 p-3">
          <h3 className="text-14 font-medium capitalize">{group}</h3>
          <ul className="space-y-2">
            {states.map((state) => (
              <li
                key={state.id}
                className="flex items-center gap-3 rounded-sm border border-subtle bg-surface-1 px-3.5 py-3"
              >
                <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: state.color }} aria-hidden />
                <div>
                  <h4 className="text-13 font-medium">{state.name}</h4>
                  {state.description && <p className="text-11 text-secondary">{state.description}</p>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
