/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import { API_BASE_URL } from "@plane/constants";
import type { AISettings, AISettingsInput } from "@/helpers/agent-settings";
import type { AgentMessage } from "@/helpers/agent-stream";

function errorMessage(data: unknown): string | undefined {
  if (typeof data === "string") return data.trim() || undefined;
  if (Array.isArray(data)) return data.map(errorMessage).filter(Boolean).join(" ") || undefined;
  if (!data || typeof data !== "object") return undefined;
  const fields = data as Record<string, unknown>;
  const general =
    errorMessage(fields.detail) ??
    errorMessage(fields.message) ??
    errorMessage(fields.error) ??
    errorMessage(fields.non_field_errors);
  if (general) return general;
  const labels: Record<string, string> = {
    provider: "Provider",
    base_url: "Base URL",
    model: "Model",
    api_key: "API key",
  };
  return (
    Object.entries(labels)
      .map(([field, label]) => {
        const message = errorMessage(fields[field]);
        return message ? `${label}: ${message}` : "";
      })
      .filter(Boolean)
      .join(" ") || undefined
  );
}

async function request(path: string, method: string, signal: AbortSignal, data?: unknown) {
  const headers: Record<string, string> = {};
  if (method !== "GET") {
    const csrf = await fetch(`${API_BASE_URL}/auth/get-csrf-token/`, { credentials: "include", signal });
    if (!csrf.ok) throw new Error("Unable to obtain CSRF token");
    const token = (await csrf.json()).csrf_token;
    if (typeof token !== "string" || !token) throw new Error("CSRF token not found");
    headers["X-CSRFToken"] = token;
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    credentials: "include",
    headers,
    signal,
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (!response.ok) {
    const errorData: unknown = await response.json().catch(() => undefined);
    throw new Error(errorMessage(errorData) ?? `Request failed (${response.status})`);
  }
  return response;
}
export async function getAISettings(signal: AbortSignal): Promise<AISettings> {
  return (await request("/api/users/me/ai-settings/", "GET", signal)).json();
}
export async function saveAISettings(data: AISettingsInput, signal: AbortSignal): Promise<AISettings> {
  return (await request("/api/users/me/ai-settings/", "PATCH", signal, data)).json();
}
export async function disconnectAISettings(signal: AbortSignal): Promise<void> {
  await request("/api/users/me/ai-settings/", "DELETE", signal);
}
export async function startAgentChat(
  workspaceSlug: string,
  messages: AgentMessage[],
  projectId: string | undefined,
  signal: AbortSignal
) {
  const response = await request(`/api/workspaces/${encodeURIComponent(workspaceSlug)}/agent/chat/`, "POST", signal, {
    messages,
    ...(projectId ? { project_id: projectId } : {}),
  });
  if (!response.body) throw new Error("Assistant response has no stream");
  return response.body;
}
