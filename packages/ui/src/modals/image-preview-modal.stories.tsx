/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Meta, StoryObj } from "@storybook/react";
import React, { useState } from "react";
import { Button } from "@plane/propel/button";
import { ImagePreviewModal } from "./image-preview-modal";
import type { ImagePreviewModalProps } from "./image-preview-modal";

const landscape = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600"><rect width="960" height="600" fill="#e0f2fe"/><circle cx="740" cy="130" r="70" fill="#fbbf24"/><path d="M0 600 280 180 560 600Z" fill="#0d9488"/><path d="M350 600 690 240 960 600Z" fill="#14b8a6"/></svg>'
)}`;

function PreviewStory(args: ImagePreviewModalProps) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Preview image
      </Button>
      {open && (
        <ImagePreviewModal
          {...args}
          onClose={() => {
            setOpen(false);
            args.onClose();
          }}
        />
      )}
    </>
  );
}

const meta: Meta<typeof ImagePreviewModal> = {
  title: "Modals/ImagePreviewModal",
  component: ImagePreviewModal,
  render: (args) => <PreviewStory {...args} />,
  args: {
    src: landscape,
    name: "mountains.svg",
    onClose: () => {},
    labels: {
      loading: "Loading image…",
      error: "Unable to load this image.",
      retry: "Retry",
      close: "Close",
      download: "Download",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      resetZoom: "Fit to window",
    },
  },
};

export default meta;
type Story = StoryObj<typeof ImagePreviewModal>;

export const Healthy: Story = {};

export const SmallImage: Story = {
  args: {
    src: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#14b8a6"/></svg>')}`,
    name: "small-image.svg",
  },
  parameters: {
    docs: {
      description: { story: "Initial fit keeps this image at its natural 120 × 80 size. Zoom in to enlarge it." },
    },
  },
};

export const Portrait: Story = {
  args: {
    src: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1800"><rect width="900" height="1800" fill="#0f766e"/><circle cx="450" cy="900" r="300" fill="#fbbf24"/></svg>')}`,
    name: "portrait-image.svg",
  },
};

export const Loading: Story = {
  args: { src: "", name: "loading-image.png" },
  parameters: {
    docs: {
      description: {
        story: "An empty source leaves the native image pending without an external network dependency.",
      },
    },
  },
};

export const Error: Story = {
  args: { src: "data:image/png;base64,invalid", name: "unavailable-image.png" },
};

export const LongFilename: Story = {
  args: {
    name: "Project-reference-image-with-a-long-unbroken-filename-".repeat(8) + ".svg",
  },
};
