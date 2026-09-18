import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Input } from "@plane/ui";
import { WorkspaceAIProviderCard } from "./provider-card";
import {
  createWorkspaceAIModel,
  createWorkspaceAIProvider,
  deleteWorkspaceAIModel,
  deleteWorkspaceAIProvider,
  discoverWorkspaceAIModels,
  getWorkspaceAISettings,
  updateWorkspaceAIModel,
  updateWorkspaceAIProvider,
  type WorkspaceAIProvider,
  type WorkspaceAIProviderInput,
  type WorkspaceAIProviderName,
} from "@/services/workspace-ai.service";
import type { AIModelOption } from "@/services/agent.service";

type Props = { workspaceSlug: string; canEdit: boolean };

export function WorkspaceAISettings({ workspaceSlug, canEdit }: Props) {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<WorkspaceAIProvider[]>([]);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<WorkspaceAIProviderName>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const requests = useRef(new Set<AbortController>());

  const trackRequest = () => {
    const controller = new AbortController();
    requests.current.add(controller);
    return controller;
  };
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const result = await getWorkspaceAISettings(workspaceSlug, signal ?? new AbortController().signal);
        if (!signal?.aborted && mounted.current) setProviders(result.providers);
      } catch (requestError: unknown) {
        if (!signal?.aborted && mounted.current)
          setError(requestError instanceof Error ? requestError.message : "Unable to load AI settings");
      } finally {
        if (!signal?.aborted && mounted.current) setLoading(false);
      }
    },
    [workspaceSlug]
  );

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    const pendingRequests = requests.current;
    return () => {
      mounted.current = false;
      controller.abort();
      pendingRequests.forEach((request) => request.abort());
      pendingRequests.clear();
    };
  }, [load]);

  const mutationPending = useRef(false);
  const mutate = async (action: (signal: AbortSignal) => Promise<unknown>): Promise<boolean> => {
    if (!canEdit || mutationPending.current) return false;
    mutationPending.current = true;
    const controller = trackRequest();
    setBusy(true);
    setError(null);
    try {
      await action(controller.signal);
      if (mounted.current) {
        const result = await getWorkspaceAISettings(workspaceSlug, controller.signal);
        if (!controller.signal.aborted) setProviders(result.providers);
      }
      return true;
    } catch (requestError: unknown) {
      if (mounted.current && !controller.signal.aborted)
        setError(requestError instanceof Error ? requestError.message : "Unable to save AI settings");
      return false;
    } finally {
      mutationPending.current = false;
      requests.current.delete(controller);
      if (mounted.current) setBusy(false);
    }
  };

  const providerAction = (providerId: string, data: Partial<WorkspaceAIProviderInput>) =>
    mutate((signal) => updateWorkspaceAIProvider(workspaceSlug, providerId, data, signal));
  const findProvider = (providerId: string) => providers.find((item) => item.id === providerId);
  const discover = async (
    providerId: string,
    data: { base_url: string; api_key: string }
  ): Promise<{ models: AIModelOption[]; truncated: boolean }> => {
    const current = findProvider(providerId);
    if (!current) return { models: [], truncated: false };
    const request = trackRequest();
    try {
      const result = await discoverWorkspaceAIModels(
        workspaceSlug,
        { provider: current.provider, base_url: data.base_url, api_key: data.api_key, provider_id: providerId },
        request.signal
      );
      return { models: result.models, truncated: result.truncated };
    } finally {
      requests.current.delete(request);
    }
  };

  const addProvider = () => {
    if (!name.trim()) return;
    void (async () => {
      const success = await mutate((signal) =>
        createWorkspaceAIProvider(
          workspaceSlug,
          {
            name: name.trim(),
            provider,
            base_url: baseUrl.trim() || undefined,
            api_key: apiKey || undefined,
            is_enabled: enabled,
          },
          signal
        )
      );
      if (success && mounted.current) {
        setName("");
        setBaseUrl("");
        setApiKey("");
        setEnabled(true);
      }
    })();
  };

  return (
    <div className="flex w-full flex-col gap-6">
      <div>
        <h1 className="text-h3-medium text-primary">{t("workspace_settings.settings.ai.title")}</h1>
        <p className="mt-1 text-body-sm-regular text-tertiary">{t("workspace_settings.settings.ai.description")}</p>
      </div>
      {error && (
        <div className="border-danger bg-danger/10 text-danger rounded border p-3 text-body-sm-regular" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <p role="status">{t("workspace_settings.settings.ai.loading")}</p>
      ) : (
        <>
          {providers.length === 0 && (
            <p className="text-body-sm-regular text-tertiary">{t("workspace_settings.settings.ai.no_providers")}</p>
          )}
          <div className="flex flex-col gap-4">
            {providers.map((item) => (
              <WorkspaceAIProviderCard
                key={item.id}
                provider={item}
                canEdit={canEdit}
                busy={busy}
                onProviderChange={(data) => providerAction(item.id, data)}
                onProviderDelete={async () =>
                  await mutate((signal) => deleteWorkspaceAIProvider(workspaceSlug, item.id, signal))
                }
                onModelChange={(model, data) =>
                  mutate((signal) => updateWorkspaceAIModel(workspaceSlug, item.id, model.id, data, signal))
                }
                onModelDelete={(modelId) =>
                  mutate((signal) => deleteWorkspaceAIModel(workspaceSlug, item.id, modelId, signal))
                }
                onModelCreate={(data) =>
                  mutate((signal) => createWorkspaceAIModel(workspaceSlug, item.id, data, signal))
                }
                onDiscover={(data) => discover(item.id, data)}
              />
            ))}
          </div>
          {canEdit && (
            <section className="rounded-lg border border-subtle bg-surface-1 p-5">
              <h2 className="text-h5-medium text-primary">{t("workspace_settings.settings.ai.add_provider")}</h2>
              <fieldset disabled={busy} className="mt-4 grid gap-3 md:grid-cols-2">
                <Input
                  aria-label={t("workspace_settings.settings.ai.provider_name")}
                  value={name}
                  placeholder={t("workspace_settings.settings.ai.provider_name")}
                  onChange={(event) => setName(event.target.value)}
                />
                <select
                  className="rounded border border-subtle bg-surface-1 px-3 py-2 text-body-sm-regular"
                  aria-label={t("workspace_settings.settings.ai.provider")}
                  value={provider}
                  onChange={(event) => setProvider(event.target.value as WorkspaceAIProviderName)}
                >
                  <option value="openai">{t("workspace_settings.settings.ai.openai")}</option>
                  <option value="anthropic">{t("workspace_settings.settings.ai.anthropic")}</option>
                </select>
                <Input
                  aria-label={t("workspace_settings.settings.ai.base_url")}
                  value={baseUrl}
                  placeholder={t("workspace_settings.settings.ai.base_url")}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
                <Input
                  type="password"
                  aria-label={t("workspace_settings.settings.ai.api_key")}
                  autoComplete="new-password"
                  value={apiKey}
                  placeholder={t("workspace_settings.settings.ai.api_key")}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <label className="flex items-center gap-2 text-body-sm-regular">
                  <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
                  {t("workspace_settings.settings.ai.enabled")}
                </label>
                <div className="md:text-right">
                  <Button variant="primary" disabled={busy || !name.trim()} onClick={addProvider}>
                    {t("workspace_settings.settings.ai.add_provider")}
                  </Button>
                </div>
              </fieldset>
            </section>
          )}
          {!canEdit && (
            <p className="text-body-xs-regular text-tertiary">{t("workspace_settings.settings.ai.read_only")}</p>
          )}
        </>
      )}
    </div>
  );
}
