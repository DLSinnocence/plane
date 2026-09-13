/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
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
import { AttachmentConfirm, AttachmentNameForm } from "./slot-dialogs";
import { AttachmentTemplateLibrary } from "./template-library";
import { validateSlotNames } from "./slot-helpers";

export const IssueAttachmentSlots = observer(function IssueAttachmentSlots({
  workspaceSlug,
  projectId,
  issueId,
  disabled,
  attachmentHelpers,
}: {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  disabled: boolean;
  attachmentHelpers: TAttachmentHelpers;
}) {
  const { t } = useTranslation();
  const { attachment } = useIssueDetail(EIssueServiceType.ISSUES);
  const { allowPermissions } = useUserPermissions();
  const canConfigure = allowPermissions(
    [EUserPermissions.ADMIN, EUserPermissions.MEMBER],
    EUserPermissionsLevel.WORKSPACE,
    workspaceSlug
  );
  const editable = canConfigure && !disabled;
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
  const [editor, setEditor] = useState<{ id?: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<{ slot: TIssueAttachmentSlot; file: boolean } | null>(null);
  const [library, setLibrary] = useState<"browse" | "save" | null>(null);
  const fileInputs = useRef(new Map<string, HTMLInputElement>());
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
    setErrorDetails("");
    setErrorFileSize(null);
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
  const slots = ready ? (attachment.getAttachmentSlotsByIssueId(issueId) ?? []) : [];
  return (
    <div className="space-y-3 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="mr-auto text-13 font-medium">{t("attachment.slots.title")}</h4>
        {editable && (
          <Button
            variant="secondary"
            size="sm"
            disabled={!ready || slots.length >= 50 || busy !== null}
            onClick={() => setEditor({ name: "" })}
          >
            {t("attachment.slots.add")}
          </Button>
        )}
        {canConfigure && (
          <Button variant="secondary" size="sm" disabled={!ready} onClick={() => setLibrary("browse")}>
            {t("attachment.slots.library")}
          </Button>
        )}
        {canConfigure && slots.length > 0 && (
          <Button variant="secondary" size="sm" onClick={() => setLibrary("save")}>
            {t("attachment.slots.save_template")}
          </Button>
        )}
      </div>
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
      {ready && !slots.length && <p className="text-13 text-tertiary">{t("attachment.slots.empty")}</p>}
      {slots.length > 0 && <p className="text-13 text-tertiary">{t("attachment.slots.preserve_help")}</p>}
      {slots.map((slot) => (
        <div key={slot.id} className="space-y-2 rounded-md border border-subtle p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-auto text-13 font-medium break-words">{slot.name}</span>
            {editable && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => setEditor({ id: slot.id, name: slot.name })}
                >
                  {t("attachment.slots.rename")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => setDeleting({ slot, file: false })}
                >
                  {t("attachment.slots.delete_slot")}
                </Button>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {slot.attachment ? (
              <>
                <a
                  className="mr-auto text-13 break-all text-accent-primary"
                  href={getFileURL(slot.attachment.asset_url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  download={slot.attachment.attributes.name}
                >
                  {slot.attachment.attributes.name} · {t("attachment.slots.download")}
                </a>
                {canDeleteFile(slot) && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => setDeleting({ slot, file: true })}
                  >
                    {t("attachment.slots.delete_file")}
                  </Button>
                )}
              </>
            ) : (
              <span className="mr-auto text-13 text-tertiary">{t("attachment.slots.empty_slot")}</span>
            )}
            {editable && (
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null}
                  loading={busy === slot.id}
                  onClick={() => fileInputs.current.get(slot.id)?.click()}
                >
                  {busy === slot.id
                    ? t("attachment.slots.uploading")
                    : t(slot.attachment ? "attachment.slots.replace" : "attachment.slots.upload")}
                </Button>
                <input
                  ref={(element) => {
                    if (element) fileInputs.current.set(slot.id, element);
                    else fileInputs.current.delete(slot.id);
                  }}
                  type="file"
                  aria-label={`${slot.name}: ${t(slot.attachment ? "attachment.slots.replace" : "attachment.slots.upload")}`}
                  className="hidden"
                  disabled={busy !== null}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file || busy !== null) return;
                    setErrorFileSize(file.size);
                    setErrorDetails("");
                    if (file.size > maxFileSize) {
                      setError("attachment.file_size_limit");
                      setErrorDetails("file-too-large");
                      return;
                    }
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
                      if (active.current) setBusy(null);
                    }
                  }}
                />
              </div>
            )}
          </div>
        </div>
      ))}
      {editor && editable && (
        <AttachmentNameForm
          title={t(editor.id ? "attachment.slots.rename" : "attachment.slots.add")}
          initialName={editor.name}
          onClose={() => setEditor(null)}
          onSave={async (name) => {
            if (validateSlotNames([...slots.filter((slot) => slot.id !== editor.id).map((slot) => slot.name), name]))
              throw new Error("Invalid slot name");
            if (editor.id) await attachment.updateAttachmentSlot(workspaceSlug, projectId, issueId, editor.id, name);
            else await attachment.createAttachmentSlot(workspaceSlug, projectId, issueId, name);
          }}
        />
      )}
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
      {library && canConfigure && (
        <AttachmentTemplateLibrary
          key={workspaceSlug}
          workspaceSlug={workspaceSlug}
          slotNames={slots.map((slot) => slot.name)}
          canApply={editable && busy === null}
          saveCurrent={library === "save"}
          onClose={() => setLibrary(null)}
          onApply={(id) => attachment.applyAttachmentTemplate(workspaceSlug, projectId, issueId, id)}
        />
      )}
    </div>
  );
});
