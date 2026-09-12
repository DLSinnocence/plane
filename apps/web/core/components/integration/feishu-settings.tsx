/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { getFeishuDeliveryLabelKey, prepareFeishuConfiguration } from "@/helpers/feishu";
import { useMember } from "@/hooks/store/use-member";
import { FeishuService } from "@/services/integrations/feishu.service";

const service = new FeishuService();
const options = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  refreshInterval: 0,
  shouldRetryOnError: false,
};
const inputClass = "w-full rounded-md border border-subtle bg-surface-1 px-3 py-2 text-13";
const buttonClass = "rounded-md border border-subtle px-3 py-2 text-13 disabled:cursor-not-allowed disabled:opacity-50";

export const FeishuSettings = observer(function FeishuSettings({ workspaceSlug }: { workspaceSlug: string }) {
  const { t } = useTranslation();
  const { workspace } = useMember();
  const config = useSWR(["feishu-config", workspaceSlug], () => service.getConfiguration(workspaceSlug), options);
  const recipients = useSWR(["feishu-recipients", workspaceSlug], () => service.getRecipients(workspaceSlug), options);
  const deliveries = useSWR(["feishu-deliveries", workspaceSlug], () => service.getDeliveries(workspaceSlug), options);
  const members = useSWR(
    ["feishu-workspace-members", workspaceSlug],
    () => workspace.fetchWorkspaceMembers(workspaceSlug),
    options
  );
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (config.data) {
      setAppId(config.data.app_id);
      setEnabled(config.data.enabled);
      setSecret("");
    }
  }, [config.data]);

  const activeMembers = (workspace.getWorkspaceMemberIds(workspaceSlug) ?? [])
    .map((id) => workspace.getWorkspaceMemberDetails(id))
    .filter((member) => member?.is_active && member.member);
  const memberName = (id: string) => workspace.getWorkspaceMemberDetails(id)?.member.display_name || id;
  const appChanged = !!config.data && appId.trim() !== config.data.app_id;
  const configDirty = appChanged || enabled !== config.data?.enabled || !!secret.trim();

  async function run(action: () => Promise<void>, message: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(message);
    } catch {
      // Do not render or log credential-bearing server responses.
      setError(t("feishu_integration.action_error"));
    } finally {
      setBusy(false);
    }
  }

  async function saveConfiguration() {
    if (!config.data || busy) return;
    const result = prepareFeishuConfiguration(config.data, appId, secret, enabled);
    if (result.error) {
      setError(t(`feishu_integration.${result.error}`));
      return;
    }
    await run(async () => {
      const updated = await service.updateConfiguration(workspaceSlug, result.data);
      setSecret("");
      await config.mutate(updated, false);
      await recipients.mutate();
    }, t("feishu_integration.saved"));
  }

  return (
    <section aria-labelledby="feishu-title" className="space-y-5 border-b border-subtle py-6">
      <div>
        <h4 id="feishu-title" className="text-16 font-medium">
          {t("feishu_integration.name")}
        </h4>
        <p className="mt-1 text-13 text-secondary">{t("feishu_integration.description")}</p>
      </div>
      {error && (
        <p role="alert" className="text-13 text-danger-primary">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-13">
          {notice}
        </p>
      )}
      {config.error ? (
        <div role="alert" className="space-y-2 text-13">
          <p>{t("feishu_integration.load_error")}</p>
          <button className={buttonClass} onClick={() => void config.mutate()}>
            {t("feishu_integration.retry")}
          </button>
        </div>
      ) : !config.data ? (
        <p role="status">{t("integrations.loading")}</p>
      ) : (
        <form
          className="max-w-xl space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void saveConfiguration();
          }}
        >
          <fieldset disabled={busy} className="space-y-4">
            <label className="block space-y-1 text-13">
              <span>{t("feishu_integration.app_id")}</span>
              <input
                className={inputClass}
                value={appId}
                autoComplete="off"
                onChange={(event) => setAppId(event.target.value)}
              />
            </label>
            <label className="block space-y-1 text-13">
              <span>{t("feishu_integration.app_secret")}</span>
              <input
                type="password"
                className={inputClass}
                value={secret}
                autoComplete="new-password"
                placeholder={t(
                  config.data.has_app_secret
                    ? "feishu_integration.secret_stored"
                    : "feishu_integration.secret_placeholder"
                )}
                onChange={(event) => setSecret(event.target.value)}
              />
              <span className="block text-secondary">{t("feishu_integration.secret_help")}</span>
            </label>
            <label className="flex items-center gap-2 text-13">
              <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
              {t("feishu_integration.enabled")}
            </label>
            <button type="submit" className={buttonClass} disabled={busy || !configDirty}>
              {t(busy ? "feishu_integration.working" : "feishu_integration.save")}
            </button>
          </fieldset>
        </form>
      )}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h5 className="text-14 font-medium">{t("feishu_integration.identification")}</h5>
          <button
            className={buttonClass}
            disabled={recipients.isValidating || members.isValidating}
            onClick={() => {
              void recipients.mutate();
              void members.mutate();
            }}
          >
            {t("feishu_integration.refresh")}
          </button>
        </div>
        <p className="text-13 text-secondary">{t("feishu_integration.identification_help")}</p>
        {configDirty && <p className="text-13">{t("feishu_integration.save_first")}</p>}
        {recipients.error || members.error ? (
          <p role="alert" className="text-13">
            {t("feishu_integration.recipients_error")}
          </p>
        ) : recipients.isLoading || members.isLoading ? (
          <p role="status">{t("integrations.loading")}</p>
        ) : (
          <ul className="divide-y divide-subtle">
            {activeMembers.map((member) => {
              if (!member) return null;
              const recipient = recipients.data?.find((candidate) => candidate.user_id === member.member.id);
              return (
                <li key={member.member.id} className="flex flex-wrap items-center gap-3 py-3 text-13">
                  <span className="min-w-32">{member.member.display_name}</span>
                  <span>
                    {t("feishu_integration.sso_mobile")}:{" "}
                    {recipient?.has_mobile
                      ? recipient.mobile_hint || t("feishu_integration.mobile_available")
                      : t("feishu_integration.mobile_missing")}
                  </span>
                  <button
                    className={buttonClass}
                    disabled={busy || configDirty || !config.data?.enabled || !!config.error || !recipient?.has_mobile}
                    onClick={() =>
                      void run(async () => {
                        await service.sendTest(workspaceSlug, member.member.id);
                        await deliveries.mutate();
                      }, t("feishu_integration.test_queued"))
                    }
                  >
                    {t("feishu_integration.send_test")}
                  </button>
                </li>
              );
            })}
            {activeMembers.length === 0 && (
              <li className="text-13 text-secondary">{t("feishu_integration.no_recipients")}</li>
            )}
          </ul>
        )}
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h5 className="text-14 font-medium">{t("feishu_integration.deliveries")}</h5>
          <button className={buttonClass} disabled={deliveries.isValidating} onClick={() => void deliveries.mutate()}>
            {t("feishu_integration.refresh")}
          </button>
        </div>
        <p className="text-13 text-secondary">{t("feishu_integration.delivery_help")}</p>
        {deliveries.error ? (
          <p role="alert" className="text-13">
            {t("feishu_integration.deliveries_error")}
          </p>
        ) : deliveries.isLoading ? (
          <p role="status">{t("integrations.loading")}</p>
        ) : !deliveries.data?.length ? (
          <p className="text-13">{t("feishu_integration.no_deliveries")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-13">
              <thead>
                <tr>
                  {["receiver", "issue", "status", "attempts", "created", "sent", "last_error"].map((key) => (
                    <th key={key} scope="col" className="p-2 font-medium whitespace-nowrap">
                      {t(`feishu_integration.${key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {deliveries.data.map((delivery) => (
                  <tr key={delivery.id} className="border-t border-subtle">
                    <td className="p-2">{memberName(delivery.receiver_id)}</td>
                    <td className="p-2">{delivery.issue_id || t("feishu_integration.test_card")}</td>
                    <td className="p-2">{t(getFeishuDeliveryLabelKey("status", delivery.status))}</td>
                    <td className="p-2">{delivery.attempts}</td>
                    <td className="p-2 whitespace-nowrap">{new Date(delivery.created_at).toLocaleString()}</td>
                    <td className="p-2 whitespace-nowrap">
                      {delivery.sent_at ? new Date(delivery.sent_at).toLocaleString() : "—"}
                    </td>
                    <td className="max-w-sm p-2 break-words">
                      {delivery.last_error ? t(getFeishuDeliveryLabelKey("error", delivery.last_error)) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
});
