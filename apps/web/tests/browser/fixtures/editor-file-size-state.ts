/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export const useEditorAsset = () => ({ assetsUploadPercentage: {} });

export const useInstance = () => ({
  config: {
    file_size_limit: 5 * 1024 * 1024,
  },
});

export const useExtendedEditorConfig = () => ({
  getExtendedEditorFileHandlers: () => ({}),
});
