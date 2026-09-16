/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Dialog } from "@headlessui/react";
import React, { useEffect, useRef, useState } from "react";
import { Button } from "@plane/propel/button";
import { EModalWidth } from "./constants";
import { ModalCore } from "./modal-core";

export type ImagePreviewModalProps = {
  src: string;
  name: string;
  onClose: () => void;
  labels: {
    loading: string;
    error: string;
    retry: string;
    close: string;
    openOriginal: string;
  };
};

type ImageState = "loading" | "loaded" | "error";

function ImageAttempt({
  src,
  name,
  labels,
  onRetry,
}: Pick<ImagePreviewModalProps, "src" | "name" | "labels"> & { onRetry: () => void }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [state, setState] = useState<ImageState>("loading");

  useEffect(() => {
    const image = imageRef.current;
    // A cached image can finish before React attaches its load handler.
    if (src && image?.complete) setState(image.naturalWidth > 0 ? "loaded" : "error");
  }, [src]);

  const retry = () => {
    // Explicitly update the failed image's src to invoke the browser's reload
    // path, then replace the attempt. Keep signed URLs byte-for-byte intact.
    if (imageRef.current) imageRef.current.src = src;
    onRetry();
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-4">
      <img
        ref={imageRef}
        src={src || undefined}
        alt={name}
        onLoad={() => setState("loaded")}
        onError={() => setState("error")}
        className="h-auto max-h-full w-auto max-w-full object-contain"
        style={{ visibility: state === "loaded" ? "visible" : "hidden" }}
      />
      {state === "loading" && (
        <p role="status" className="absolute inset-0 flex items-center justify-center p-4 text-13 text-secondary">
          {labels.loading}
        </p>
      )}
      {state === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center">
          <p role="alert" className="text-13 text-secondary">
            {labels.error}
          </p>
          <Button variant="secondary" onClick={retry}>
            {labels.retry}
          </Button>
        </div>
      )}
    </div>
  );
}

function ImagePreview({ src, name, labels }: Pick<ImagePreviewModalProps, "src" | "name" | "labels">) {
  const [attempt, setAttempt] = useState(0);
  return <ImageAttempt key={attempt} src={src} name={name} labels={labels} onRetry={() => setAttempt(attempt + 1)} />;
}

/** Mount while open; callers can key by attachment identity to reset a preview. */
export function ImagePreviewModal({ src, name, onClose, labels }: ImagePreviewModalProps) {
  return (
    <ModalCore
      isOpen
      handleClose={onClose}
      width={EModalWidth.VIIXL}
      className="flex h-[calc(100dvh-2rem)] max-h-[56rem] flex-col overflow-hidden"
    >
      <div className="flex max-h-[35%] shrink-0 items-start gap-3 overflow-y-auto border-b border-subtle p-4">
        <Dialog.Title className="min-w-0 flex-1 overflow-y-auto text-16 font-medium [overflow-wrap:anywhere] break-words whitespace-pre-wrap">
          {name}
        </Dialog.Title>
        <Button data-autofocus variant="secondary" onClick={onClose}>
          {labels.close}
        </Button>
      </div>
      <ImagePreview key={src} src={src} name={name} labels={labels} />
      <div className="shrink-0 border-t border-subtle p-4 text-right">
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-sm text-13 text-accent-primary underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {labels.openOriginal}
        </a>
      </div>
    </ModalCore>
  );
}
