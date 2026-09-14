/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import { ExternalLink } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { agentToolLabelKeys, agentWorkItemHref } from "@/helpers/agent-chat";
import type { AgentToolProgress } from "@/helpers/agent-chat";

export function AgentToolDetails({ tools, workspaceSlug }: { tools: AgentToolProgress[]; workspaceSlug: string }) {
  const { t } = useTranslation();
  if (!tools.length) return null;
  return (
    <div className="agent-tool-list mt-3 space-y-2" aria-label={t("account_settings.ai.tool_calls")}>
      {tools.map((tool) => {
        const labels = agentToolLabelKeys(tool);
        const details = tool.details;
        return (
          <details
            key={tool.key}
            data-tool-id={tool.key}
            className="agent-tool-detail rounded-lg border border-subtle bg-layer-1"
          >
            <summary className="cursor-pointer px-3 py-2 text-body-xs-medium text-secondary">
              <span role="status">
                {t(labels.action)} · {t(labels.entity)}: {t(`account_settings.ai.tool_${tool.status}`)}
              </span>
            </summary>
            <div className="space-y-3 border-t border-subtle p-3 text-body-xs-regular">
              {details?.input && (
                <section aria-label={t("account_settings.ai.tool_input")}>
                  <p className="mb-1 font-medium text-secondary">{t("account_settings.ai.tool_input")}</p>
                  <pre className="agent-tool-payload max-h-48 overflow-auto rounded bg-surface-1 p-2 text-primary">
                    {details.input}
                  </pre>
                </section>
              )}
              {details?.output && (
                <section aria-label={t("account_settings.ai.tool_output")}>
                  <p className="mb-1 font-medium text-secondary">{t("account_settings.ai.tool_output")}</p>
                  <pre className="agent-tool-payload max-h-64 overflow-auto rounded bg-surface-1 p-2 text-primary">
                    {details.output}
                  </pre>
                </section>
              )}
              {!details?.output && (
                <p className="text-secondary">
                  {t(
                    tool.status === "running"
                      ? "account_settings.ai.tool_waiting"
                      : "account_settings.ai.tool_no_details"
                  )}
                </p>
              )}
              {tool.status === "complete" && Boolean(details?.workItems?.length) && (
                <ul className="space-y-1" aria-label={t("account_settings.ai.related_work_items")}>
                  {details?.workItems?.map((item) => (
                    <li key={`${item.projectId}:${item.id}`}>
                      <a
                        className="inline-flex max-w-full items-center gap-1 break-words text-accent-primary underline"
                        href={agentWorkItemHref(workspaceSlug, item)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {item.identifier
                          ? `${item.identifier} · ${item.name}`
                          : item.name || t("account_settings.ai.open_work_item")}
                        <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              {details?.truncated && <p className="text-secondary">{t("account_settings.ai.tool_truncated")}</p>}
            </div>
          </details>
        );
      })}
    </div>
  );
}
