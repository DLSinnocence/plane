/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useEffect, useRef, useState } from "react";

export type ImageThumbnailProps = {
  src: string;
  name: string;
  loadingLabel: string;
  errorLabel: string;
};

function ThumbnailImage({ src, name, loadingLabel, errorLabel }: ImageThumbnailProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");

  useEffect(() => {
    const image = imageRef.current;
    if (src && image?.complete) setState(image.naturalWidth > 0 ? "loaded" : "error");
  }, [src]);

  return (
    <span
      className={
        state === "loaded"
          ? "relative inline-flex max-w-full cursor-zoom-in"
          : "relative flex h-24 w-40 max-w-full cursor-zoom-in items-center justify-center rounded bg-surface-2"
      }
    >
      <img
        ref={imageRef}
        src={src || undefined}
        alt={name}
        loading="lazy"
        decoding="async"
        onLoad={() => setState("loaded")}
        onError={() => setState("error")}
        className="block h-auto max-h-48 w-auto max-w-full rounded object-contain"
        style={{ visibility: state === "loaded" ? "visible" : "hidden" }}
      />
      {state !== "loaded" && (
        <span
          role="status"
          className="absolute inset-0 flex items-center justify-center p-2 text-center text-11 whitespace-normal text-tertiary"
        >
          {state === "error" ? errorLabel : loadingLabel}
        </span>
      )}
    </span>
  );
}

/** Display inline; changing the source discards the previous image's load state. */
export function ImageThumbnail(props: ImageThumbnailProps) {
  return <ThumbnailImage key={props.src} {...props} />;
}
