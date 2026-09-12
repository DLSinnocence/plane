/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useLocation } from "react-router";
import { initPromise, setLanguage, TranslationProvider } from "@plane/i18n";
import { AuthBase } from "@/components/auth-screens/auth-base";
import { EAuthModes } from "@/helpers/authentication.helper";

function ActualAuthPage() {
  const { pathname } = useLocation();
  return (
    <>
      <AuthBase key={pathname} authType={pathname === "/sign-up" ? EAuthModes.SIGN_UP : EAuthModes.SIGN_IN} />
      <button type="button" data-testid="choose-english" onClick={() => void setLanguage("en")}>
        English
      </button>
    </>
  );
}

await initPromise;
createRoot(document.getElementById("root")!).render(
  <TranslationProvider>
    <BrowserRouter>
      <ActualAuthPage />
    </BrowserRouter>
  </TranslationProvider>
);
