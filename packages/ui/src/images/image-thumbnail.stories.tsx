/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { ImageThumbnail } from "./image-thumbnail";

const meta: Meta<typeof ImageThumbnail> = {
  title: "Images/ImageThumbnail",
  component: ImageThumbnail,
  args: {
    src: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#e0f2fe"/><circle cx="280" cy="65" r="35" fill="#fbbf24"/><path d="M0 240 130 70 270 240Z" fill="#0d9488"/></svg>')}`,
    name: "landscape.svg",
    loadingLabel: "Loading image…",
    errorLabel: "This image could not be previewed.",
  },
};

export default meta;
type Story = StoryObj<typeof ImageThumbnail>;

export const Loaded: Story = {};
export const Loading: Story = { args: { src: "" } };
export const Unavailable: Story = { args: { src: "data:image/png;base64,invalid" } };
