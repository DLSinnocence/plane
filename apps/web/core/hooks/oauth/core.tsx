/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { ShieldCheck } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
// plane imports
import { API_BASE_URL } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { TOAuthConfigs, TOAuthOption } from "@plane/types";
// assets
import giteaLogo from "@/app/assets/logos/gitea-logo.svg?url";
import GithubLightLogo from "@/app/assets/logos/github-black.png?url";
import GithubDarkLogo from "@/app/assets/logos/github-dark.svg?url";
import gitlabLogo from "@/app/assets/logos/gitlab-logo.svg?url";
import googleLogo from "@/app/assets/logos/google-logo.svg?url";
// hooks
import { useInstance } from "@/hooks/store/use-instance";
import { getOAuthNextPathQuery } from "@/helpers/authentication-redirect";

export const useCoreOAuthConfig = (oauthActionText: string): TOAuthConfigs => {
  //router
  const searchParams = useSearchParams();
  // query params
  const nextPathQuery = getOAuthNextPathQuery(searchParams.get("next_path"));
  // theme
  const { resolvedTheme } = useTheme();
  // store hooks
  const { config } = useInstance();
  const { t } = useTranslation();
  // derived values
  const isOAuthEnabled =
    (config &&
      (config?.is_google_enabled ||
        config?.is_github_enabled ||
        config?.is_gitlab_enabled ||
        config?.is_gitea_enabled ||
        config?.is_meowalive_enabled)) ||
    false;
  const oAuthOptions: TOAuthOption[] = [
    {
      id: "meowalive",
      text: t("auth.common.continue_with_meowalive"),
      icon: <ShieldCheck size={18} aria-hidden="true" />,
      onClick: () => {
        window.location.assign(`${API_BASE_URL}/auth/meowalive/${nextPathQuery}`);
      },
      enabled: config?.is_meowalive_enabled ?? false,
    },
    {
      id: "google",
      text: t("auth.common.oauth_with_provider", { action: oauthActionText, provider: "Google" }),
      icon: <img src={googleLogo} height={18} width={18} alt="" />,
      onClick: () => {
        window.location.assign(`${API_BASE_URL}/auth/google/${nextPathQuery}`);
      },
      enabled: config?.is_google_enabled,
    },
    {
      id: "github",
      text: t("auth.common.oauth_with_provider", { action: oauthActionText, provider: "GitHub" }),
      icon: <img src={resolvedTheme === "dark" ? GithubDarkLogo : GithubLightLogo} height={18} width={18} alt="" />,
      onClick: () => {
        window.location.assign(`${API_BASE_URL}/auth/github/${nextPathQuery}`);
      },
      enabled: config?.is_github_enabled,
    },
    {
      id: "gitlab",
      text: t("auth.common.oauth_with_provider", { action: oauthActionText, provider: "GitLab" }),
      icon: <img src={gitlabLogo} height={18} width={18} alt="" />,
      onClick: () => {
        window.location.assign(`${API_BASE_URL}/auth/gitlab/${nextPathQuery}`);
      },
      enabled: config?.is_gitlab_enabled,
    },
    {
      id: "gitea",
      text: t("auth.common.oauth_with_provider", { action: oauthActionText, provider: "Gitea" }),
      icon: <img src={giteaLogo} height={18} width={18} alt="" />,
      onClick: () => {
        window.location.assign(`${API_BASE_URL}/auth/gitea/${nextPathQuery}`);
      },
      enabled: config?.is_gitea_enabled,
    },
  ];

  return {
    isOAuthEnabled,
    oAuthOptions,
  };
};
