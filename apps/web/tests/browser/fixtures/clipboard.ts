/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { copyUrlToClipboard } from "@plane/utils";
import { getWorkItemLinkTitle } from "../../../helpers/work-item-link";

const name = document.querySelector<HTMLInputElement>("#name")!;
const result = document.querySelector<HTMLElement>("#result")!;
document.querySelector<HTMLButtonElement>("#copy")!.addEventListener("click", async () => {
  result.textContent = "";
  try {
    await copyUrlToClipboard(
      "/meowalive/browse/WITCHFARM-10/",
      getWorkItemLinkTitle({ name: name.value, projectIdentifier: "WITCHFARM", sequenceId: 10 })
    );
    result.textContent = "Copied";
  } catch {
    result.textContent = "Copy failed";
  }
});
