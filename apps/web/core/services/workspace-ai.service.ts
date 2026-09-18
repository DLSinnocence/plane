/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import type { AIModelsResponse } from "@/services/agent.service";
import { agentRequest } from "@/services/agent.service";

export type WorkspaceAIProviderName = "openai" | "anthropic";

export type WorkspaceAIModel = {
  id: string;
  model: string;
  supports_images: boolean;
  is_enabled: boolean;
  is_default: boolean;
};

export type WorkspaceAIProvider = {
  id: string;
  name: string;
  provider: WorkspaceAIProviderName;
  base_url: string;
  has_api_key: boolean;
  is_enabled: boolean;
  models: WorkspaceAIModel[];
};

export type WorkspaceAISettings = { providers: WorkspaceAIProvider[] };
export type WorkspaceAIProviderInput = {
  name: string;
  provider: WorkspaceAIProviderName;
  base_url?: string;
  api_key?: string;
  is_enabled?: boolean;
};
export type WorkspaceAIModelInput = {
  model: string;
  supports_images?: boolean;
  is_enabled?: boolean;
  is_default?: boolean;
};
export type WorkspaceAIDiscoveryInput = {
  provider: WorkspaceAIProviderName;
  base_url?: string;
  api_key?: string;
  provider_id?: string;
};

const path = (workspaceSlug: string, suffix = "") =>
  `/api/workspaces/${encodeURIComponent(workspaceSlug)}/ai-settings/${suffix}`;

export async function getWorkspaceAISettings(workspaceSlug: string, signal: AbortSignal): Promise<WorkspaceAISettings> {
  return (await agentRequest(path(workspaceSlug), "GET", signal)).json();
}

export async function createWorkspaceAIProvider(
  workspaceSlug: string,
  data: WorkspaceAIProviderInput,
  signal: AbortSignal
): Promise<WorkspaceAIProvider> {
  return (await agentRequest(path(workspaceSlug, "providers/"), "POST", signal, data)).json();
}

export async function updateWorkspaceAIProvider(
  workspaceSlug: string,
  providerId: string,
  data: Partial<WorkspaceAIProviderInput>,
  signal: AbortSignal
): Promise<WorkspaceAIProvider> {
  return (
    await agentRequest(path(workspaceSlug, `providers/${encodeURIComponent(providerId)}/`), "PATCH", signal, data)
  ).json();
}

export async function deleteWorkspaceAIProvider(
  workspaceSlug: string,
  providerId: string,
  signal: AbortSignal
): Promise<void> {
  await agentRequest(path(workspaceSlug, `providers/${encodeURIComponent(providerId)}/`), "DELETE", signal);
}

export async function createWorkspaceAIModel(
  workspaceSlug: string,
  providerId: string,
  data: WorkspaceAIModelInput,
  signal: AbortSignal
): Promise<WorkspaceAIModel> {
  return (
    await agentRequest(path(workspaceSlug, `providers/${encodeURIComponent(providerId)}/models/`), "POST", signal, data)
  ).json();
}

export async function updateWorkspaceAIModel(
  workspaceSlug: string,
  providerId: string,
  modelId: string,
  data: Partial<WorkspaceAIModelInput>,
  signal: AbortSignal
): Promise<WorkspaceAIModel> {
  return (
    await agentRequest(
      path(workspaceSlug, `providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/`),
      "PATCH",
      signal,
      data
    )
  ).json();
}

export async function deleteWorkspaceAIModel(
  workspaceSlug: string,
  providerId: string,
  modelId: string,
  signal: AbortSignal
): Promise<void> {
  await agentRequest(
    path(workspaceSlug, `providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/`),
    "DELETE",
    signal
  );
}

export async function discoverWorkspaceAIModels(
  workspaceSlug: string,
  data: WorkspaceAIDiscoveryInput,
  signal: AbortSignal
): Promise<AIModelsResponse> {
  return (await agentRequest(path(workspaceSlug, "models/"), "POST", signal, data)).json();
}
