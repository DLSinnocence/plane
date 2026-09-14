/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { Paperclip } from "lucide-react";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { EIssueServiceType } from "@plane/types";
import type { TIssueAttachmentSlot } from "@plane/types";
import { getFileURL } from "@plane/utils";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useUser, useUserPermissions } from "@/hooks/store/user";
import { getAttachmentUploadErrorKey, getAttachmentUploadErrorDetails } from "@/helpers/attachment-upload";
import { useFileSize } from "@/hooks/use-file-size";
import type { TAttachmentHelpers } from "../issue-detail-widgets/attachments/helper";
import { AttachmentConfirm } from "./slot-dialogs";
import { validateSlotNames } from "./slot-helpers";

const EMPTY_SLOTS: TIssueAttachmentSlot[] = [];

export const IssueAttachmentSlots = observer(function IssueAttachmentSlots({
  workspaceSlug,
  projectId,
  issueId,
  disabled,
  attachmentHelpers,
  focusSlotId,
  onFocusHandled,
}: {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  disabled: boolean;
  attachmentHelpers: TAttachmentHelpers;
  focusSlotId?: string | null;
  onFocusHandled?: () => void;
}) {
  const { t } = useTranslation();
  const { attachment } = useIssueDetail(EIssueServiceType.ISSUES);
  const { allowPermissions } = useUserPermissions();
  const editable =
    !disabled &&
    allowPermissions([EUserPermissions.ADMIN, EUserPermissions.MEMBER], EUserPermissionsLevel.WORKSPACE, workspaceSlug);
  const { data: currentUser } = useUser();
  const isProjectAdmin = allowPermissions(
    [EUserPermissions.ADMIN],
    EUserPermissionsLevel.PROJECT,
    workspaceSlug,
    projectId
  );
  const canDeleteFile = (slot: TIssueAttachmentSlot) =>
    editable &&
    Boolean(slot.attachment) &&
    (isProjectAdmin || Boolean(currentUser?.id && slot.attachment?.created_by === currentUser.id));
  const { maxFileSize } = useFileSize();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState("");
  const [errorFileSize, setErrorFileSize] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const [editor, setEditor] = useState<{ id: string; name: string; error?: string } | null>(null);
  const [deleting, setDeleting] = useState<{ slot: TIssueAttachmentSlot; file: boolean } | null>(null);
  const fileInputs = useRef(new Map<string, HTMLInputElement>());
  const nameInput = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError(null);
    attachment
      .fetchAttachmentSlots(workspaceSlug, projectId, issueId)
      .then(() => {
        if (!cancelled) setReady(true);
        return undefined;
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(getAttachmentUploadErrorKey(cause));
          setErrorDetails(getAttachmentUploadErrorDetails(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attachment, workspaceSlug, projectId, issueId, retry]);
  const slots = attachment.getAttachmentSlotsByIssueId(issueId) ?? EMPTY_SLOTS;
  useEffect(() => {
    if (!focusSlotId || !editable) return;
    const slot = slots.find((item) => item.id === focusSlotId);
    if (slot) {
      setEditor({ id: slot.id, name: slot.name });
      onFocusHandled?.();
    }
  }, [focusSlotId, editable, slots, onFocusHandled]);
  useEffect(() => {
    if (editor?.id && busy === null) {
      nameInput.current?.focus();
      nameInput.current?.select();
    }
  }, [editor?.id, busy]);
  const saveName = async () => {
    if (!editor || lock.current || !editable) return;
    const current = slots.find((slot) => slot.id === editor.id);
    if (!current) return;
    const name = editor.name.trim();
    const validation = validateSlotNames([
      ...slots.filter((slot) => slot.id !== editor.id).map((slot) => slot.name),
      name,
    ]);
    if (validation) {
      setEditor({ ...editor, error: `attachment.slots.${validation === "duplicate" ? "duplicate" : "invalid_name"}` });
      return;
    }
    if (name === current.name) {
      setEditor(null);
      return;
    }
    lock.current = true;
    setBusy(editor.id);
    try {
      await attachment.updateAttachmentSlot(workspaceSlug, projectId, issueId, editor.id, name);
      if (active.current)
        setEditor((currentEditor) =>
          currentEditor?.id === editor.id && currentEditor.name === editor.name ? null : currentEditor
        );
    } catch {
      if (active.current)
        setEditor((currentEditor) =>
          currentEditor?.id === editor.id && currentEditor.name === editor.name
            ? { ...currentEditor, error: "attachment.slots.error" }
            : currentEditor
        );
    } finally {
      lock.current = false;
      if (active.current) setBusy(null);
    }
  };
  return (
    <div className="space-y-2 px-3 py-2">
      {!ready && !error && (
        <p role="status" className="text-13 text-tertiary">
          {t("attachment.slots.loading")}
        </p>
      )}
      {error && (
        <div role="alert" className="text-13 text-danger-primary">
          <p>{t(error, { size: maxFileSize / 1024 / 1024 })}</p>
          <p className="break-words">
            {errorFileSize !== null
              ? t("attachment.selection_details", { size: errorFileSize, limit: maxFileSize, reason: errorDetails })
              : errorDetails}
          </p>
          {!ready && (
            <Button variant="secondary" size="sm" onClick={() => setRetry(retry + 1)}>
              {t("attachment.slots.retry")}
            </Button>
          )}
        </div>
      )}
      {slots.map((slot) => (
        <div
          key={slot.id}
          data-testid={`attachment-slot-${slot.id}`}
          className="rounded-md border border-subtle px-3 py-2"
        >
          <div className="flex items-center gap-2">
            <Paperclip className="size-4 shrink-0 text-tertiary" />
            <div className="min-w-0 flex-1 text-center">
              {editor?.id === slot.id ? (
                <>
                  <input
                    ref={nameInput}
                    data-testid={`attachment-slot-name-input-${slot.id}`}
                    aria-label={t("attachment.slots.name")}
                    aria-invalid={Boolean(editor.error)}
                    className="w-full rounded border border-subtle bg-transparent px-2 py-1 text-center text-13"
                    value={editor.name}
                    disabled={busy !== null}
                    onChange={(event) => setEditor({ id: slot.id, name: event.target.value })}
                    onBlur={() => void saveName()}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        setEditor(null);
                      } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        event.stopPropagation();
                        void saveName();
                      }
                    }}
                  />
                  {editor.error && (
                    <p role="alert" className="text-13 text-danger-primary">
                      {t(editor.error)}
                    </p>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  data-testid={`attachment-slot-name-${slot.id}`}
                  className="w-full text-center text-13 font-medium break-words"
                  disabled={!editable || busy !== null}
                  onClick={() => setEditor({ id: slot.id, name: slot.name })}
                >
                  {slot.name}
                </button>
              )}
            </div>
            {editable && (
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null || editor !== null}
                  onClick={() => fileInputs.current.get(slot.id)?.click()}
                >
                  {t(slot.attachment ? "attachment.slots.replace" : "attachment.slots.upload")}
                </Button>
                {canDeleteFile(slot) && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy !== null || editor !== null}
                    onClick={() => setDeleting({ slot, file: true })}
                  >
                    {t("attachment.slots.delete_file")}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null || editor !== null}
                  onClick={() => setDeleting({ slot, file: false })}
                >
                  {t("attachment.slots.delete_slot")}
                </Button>
                <input
                  ref={(element) => {
                    if (element) fileInputs.current.set(slot.id, element);
                    else fileInputs.current.delete(slot.id);
                  }}
                  type="file"
                  aria-label={`${slot.name}: ${t(slot.attachment ? "attachment.slots.replace" : "attachment.slots.upload")}`}
                  className="hidden"
                  disabled={busy !== null || editor !== null}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file || lock.current || editor) return;
                    setErrorFileSize(file.size);
                    setErrorDetails("");
                    if (file.size > maxFileSize) {
                      setError("attachment.file_size_limit");
                      setErrorDetails("file-too-large");
                      return;
                    }
                    lock.current = true;
                    setBusy(slot.id);
                    setError(null);
                    try {
                      await attachmentHelpers.operations.create(file, slot.id);
                    } catch (cause: unknown) {
                      if (active.current) {
                        setError(getAttachmentUploadErrorKey(cause));
                        setErrorDetails(getAttachmentUploadErrorDetails(cause));
                      }
                    } finally {
                      lock.current = false;
                      if (active.current) setBusy(null);
                    }
                  }}
                />
              </div>
            )}
          </div>
          {slot.attachment && (
            <a
              className="mt-1 block text-center text-11 break-all text-accent-primary"
              href={getFileURL(slot.attachment.asset_url)}
              target="_blank"
              rel="noopener noreferrer"
              download={slot.attachment.attributes.name}
            >
              {slot.attachment.attributes.name} · {t("attachment.slots.download")}
            </a>
          )}
        </div>
      ))}
      {deleting && editable && (!deleting.file || canDeleteFile(deleting.slot)) && (
        <AttachmentConfirm
          title={t(deleting.file ? "attachment.slots.delete_file" : "attachment.slots.delete_slot")}
          message={t(deleting.file ? "attachment.slots.delete_file_help" : "attachment.slots.delete_slot_help", {
            name: deleting.file
              ? (deleting.slot.attachment?.attributes.name ?? deleting.slot.name)
              : deleting.slot.name,
          })}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            if (deleting.file && deleting.slot.attachment)
              await attachment.removeAttachment(workspaceSlug, projectId, issueId, deleting.slot.attachment.id);
            else await attachment.removeAttachmentSlot(workspaceSlug, projectId, issueId, deleting.slot.id);
          }}
        />
      )}
    </div>
  );
});
