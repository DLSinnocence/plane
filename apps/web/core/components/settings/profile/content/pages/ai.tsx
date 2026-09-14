/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import { useCallback, useEffect, useRef, useState } from "react";
import { Combobox } from "@headlessui/react";
import { observer } from "mobx-react";
import { useTranslation } from "@plane/i18n";
import { ComboDropDown, Input } from "@plane/ui";
import { Button } from "@plane/propel/button";
import { buildAISettingsInput } from "@/helpers/agent-settings";
import type { AIProvider, AISettings } from "@/helpers/agent-settings";
import { getAISettings, saveAISettings, disconnectAISettings, fetchAIModels } from "@/services/agent.service";
import type { AIModelOption } from "@/services/agent.service";
import { useUser } from "@/hooks/store/user";

const emptySettings: AISettings = {
  provider: "openai",
  base_url: "",
  model: "",
  has_api_key: false,
  supports_images: false,
};
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
  const [models, setModels] = useState<AIModelOption[]>([]);
  const [fetching, setFetching] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState("");
  // Selection metadata only changes on an explicit selection, never when a list arrives.
  const [selectedModel, setSelectedModel] = useState<AIModelOption | null>(null);
  const controller = useRef<AbortController | null>(null);
  const modelController = useRef<AbortController | null>(null);
  const invalidateModels = useCallback(() => {
    modelController.current?.abort();
    modelController.current = null;
    setFetching(false);
    setFetched(false);
    setModels([]);
    setSelectedModel(null);
    setModelError(null);
    setTruncated(false);
    setQuery("");
    setSaved(false);
  }, []);
  const load = useCallback(() => {
    controller.current?.abort();
    invalidateModels();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError(null);
    setApiKey("");
    void getAISettings(request.signal)
      .then((value) => {
        if (request.signal.aborted) return undefined;
        setSettings(value);
        setSelectedModel(value.model ? { id: value.model, name: value.model, vision: null, tools: null } : null);
        return undefined;
      })
      .catch((requestError: unknown) => {
        if (!request.signal.aborted) setError(requestError instanceof Error ? requestError.message : "");
      })
      .finally(() => {
        if (!request.signal.aborted) setLoading(false);
      });
  }, [invalidateModels]);
  useEffect(() => {
    load();
    return () => {
      controller.current?.abort();
      modelController.current?.abort();
    };
  }, [load]);
  const changeDestination = (patch: Partial<AISettings>) => {
    invalidateModels();
    setSettings((previous) => ({ ...previous, ...patch, model: "", supports_images: false }));
  };
  const discover = async () => {
    modelController.current?.abort();
    const request = new AbortController();
    modelController.current = request;
    setFetching(true);
    setModelError(null);
    setFetched(false);
    setModels([]);
    setTruncated(false);
    try {
      const result = await fetchAIModels(
        { provider: settings.provider, base_url: settings.base_url, api_key: apiKey },
        request.signal
      );
      if (request.signal.aborted || modelController.current !== request) return;
      setModels(result.models);
      setTruncated(result.truncated);
      setFetched(true);
    } catch (requestError: unknown) {
      if (!request.signal.aborted) setModelError(requestError instanceof Error ? requestError.message : "");
    } finally {
      if (!request.signal.aborted) setFetching(false);
    }
  };
  const selectModel = (id: string) => {
    const model = models.find((option) => option.id === id) ?? (selectedModel?.id === id ? selectedModel : null);
    if (!model) return;
    setSelectedModel(model);
    setSettings((previous) => ({ ...previous, model: id, supports_images: model.vision ?? false }));
    setSaved(false);
    setQuery("");
  };
  const mutate = async (disconnect: boolean) => {
    if (saving || loading || (!disconnect && (fetching || !settings.model))) return;
    modelController.current?.abort();
    setFetching(false);
    const request = new AbortController();
    controller.current = request;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      if (disconnect) {
        await disconnectAISettings(request.signal);
        if (request.signal.aborted) return;
        setSettings(emptySettings);
        invalidateModels();
      } else {
        const value = await saveAISettings(
          buildAISettingsInput(
            settings.provider,
            settings.base_url,
            settings.model,
            apiKey,
            settings.supports_images ?? false
          ),
          request.signal
        );
        if (request.signal.aborted) return;
        setSettings(value);
      }
      setApiKey("");
      setSaved(true);
    } catch (requestError: unknown) {
      if (!request.signal.aborted) setError(requestError instanceof Error ? requestError.message : "");
    } finally {
      if (!request.signal.aborted) setSaving(false);
    }
  };
  const options =
    selectedModel && !models.some((model) => model.id === selectedModel.id) ? [selectedModel, ...models] : models;
  const search = query.trim().toLocaleLowerCase();
  const filteredModels = options.filter((model) => `${model.id}\n${model.name}`.toLocaleLowerCase().includes(search));
  const caption =
    selectedModel?.vision === true
      ? "vision_detected"
      : selectedModel?.vision === false
        ? "vision_unavailable"
        : "vision_unknown";
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
              onChange={(event) => changeDestination({ provider: event.target.value as AIProvider })}
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
              onChange={(event) => changeDestination({ base_url: event.target.value })}
              placeholder={settings.provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com"}
            />
            <span className="text-body-xs-regular text-secondary">{t("account_settings.ai.base_url_help")}</span>
          </label>
          <label className="flex flex-col gap-2">
            {t("account_settings.ai.api_key")}
            <Input
              type="password"
              autoComplete="new-password"
              value={apiKey}
              disabled={saving}
              onChange={(event) => {
                setApiKey(event.target.value);
                changeDestination({});
              }}
            />
            <span className="text-body-xs-regular text-secondary">
              {t(settings.has_api_key ? "account_settings.ai.key_saved" : "account_settings.ai.key_missing")}
            </span>
          </label>
          <div>
            <Button
              type="button"
              variant="secondary"
              loading={fetching}
              disabled={saving || fetching}
              onClick={() => void discover()}
            >
              {t("account_settings.ai.fetch_models")}
            </Button>
            {fetching && (
              <p role="status" className="mt-2 text-body-sm-regular text-secondary">
                {t("account_settings.ai.models_loading")}
              </p>
            )}
            {modelError !== null && (
              <p role="alert" className="mt-2 text-body-sm-regular">
                {t("account_settings.ai.models_error")} {modelError}
              </p>
            )}
            {fetched && models.length === 0 && (
              <p role="status" className="mt-2 text-body-sm-regular text-secondary">
                {t("account_settings.ai.models_empty")}
              </p>
            )}
            {truncated && (
              <p role="status" className="mt-2 text-body-sm-regular text-secondary">
                {t("account_settings.ai.models_truncated")}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <span id="ai-model-label">{t("account_settings.ai.model")}</span>
            <ComboDropDown
              as="div"
              className="relative"
              value={settings.model}
              onChange={selectModel}
              disabled={saving || fetching || options.length === 0}
              button={
                <button
                  type="button"
                  aria-labelledby="ai-model-label ai-model-value"
                  className="flex w-full items-center justify-between rounded border border-subtle bg-surface-1 p-2 text-left disabled:opacity-50"
                >
                  <span id="ai-model-value">
                    {selectedModel?.name || settings.model || t("account_settings.ai.model_select")}
                  </span>
                  <span aria-hidden="true">⌄</span>
                </button>
              }
            >
              <Combobox.Options
                modal={false}
                className="absolute z-10 mt-1 w-full rounded border border-subtle bg-surface-1 p-2 shadow-raised-200"
              >
                <Combobox.Input
                  aria-label={t("account_settings.ai.model_search")}
                  placeholder={t("account_settings.ai.model_search")}
                  className="mb-2 w-full rounded border border-subtle bg-surface-2 p-2"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  displayValue={() => query}
                />
                <div className="max-h-60 overflow-y-auto">
                  {filteredModels.map((model) => (
                    <Combobox.Option
                      key={model.id}
                      value={model.id}
                      className={({ active }) =>
                        `cursor-pointer rounded p-2 ${active ? "bg-layer-transparent-hover" : ""}`
                      }
                    >
                      {({ selected }) => (
                        <>
                          <div className="flex justify-between gap-2">
                            <span className="break-all">{model.name}</span>
                            {selected && <span aria-hidden="true">✓</span>}
                          </div>
                          {model.name !== model.id && (
                            <p className="text-body-xs-regular break-all text-secondary">{model.id}</p>
                          )}
                          <p className="text-body-xs-regular text-secondary">
                            {t(
                              model.vision === true
                                ? "account_settings.ai.capability_vision"
                                : model.vision === false
                                  ? "account_settings.ai.capability_no_vision"
                                  : "account_settings.ai.capability_vision_unknown"
                            )}{" "}
                            ·{" "}
                            {t(
                              model.tools === true
                                ? "account_settings.ai.capability_tools"
                                : model.tools === false
                                  ? "account_settings.ai.capability_no_tools"
                                  : "account_settings.ai.capability_tools_unknown"
                            )}
                          </p>
                        </>
                      )}
                    </Combobox.Option>
                  ))}
                  {filteredModels.length === 0 && (
                    <p role="status" className="p-2 text-secondary">
                      {t("account_settings.ai.models_no_match")}
                    </p>
                  )}
                </div>
              </Combobox.Options>
            </ComboDropDown>
          </div>
          <div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.supports_images ?? false}
                disabled={saving || !settings.model || selectedModel?.vision != null}
                aria-describedby="ai-vision-help"
                onChange={(event) => {
                  setSettings({ ...settings, supports_images: event.target.checked });
                  setSaved(false);
                }}
              />
              {t("account_settings.ai.supports_images")}
            </label>
            <p id="ai-vision-help" className="mt-2 text-body-xs-regular text-secondary">
              {t(`account_settings.ai.${caption}`)}
            </p>
          </div>
          <div className="flex gap-3">
            <Button type="submit" loading={saving} disabled={saving || fetching || !settings.model}>
              {t("account_settings.ai.save")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={saving || !settings.has_api_key}
              onClick={() => void mutate(true)}
            >
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
