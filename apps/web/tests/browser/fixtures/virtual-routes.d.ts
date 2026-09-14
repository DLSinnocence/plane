// Copyright (c) 2023-present Plane Software, Inc. and contributors
// SPDX-License-Identifier: AGPL-3.0-only

declare module "virtual:attachment-peek-handler" {
  export const createPeekEscapeHandler: (close: () => void) => (event: KeyboardEvent) => void;
}

declare module "virtual:application-routes" {
  const routes: import("@react-router/dev/routes").RouteConfigEntry[];
  export default routes;
}
