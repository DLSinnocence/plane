/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { isFileValid } from "../../../../../packages/editor/src/helpers/file";
import { useEditorConfig } from "@/hooks/editor/use-editor-config";

const SIX_MEBIBYTES = 6 * 1024 * 1024;

export const EditorFileSizeFixture = () => {
  const { getEditorFileHandlers } = useEditorConfig();
  const [result, setResult] = useState<string | null>(null);

  const validateGif = () => {
    const fileHandler = getEditorFileHandlers({
      uploadFile: async () => "",
      duplicateFile: async () => "",
      workspaceId: "workspace",
      workspaceSlug: "workspace",
    });
    const maxFileSize = fileHandler.validation?.maxFileSize ?? 0;
    const accepted = isFileValid({
      acceptedMimeTypes: ["image/gif"],
      file: new File([new Uint8Array(SIX_MEBIBYTES)], "animated.gif", { type: "image/gif" }),
      maxFileSize,
      onError: () => {},
    });

    setResult(JSON.stringify({ accepted, maxFileSize }));
  };

  return (
    <section>
      <button onClick={validateGif}>Validate 6 MiB GIF</button>
      {result && <output data-testid="editor-file-size-result">{result}</output>}
    </section>
  );
};
