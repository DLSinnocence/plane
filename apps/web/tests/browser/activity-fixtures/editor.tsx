/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { forwardRef, useImperativeHandle, useState } from "react";

type EditorHandle = {
  clearEditor: () => void;
  setEditorValue: (html: string) => void;
  isEditorReadyToDiscard: () => boolean;
};
type Props = {
  id: string;
  editable: boolean;
  initialValue: string;
  containerClassName?: string;
  onChange?: (json: null, html: string) => void;
};

const textFromHTML = (html: string) => {
  const element = document.createElement("div");
  element.innerHTML = html;
  return element.textContent ?? "";
};

// Only the rich-text leaf is replaced. Intentionally initialize once, like an
// uncontrolled editor: resetting on id changes here would hide lifecycle bugs in
// the real CommentCreate/IssueActivity (cross-issue drafts and lost form state).
export const LiteTextEditor = forwardRef<EditorHandle, Props>(function LiteTextEditor(props, ref) {
  const { id, editable, initialValue, onChange, containerClassName } = props;
  const [text, setText] = useState(() => textFromHTML(initialValue));
  useImperativeHandle(ref, () => ({
    clearEditor: () => setText(""),
    setEditorValue: (html) => setText(textFromHTML(html)),
    isEditorReadyToDiscard: () => true,
  }));

  return editable ? (
    <textarea
      id={id}
      aria-label="Comment draft"
      className="fixture-editor"
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const element = document.createElement("p");
        element.textContent = event.target.value;
        onChange?.(null, element.outerHTML);
      }}
    />
  ) : (
    <div data-testid={`comment-body-${id}`} className={containerClassName}>
      {text}
    </div>
  );
});
