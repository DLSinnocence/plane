import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Input } from "@plane/ui";
import type { WorkspaceAIModel, WorkspaceAIProvider, WorkspaceAIProviderName } from "@/services/workspace-ai.service";
import type { AIModelOption } from "@/services/agent.service";

type ProviderPatch = {
  name?: string;
  provider?: WorkspaceAIProviderName;
  base_url?: string;
  api_key?: string;
  is_enabled?: boolean;
};
type ModelPatch = { model?: string; supports_images?: boolean; is_enabled?: boolean; is_default?: boolean };
type Props = {
  provider: WorkspaceAIProvider;
  canEdit: boolean;
  busy: boolean;
  onProviderChange: (data: ProviderPatch) => Promise<boolean>;
  onProviderDelete: () => Promise<boolean>;
  onModelChange: (model: WorkspaceAIModel, data: ModelPatch) => Promise<boolean>;
  onModelDelete: (modelId: string) => Promise<boolean>;
  onModelCreate: (data: {
    model: string;
    supports_images: boolean;
    is_enabled: boolean;
    is_default: boolean;
  }) => Promise<boolean>;
  onDiscover: (data: { base_url: string; api_key: string }) => Promise<{ models: AIModelOption[]; truncated: boolean }>;
};

export function WorkspaceAIProviderCard({
  provider,
  canEdit,
  busy,
  onProviderChange,
  onProviderDelete,
  onModelChange,
  onModelDelete,
  onModelCreate,
  onDiscover,
}: Props) {
  const { t } = useTranslation();
  const mounted = useRef(true);
  const [editing, setEditing] = useState(false);
  const [providerName, setProviderName] = useState(provider.name);
  const [providerType, setProviderType] = useState<WorkspaceAIProviderName>(provider.provider);
  const [baseUrl, setBaseUrl] = useState(provider.base_url);
  const [apiKey, setApiKey] = useState("");
  const [newModel, setNewModel] = useState("");
  const [supportsImages, setSupportsImages] = useState(false);
  const [discoveryKey, setDiscoveryKey] = useState("");
  const [discovery, setDiscovery] = useState<AIModelOption[]>([]);
  const [discoveryTruncated, setDiscoveryTruncated] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [modelName, setModelName] = useState("");
  const [modelImages, setModelImages] = useState(false);

  const discoveryVersion = useRef(0);
  const [discovered, setDiscovered] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      discoveryVersion.current += 1;
    };
  }, []);
  useEffect(() => {
    discoveryVersion.current += 1;
    setDiscovering(false);
    setDiscovery([]);
    setDiscovered(false);
    setDiscoveryError(null);
    setDiscoveryTruncated(false);
  }, [discoveryKey, provider.provider, provider.base_url, provider.has_api_key]);
  useEffect(() => {
    setProviderName(provider.name);
    setProviderType(provider.provider);
    setBaseUrl(provider.base_url);
  }, [provider.name, provider.provider, provider.base_url]);

  const discover = async () => {
    const version = ++discoveryVersion.current;
    setDiscovering(true);
    setDiscoveryError(null);
    setDiscovery([]);
    setDiscovered(false);
    try {
      const result = await onDiscover({ base_url: baseUrl, api_key: discoveryKey });
      if (mounted.current && version === discoveryVersion.current) {
        setDiscovery(result.models);
        setDiscoveryTruncated(result.truncated);
        setDiscovered(true);
      }
    } catch (requestError: unknown) {
      if (mounted.current && version === discoveryVersion.current)
        setDiscoveryError(
          requestError instanceof Error ? requestError.message : t("workspace_settings.settings.ai.discovery_error")
        );
    } finally {
      if (mounted.current && version === discoveryVersion.current) setDiscovering(false);
    }
  };

  const addModel = async (model: string, vision = supportsImages) => {
    if (!model.trim()) return;
    if (await onModelCreate({ model: model.trim(), supports_images: vision, is_enabled: true, is_default: false }))
      setNewModel("");
  };
  const startModelEdit = (model: WorkspaceAIModel) => {
    setEditingModelId(model.id);
    setModelName(model.model);
    setModelImages(model.supports_images);
  };

  return (
    <section className="rounded-lg border border-subtle bg-surface-1 p-5">
      <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
        <div>
          <h3 className="text-h5-medium text-primary">{provider.name}</h3>
          <p className="text-body-xs-regular text-tertiary">{provider.provider}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!canEdit || busy}
            onClick={() => setEditing((value) => !value)}
          >
            {t("workspace_settings.settings.ai.edit")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!canEdit || busy}
            onClick={async () => {
              if (window.confirm(t("workspace_settings.settings.ai.confirm_delete_provider"))) await onProviderDelete();
            }}
          >
            {t("workspace_settings.settings.ai.delete")}
          </Button>
          <Button
            variant={provider.is_enabled ? "secondary" : "primary"}
            size="sm"
            disabled={!canEdit || busy}
            onClick={() => {
              if (
                !provider.is_enabled ||
                !provider.models.some((model) => model.is_default) ||
                window.confirm(t("workspace_settings.settings.ai.confirm_clear_default"))
              )
                void onProviderChange({ is_enabled: !provider.is_enabled });
            }}
          >
            {provider.is_enabled
              ? t("workspace_settings.settings.ai.enabled")
              : t("workspace_settings.settings.ai.disabled")}
          </Button>
        </div>
      </div>

      {editing && (
        <div className="mt-5 grid gap-3 border-t border-subtle pt-4 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-body-sm-medium">
            {t("workspace_settings.settings.ai.provider_name")}
            <Input
              value={providerName}
              disabled={!canEdit || busy}
              onChange={(event) => setProviderName(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-body-sm-medium">
            {t("workspace_settings.settings.ai.provider")}
            <select
              aria-label={t("workspace_settings.settings.ai.provider")}
              className="rounded border border-subtle bg-surface-1 px-3 py-2"
              value={providerType}
              disabled={!canEdit || busy}
              onChange={(event) => setProviderType(event.target.value as WorkspaceAIProviderName)}
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-body-sm-medium">
            {t("workspace_settings.settings.ai.base_url")}
            <Input value={baseUrl} disabled={!canEdit || busy} onChange={(event) => setBaseUrl(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-body-sm-medium">
            {t("workspace_settings.settings.ai.api_key")}
            <Input
              type="password"
              value={apiKey}
              disabled={!canEdit || busy}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <span className="text-body-xs-regular text-tertiary">
              {provider.has_api_key
                ? t("workspace_settings.settings.ai.key_saved")
                : t("workspace_settings.settings.ai.key_missing")}
            </span>
          </label>
          <Button
            className="md:col-span-2 md:justify-self-end"
            variant="primary"
            disabled={!canEdit || busy || !providerName.trim()}
            onClick={async () => {
              const success = await onProviderChange({
                name: providerName.trim(),
                provider: providerType,
                base_url: baseUrl.trim(),
                ...(apiKey ? { api_key: apiKey } : {}),
              });
              if (success) {
                setApiKey("");
                setEditing(false);
              }
            }}
          >
            {t("workspace_settings.settings.ai.save")}
          </Button>
        </div>
      )}

      <div className="mt-5 border-t border-subtle pt-4">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-h6-medium text-primary">{t("workspace_settings.settings.ai.models")}</h4>
          <span className="text-body-xs-regular text-tertiary">{provider.models.length}</span>
        </div>
        <div className="mt-3 divide-y divide-subtle">
          {provider.models.map((model) => (
            <div className="py-3" key={model.id}>
              {editingModelId === model.id ? (
                <div className="flex flex-col gap-2 md:flex-row md:items-center">
                  <Input
                    aria-label={t("workspace_settings.settings.ai.model_name")}
                    value={modelName}
                    disabled={busy}
                    onChange={(event) => setModelName(event.target.value)}
                  />
                  <label className="flex items-center gap-2 text-body-sm-regular whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={modelImages}
                      disabled={busy}
                      onChange={(event) => setModelImages(event.target.checked)}
                    />
                    {t("workspace_settings.settings.ai.supports_images")}
                  </label>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || !modelName.trim()}
                    onClick={async () => {
                      if (await onModelChange(model, { model: modelName.trim(), supports_images: modelImages }))
                        setEditingModelId(null);
                    }}
                  >
                    {t("workspace_settings.settings.ai.save")}
                  </Button>
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditingModelId(null)}>
                    {t("workspace_settings.settings.ai.cancel")}
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <span className="text-body-sm-medium text-primary">{model.model}</span>
                    <div className="flex gap-2 text-body-xs-regular text-tertiary">
                      {model.supports_images && <span>{t("workspace_settings.settings.ai.supports_images")}</span>}
                      {model.is_default && <span>{t("workspace_settings.settings.ai.default")}</span>}
                      {!model.is_enabled && <span>{t("workspace_settings.settings.ai.disabled")}</span>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!canEdit || busy}
                      onClick={() => startModelEdit(model)}
                    >
                      {t("workspace_settings.settings.ai.edit")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!canEdit || busy}
                      onClick={() => {
                        if (
                          !model.is_default ||
                          !model.is_enabled ||
                          window.confirm(t("workspace_settings.settings.ai.confirm_clear_default"))
                        )
                          void onModelChange(model, { is_enabled: !model.is_enabled });
                      }}
                    >
                      {model.is_enabled
                        ? t("workspace_settings.settings.ai.disable")
                        : t("workspace_settings.settings.ai.enable")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!canEdit || busy || !provider.is_enabled || !model.is_enabled || model.is_default}
                      onClick={() => void onModelChange(model, { is_default: true })}
                    >
                      {t("workspace_settings.settings.ai.set_default")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!canEdit || busy}
                      onClick={async () => {
                        if (window.confirm(t("workspace_settings.settings.ai.confirm_delete_model")))
                          await onModelDelete(model.id);
                      }}
                    >
                      {t("workspace_settings.settings.ai.delete")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {provider.models.length === 0 && (
            <p className="py-3 text-body-sm-regular text-tertiary">{t("workspace_settings.settings.ai.no_models")}</p>
          )}
        </div>

        {canEdit && (
          <div className="mt-4 grid gap-3 border-t border-subtle pt-4">
            <div className="flex flex-col gap-2 md:flex-row">
              <Input
                className="flex-1"
                aria-label={t("workspace_settings.settings.ai.manual_model")}
                value={newModel}
                placeholder={t("workspace_settings.settings.ai.manual_model")}
                disabled={busy || !provider.is_enabled}
                onChange={(event) => setNewModel(event.target.value)}
              />
              <label className="flex items-center gap-2 text-body-sm-regular whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={supportsImages}
                  disabled={busy || !provider.is_enabled}
                  onChange={(event) => setSupportsImages(event.target.checked)}
                />
                {t("workspace_settings.settings.ai.supports_images")}
              </label>
              <Button
                variant="primary"
                size="sm"
                disabled={busy || !provider.is_enabled || !newModel.trim()}
                onClick={() => void addModel(newModel)}
              >
                {t("workspace_settings.settings.ai.add_model")}
              </Button>
            </div>
            <div className="flex flex-col gap-2 md:flex-row">
              <Input
                className="flex-1"
                aria-label={t("workspace_settings.settings.ai.discovery_api_key")}
                value={discoveryKey}
                type="password"
                disabled={busy || !provider.is_enabled}
                placeholder={
                  provider.has_api_key
                    ? t("workspace_settings.settings.ai.key_saved")
                    : t("workspace_settings.settings.ai.api_key")
                }
                onChange={(event) => setDiscoveryKey(event.target.value)}
              />
              <Button
                variant="secondary"
                size="sm"
                loading={discovering}
                disabled={busy || discovering || !provider.is_enabled}
                onClick={() => void discover()}
              >
                {t("workspace_settings.settings.ai.discover_models")}
              </Button>
            </div>
            {discoveryError && (
              <p className="text-danger text-body-sm-regular" role="alert">
                {discoveryError}
              </p>
            )}
            {discovery.length > 0 && (
              <div className="rounded border border-subtle p-3">
                <p className="mb-2 text-body-xs-regular text-tertiary">
                  {t("workspace_settings.settings.ai.discovery_results")}
                  {discoveryTruncated ? ` · ${t("workspace_settings.settings.ai.discovery_truncated")}` : ""}
                </p>
                <select
                  aria-label={t("workspace_settings.settings.ai.discovery_results")}
                  className="w-full rounded border border-subtle bg-surface-1 px-3 py-2 text-body-sm-regular"
                  defaultValue=""
                  disabled={busy}
                  onChange={(event) => {
                    const selected = discovery.find((option) => option.id === event.target.value);
                    if (!selected) return;
                    setNewModel(selected.id);
                    setSupportsImages(selected.vision === true);
                    event.target.value = "";
                  }}
                >
                  <option value="">{t("workspace_settings.settings.ai.discovery_results")}</option>
                  {discovery.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name === option.id ? option.id : `${option.name} (${option.id})`}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {discovered && !discovering && !discoveryError && discovery.length === 0 && (
              <p className="text-body-xs-regular text-tertiary">
                {t("workspace_settings.settings.ai.discovery_empty")}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
