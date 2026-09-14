/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { Paperclip } from "lucide-react";
import { DeleteOutline, UploadOutline } from "@makeplane/propel/icons";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { EIssueServiceType } from "@plane/types";
import type { TIssueAttachmentSlot } from "@plane/types";
import { CustomMenu } from "@plane/ui";
import { convertBytesToSize, getFileExtension, getFileURL } from "@plane/utils";
import { ButtonAvatars } from "@/components/dropdowns/member/avatar";
import { getFileIcon } from "@/components/icons";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useUser, useUserPermissions } from "@/hooks/store/user";
import { getAttachmentUploadErrorKey, getAttachmentUploadErrorDetails } from "@/helpers/attachment-upload";
import { useFileSize } from "@/hooks/use-file-size";
import type { TAttachmentHelpers } from "../issue-detail-widgets/attachments/helper";
import { AttachmentConfirm } from "./slot-dialogs";
import { IssueAttachmentsUploadItem } from "./attachment-list-upload-item";
import { validateAttachmentName } from "./slot-helpers";

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
  const canDeleteSlot = (slot: TIssueAttachmentSlot) => editable && (!slot.attachment || canDeleteFile(slot));
  const canUploadToSlot = (slot: TIssueAttachmentSlot) => editable && (!slot.attachment || canDeleteFile(slot));
  const { maxFileSize } = useFileSize();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState("");
  const [errorFileSize, setErrorFileSize] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const [editor, setEditor] = useState<{ id: string; name: string; error?: string } | null>(null);
  const [deleting, setDeleting] = useState<TIssueAttachmentSlot | null>(null);
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
  const hasUnsavedName = editor !== null && editor.name.trim() !== slots.find((slot) => slot.id === editor.id)?.name;
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
    const validation = validateAttachmentName(
      name,
      slots.filter((slot) => slot.id !== editor.id).map((slot) => slot.name)
    );
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
  const chooseFile = (slotId: string) => {
    const slot = slots.find((item) => item.id === slotId);
    if (!slot || !canUploadToSlot(slot) || lock.current || hasUnsavedName) return;
    setEditor(null);
    fileInputs.current.get(slotId)?.click();
  };

  return (
    <div>
      {attachmentHelpers.snapshot.uploadStatus?.map((status) => (
        <IssueAttachmentsUploadItem key={status.id} uploadStatus={status} />
      ))}
      {!ready && !error && (
        <p role="status" className="px-3 py-2 text-13 text-tertiary">
          {t("attachment.slots.loading")}
        </p>
      )}
      {error && (
        <div role="alert" className="px-3 py-2 text-13 text-danger-primary">
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
          className="group grid min-h-11 grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] items-center gap-3 px-3 py-1 hover:bg-surface-2"
        >
          <div data-testid={`attachment-slot-label-${slot.id}`} className="flex min-w-0 items-center gap-3">
            <span className="flex shrink-0 items-center text-tertiary">
              {slot.attachment ? (
                getFileIcon(getFileExtension(slot.attachment.attributes.name), 18)
              ) : (
                <Paperclip className="size-4" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              {editor?.id === slot.id ? (
                <>
                  <input
                    ref={nameInput}
                    data-testid={`attachment-slot-name-input-${slot.id}`}
                    aria-label={t("attachment.slots.name")}
                    aria-invalid={Boolean(editor.error)}
                    className="w-full rounded border border-subtle bg-transparent px-2 py-1 text-left text-13"
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
                  className="block w-full truncate text-left text-13 font-medium text-secondary"
                  title={slot.name}
                  disabled={!editable || busy !== null}
                  onClick={() => setEditor({ id: slot.id, name: slot.name })}
                >
                  {slot.name}
                </button>
              )}
            </div>
          </div>
          <div
            data-testid={`attachment-slot-content-${slot.id}`}
            className="flex min-w-0 items-center justify-center gap-3 text-13"
          >
            {slot.attachment ? (
              <a
                data-testid={`attachment-slot-file-${slot.id}`}
                className="min-w-0 truncate text-center font-medium text-secondary hover:text-accent-primary"
                title={slot.attachment.attributes.name}
                href={getFileURL(slot.attachment.asset_url)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {slot.attachment.attributes.name}
              </a>
            ) : (
              <button
                type="button"
                data-testid={`attachment-slot-file-${slot.id}`}
                className="min-w-0 truncate text-center text-placeholder hover:text-secondary disabled:cursor-not-allowed"
                aria-label={`${slot.name}: ${t("attachment.slots.upload")}`}
                disabled={!editable || busy !== null || hasUnsavedName}
                onClick={() => chooseFile(slot.id)}
              >
                {t(busy === slot.id ? "attachment.slots.uploading" : "attachment.slots.empty_slot")}
              </button>
            )}
          </div>
          <div
            data-testid={`attachment-slot-actions-${slot.id}`}
            className="flex min-w-0 items-center justify-end gap-3"
          >
            {slot.attachment && (
              <span className="hidden shrink-0 text-13 text-placeholder sm:inline">
                {convertBytesToSize(slot.attachment.attributes.size)}
              </span>
            )}
            {slot.attachment?.created_by && (
              <div className="flex shrink-0 items-center justify-center">
                <ButtonAvatars showTooltip userIds={slot.attachment.created_by} />
              </div>
            )}
            {canDeleteSlot(slot) && (
              <CustomMenu ellipsis closeOnSelect placement="bottom-end" disabled={busy !== null || hasUnsavedName}>
                {slot.attachment && (
                  <CustomMenu.MenuItem className="flex items-center gap-2" onClick={() => chooseFile(slot.id)}>
                    <UploadOutline className="h-3.5 w-3.5" />
                    <span>{t("attachment.slots.replace")}</span>
                  </CustomMenu.MenuItem>
                )}
                <CustomMenu.MenuItem className="flex items-center gap-2" onClick={() => setDeleting(slot)}>
                  <DeleteOutline className="h-3.5 w-3.5" />
                  <span>{t("attachment.slots.delete_slot")}</span>
                </CustomMenu.MenuItem>
              </CustomMenu>
            )}
          </div>
          {canUploadToSlot(slot) && (
            <input
              ref={(element) => {
                if (element) fileInputs.current.set(slot.id, element);
                else fileInputs.current.delete(slot.id);
              }}
              type="file"
              aria-label={`${slot.name}: ${t(slot.attachment ? "attachment.slots.replace" : "attachment.slots.upload")}`}
              className="hidden"
              disabled={busy !== null || hasUnsavedName}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file || lock.current || hasUnsavedName) return;
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
          )}
        </div>
      ))}
      {deleting && canDeleteSlot(deleting) && (
        <AttachmentConfirm
          title={t("attachment.slots.delete_slot")}
          message={t("attachment.slots.delete_slot_help", { name: deleting.name })}
          onClose={() => setDeleting(null)}
          onConfirm={() => attachment.removeAttachmentSlot(workspaceSlug, projectId, issueId, deleting.id)}
        />
      )}
    </div>
  );
});
