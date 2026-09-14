/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import { memo, useMemo } from "react";
import { useTranslation } from "@plane/i18n";
import { ChatMarkdown } from "@plane/ui";
import type { ChatWorkItemReference } from "@plane/ui";
import { parseAgentContent } from "@/helpers/agent-content";

function asCodeBlock(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length), 2);
  const fence = "`".repeat(longest + 1);
  let language = "text";
  try {
    JSON.parse(text);
    language = "json";
  } catch {
    /* A tool fragment can be ordinary text. */
  }
  return `${fence}${language}\n${text}\n${fence}`;
}

export function useAgentMarkdownLabels() {
  const { t } = useTranslation();
  const copyCode = t("account_settings.ai.copy_code");
  const copied = t("account_settings.ai.copied");
  const copyFailed = t("account_settings.ai.copy_failed");
  const code = t("account_settings.ai.code");
  const openImage = t("account_settings.ai.open_image");
  return useMemo(
    () => ({ copyCode, copied, copyFailed, code, openImage }),
    [copyCode, copied, copyFailed, code, openImage]
  );
}

export const AgentMessageContent = memo(function AgentMessageContent({
  content,
  thinking = "",
  streaming = false,
  workItems,
}: {
  content: string;
  thinking?: string;
  streaming?: boolean;
  workItems?: ChatWorkItemReference[];
}) {
  const { t } = useTranslation();
  const labels = useAgentMarkdownLabels();
  const parts = useMemo(() => parseAgentContent(content, streaming), [content, streaming]);
  return (
    <div className="agent-message-content min-w-0 space-y-3">
      {thinking && (
        <details data-agent-part="native-thinking" className="agent-semantic-block rounded-lg border border-subtle">
          <summary className="cursor-pointer px-3 py-2 text-body-xs-medium text-secondary">
            {t("account_settings.ai.thinking")}
          </summary>
          <div className="max-h-80 overflow-auto border-t border-subtle p-3">
            <ChatMarkdown content={thinking} labels={labels} />
          </div>
        </details>
      )}
      {parts.map((part, index) =>
        part.kind === "text" ? (
          // eslint-disable-next-line react/no-array-index-key -- segments append in order during a stream
          <ChatMarkdown key={`text-${index}`} content={part.text} labels={labels} workItems={workItems} />
        ) : (
          <details
            // eslint-disable-next-line react/no-array-index-key -- preserve disclosure state while its text grows
            key={`${part.kind}-${index}`}
            data-agent-part={part.kind}
            className="agent-semantic-block rounded-lg border border-subtle"
          >
            <summary className="cursor-pointer px-3 py-2 text-body-xs-medium text-secondary">
              {t(
                part.kind === "thinking"
                  ? "account_settings.ai.thinking"
                  : part.kind === "tool-call"
                    ? "account_settings.ai.model_tool_call"
                    : "account_settings.ai.model_tool_result"
              )}
              {streaming && !part.complete ? ` · ${t("account_settings.ai.receiving")}` : ""}
            </summary>
            <div className="max-h-80 space-y-2 overflow-auto border-t border-subtle p-3">
              {part.kind !== "thinking" && (
                <p className="text-body-xs-regular text-secondary">{t("account_settings.ai.model_tool_fragment")}</p>
              )}
              <ChatMarkdown content={part.kind === "thinking" ? part.text : asCodeBlock(part.text)} labels={labels} />
            </div>
          </details>
        )
      )}
    </div>
  );
});
