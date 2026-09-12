/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export const useInstance = () => ({
  config: {
    enable_signup: true,
    is_email_password_enabled: true,
    is_magic_login_enabled: false,
    is_smtp_configured: false,
    is_meowalive_enabled: true,
    is_google_enabled: true,
    is_github_enabled: true,
    is_gitlab_enabled: true,
    is_gitea_enabled: true,
  },
});
