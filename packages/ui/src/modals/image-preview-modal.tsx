/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Dialog } from "@headlessui/react";
import { Download, Maximize, Minus, Plus, X } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

export type ImagePreviewModalProps = {
  src: string;
  name: string;
  onClose: () => void;
  labels: {
    loading: string;
    error: string;
    retry: string;
    close: string;
    download: string;
    zoomIn: string;
    zoomOut: string;
    resetZoom: string;
  };
};

type ImageState = "loading" | "loaded" | "error";
type PreviewProps = ImagePreviewModalProps & { closeRef: React.RefObject<HTMLButtonElement | null> };

const controlClassName =
  "flex h-10 min-w-10 shrink-0 items-center justify-center rounded-md text-white transition-colors hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-35";

function ImageAttempt({ src, name, labels, onClose, closeRef, onRetry }: PreviewProps & { onRetry: () => void }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
    moved: boolean;
    background: boolean;
  } | null>(null);
  const [state, setState] = useState<ImageState>("loading");
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const fit =
    naturalSize.width && naturalSize.height && stageSize.width && stageSize.height
      ? Math.min(
          1,
          Math.max(1, stageSize.width - 32) / naturalSize.width,
          Math.max(1, stageSize.height - 32) / naturalSize.height
        )
      : 1;
  const scale = zoom === null ? fit : Math.max(fit, zoom);
  const canPan = naturalSize.width * scale + 32 > stageSize.width || naturalSize.height * scale + 32 > stageSize.height;

  const loaded = (image: HTMLImageElement) => {
    setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
    setState("loaded");
  };

  useEffect(() => {
    const image = imageRef.current;
    // A cached image can finish before React attaches its load handler.
    if (src && image?.complete) {
      if (image.naturalWidth > 0) loaded(image);
      else setState("error");
    }
  }, [src]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const retry = () => {
    // Explicitly update the failed image's src to invoke the browser's reload
    // path, then replace the attempt. Keep signed URLs byte-for-byte intact.
    if (imageRef.current) imageRef.current.src = src;
    onRetry();
  };

  const resetZoom = () => {
    setZoom(null);
    stageRef.current?.scrollTo({ left: 0, top: 0 });
  };

  return (
    <>
      <div className="relative z-10 shrink-0 border-b border-white/10 bg-[#0a0a0a] px-3 py-2 text-white sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Dialog.Title title={name} className="min-w-0 flex-1 truncate text-13 font-medium">
            {name}
          </Dialog.Title>
          <a
            href={src}
            download={name}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-10 shrink-0 items-center justify-center gap-2 rounded-md bg-white px-3 text-13 font-medium text-[#0a0a0a] hover:bg-[#e5e5e5] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <Download className="size-4" aria-hidden="true" />
            {labels.download}
          </a>
          <button
            ref={closeRef}
            data-autofocus
            type="button"
            aria-label={labels.close}
            title={labels.close}
            onClick={onClose}
            className={controlClassName}
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
        <div className="flex items-center justify-center gap-1">
          <button
            type="button"
            aria-label={labels.zoomOut}
            title={labels.zoomOut}
            disabled={state !== "loaded" || scale <= fit}
            onClick={() => setZoom(Math.max(fit, scale / 1.25))}
            className={controlClassName}
          >
            <Minus className="size-4" aria-hidden="true" />
          </button>
          <span data-testid="image-preview-zoom" className="w-14 text-center text-12 text-[#d4d4d4] tabular-nums">
            {state === "loaded" ? `${Math.round(scale * 100)}%` : "—"}
          </span>
          <button
            type="button"
            aria-label={labels.zoomIn}
            title={labels.zoomIn}
            disabled={state !== "loaded" || scale >= 4}
            onClick={() => setZoom(Math.min(4, scale * 1.25))}
            className={controlClassName}
          >
            <Plus className="size-4" aria-hidden="true" />
          </button>
          <div aria-hidden="true" className="mx-2 h-4 w-px bg-white/20" />
          <button
            type="button"
            aria-label={labels.resetZoom}
            title={labels.resetZoom}
            disabled={state !== "loaded"}
            onClick={resetZoom}
            className={`${controlClassName} gap-2 px-2 text-12`}
          >
            <Maximize className="size-4" aria-hidden="true" />
            {labels.resetZoom}
          </button>
        </div>
      </div>
      <div
        ref={stageRef}
        data-testid="image-preview-stage"
        role="region"
        aria-label={name}
        tabIndex={state === "loaded" && canPan ? 0 : -1}
        className="relative min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || !canPan) return;
          const directions: Record<string, [number, number]> = {
            ArrowLeft: [-64, 0],
            ArrowRight: [64, 0],
            ArrowUp: [0, -64],
            ArrowDown: [0, 64],
          };
          const direction = directions[event.key];
          if (direction) {
            event.preventDefault();
            event.currentTarget.scrollBy({ left: direction[0], top: direction[1] });
          }
        }}
        style={{ cursor: state === "loaded" && canPan ? (dragging ? "grabbing" : "grab") : undefined }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const stage = event.currentTarget;
          dragRef.current = {
            x: event.clientX,
            y: event.clientY,
            left: stage.scrollLeft,
            top: stage.scrollTop,
            moved: false,
            background: event.target === stage || event.target === imageRef.current?.parentElement,
          };
          if (event.pointerType === "mouse" && state === "loaded" && canPan) {
            stage.setPointerCapture(event.pointerId);
            setDragging(true);
            event.preventDefault();
          }
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          const dx = event.clientX - drag.x;
          const dy = event.clientY - drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.scrollLeft = drag.left - dx;
            event.currentTarget.scrollTop = drag.top - dy;
          }
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          setDragging(false);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setDragging(false);
        }}
        onClick={(event) => {
          const drag = dragRef.current;
          dragRef.current = null;
          if (
            drag?.background &&
            !drag.moved &&
            (event.target === event.currentTarget || event.target === imageRef.current?.parentElement)
          )
            onClose();
        }}
      >
        <div
          className="flex min-h-full min-w-full items-center justify-center p-4"
          style={{ width: naturalSize.width * scale + 32, height: naturalSize.height * scale + 32 }}
        >
          <img
            ref={imageRef}
            src={src || undefined}
            alt={name}
            draggable={false}
            onLoad={(event) => loaded(event.currentTarget)}
            onError={() => setState("error")}
            className="block shrink-0 object-contain select-none"
            style={{
              width: naturalSize.width * scale,
              height: naturalSize.height * scale,
              maxWidth: "none",
              visibility: state === "loaded" ? "visible" : "hidden",
            }}
          />
        </div>
        {state === "loading" && (
          <p
            role="status"
            className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-13 text-[#d4d4d4]"
          >
            {labels.loading}
          </p>
        )}
        {state === "error" && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center">
            <p role="alert" className="text-13 text-[#d4d4d4]">
              {labels.error}
            </p>
            <button
              type="button"
              onClick={retry}
              className={`${controlClassName} pointer-events-auto border border-white/25 px-4 text-13`}
            >
              {labels.retry}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function ImagePreview(props: PreviewProps) {
  const [attempt, setAttempt] = useState(0);
  const { closeRef } = props;
  useEffect(() => {
    // A retry replaces the failed attempt, including its focused Retry button.
    // Keep keyboard navigation inside the still-open dialog.
    closeRef.current?.focus();
  }, [attempt, closeRef]);
  return <ImageAttempt key={attempt} {...props} onRetry={() => setAttempt((value) => value + 1)} />;
}

/** Mount while open; callers can key by attachment identity to reset a preview. */
export function ImagePreviewModal({ src, name, onClose, labels }: ImagePreviewModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open onClose={onClose} initialFocus={closeRef} data-prevent-outside-click className="relative z-30">
      <div className="fixed inset-0 bg-black/90" aria-hidden="true" />
      <Dialog.Panel className="shadow-2xl fixed inset-2 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg bg-[#0a0a0a] text-white sm:inset-4">
        <ImagePreview key={src} src={src} name={name} labels={labels} onClose={onClose} closeRef={closeRef} />
      </Dialog.Panel>
    </Dialog>
  );
}
