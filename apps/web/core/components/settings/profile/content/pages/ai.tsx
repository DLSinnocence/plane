/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import { useCallback, useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { useTranslation } from "@plane/i18n";
import { Input } from "@plane/ui";
import { Button } from "@plane/propel/button";
import { buildAISettingsInput } from "@/helpers/agent-settings";
import type { AIProvider, AISettings } from "@/helpers/agent-settings";
import { getAISettings, saveAISettings, disconnectAISettings } from "@/services/agent.service";
import { useUser } from "@/hooks/store/user";

const emptySettings: AISettings = { provider: "openai", base_url: "", model: "", has_api_key: false };
export const AIProfileSettings = observer(function AIProfileSettings() {
  const { data: user } = useUser();
  return user ? <AISettingsForm key={user.id} /> : null;
});
function AISettingsForm() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AISettings>(emptySettings);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(() => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError(null);
    void getAISettings(request.signal)
      .then(setSettings)
      .catch((requestError: unknown) => {
        if (!request.signal.aborted) setError(requestError instanceof Error ? requestError.message : "");
      })
      .finally(() => {
        if (!request.signal.aborted) setLoading(false);
      });
  }, []);
  useEffect(() => {
    load();
    return () => controller.current?.abort();
  }, [load]);
  const mutate = async (disconnect: boolean) => {
    const request = new AbortController();
    controller.current = request;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      if (disconnect) {
        await disconnectAISettings(request.signal);
        setSettings(emptySettings);
      } else
        setSettings(
          await saveAISettings(
            buildAISettingsInput(settings.provider, settings.base_url, settings.model, apiKey),
            request.signal
          )
        );
      setApiKey("");
      setSaved(true);
    } catch (requestError: unknown) {
      if (!request.signal.aborted) setError(requestError instanceof Error ? requestError.message : "");
    } finally {
      if (!request.signal.aborted) setSaving(false);
    }
  };
  return (
    <form
      className="flex max-w-2xl flex-col gap-5 p-6"
      onSubmit={(event) => {
        event.preventDefault();
        void mutate(false);
      }}
    >
      <div>
        <h2 className="text-h5-medium">{t("account_settings.ai.title")}</h2>
        <p className="mt-2 text-body-sm-regular text-secondary">{t("account_settings.ai.description")}</p>
      </div>
      {loading ? (
        <p role="status">{t("account_settings.ai.loading")}</p>
      ) : (
        <>
          <label className="flex flex-col gap-2">
            {t("account_settings.ai.provider")}
            <select
              className="rounded border border-subtle bg-surface-1 p-2"
              value={settings.provider}
              disabled={saving}
              onChange={(event) => setSettings({ ...settings, provider: event.target.value as AIProvider })}
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label className="flex flex-col gap-2">
            {t("account_settings.ai.base_url")}
            <Input
              type="url"
              value={settings.base_url}
              disabled={saving}
              onChange={(event) => setSettings({ ...settings, base_url: event.target.value })}
              placeholder="https://api.openai.com/v1"
            />
          </label>
          <label className="flex flex-col gap-2">
            {t("account_settings.ai.model")}
            <Input
              value={settings.model}
              required
              disabled={saving}
              onChange={(event) => setSettings({ ...settings, model: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-2">
            {t("account_settings.ai.api_key")}
            <Input
              type="password"
              autoComplete="new-password"
              value={apiKey}
              disabled={saving}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <span className="text-body-xs-regular text-secondary">
              {t(settings.has_api_key ? "account_settings.ai.key_saved" : "account_settings.ai.key_missing")}
            </span>
          </label>
          <div className="flex gap-3">
            <Button type="submit" loading={saving} disabled={saving}>
              {t("account_settings.ai.save")}
            </Button>
            <Button variant="secondary" disabled={saving || !settings.has_api_key} onClick={() => void mutate(true)}>
              {t("account_settings.ai.disconnect")}
            </Button>
          </div>
        </>
      )}
      {error !== null && (
        <div role="alert">
          {t("account_settings.ai.error")}
          <p className="my-2">{error}</p>
          <button type="button" onClick={load} disabled={saving}>
            {t("account_settings.ai.reload")}
          </button>
        </div>
      )}
      {saved && <p role="status">{t("account_settings.ai.saved")}</p>}
    </form>
  );
}
