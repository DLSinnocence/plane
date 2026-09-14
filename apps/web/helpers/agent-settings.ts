/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export type AIProvider = "openai" | "anthropic";

export type AISettings = {
  provider: AIProvider;
  base_url: string;
  model: string;
  has_api_key: boolean;
  supports_images?: boolean;
};

export type AISettingsInput = Omit<AISettings, "has_api_key"> & { api_key?: string };

export function buildAISettingsInput(
  provider: AIProvider,
  baseUrl: string,
  model: string,
  apiKey: string,
  supportsImages?: boolean
): AISettingsInput {
  const input: AISettingsInput = { provider, base_url: baseUrl.trim(), model: model.trim() };
  if (supportsImages !== undefined) input.supports_images = supportsImages;
  if (apiKey.trim()) input.api_key = apiKey.trim();
  return input;
}
