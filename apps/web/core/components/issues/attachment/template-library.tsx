/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type { TAttachmentTemplate } from "@plane/types";
import { AttachmentTemplateService } from "@/services/issue/attachment-template.service";
import { AttachmentConfirm, AttachmentDialog, AttachmentNameForm } from "./slot-dialogs";
import { missingSlotNames, validateSlotNames } from "./slot-helpers";

const service = new AttachmentTemplateService();
export function AttachmentTemplateLibrary({
  workspaceSlug,
  slotNames,
  canApply,
  onApply,
  onClose,
  saveCurrent = false,
}: {
  workspaceSlug: string;
  slotNames: string[];
  canApply: boolean;
  onApply: (id: string) => Promise<unknown>;
  onClose: () => void;
  saveCurrent?: boolean;
}) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<TAttachmentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [editor, setEditor] = useState<{ id?: string; name: string; slots: string[] } | null>(
    saveCurrent ? { name: "", slots: slotNames } : null
  );
  const [deleting, setDeleting] = useState<TAttachmentTemplate | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setTemplates([]);
    service
      .fetchTemplates(workspaceSlug)
      .then((data) => {
        if (!cancelled) setTemplates(data);
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceSlug, retry]);
  return (
    <>
      <AttachmentDialog title={t("attachment.slots.library")} onClose={onClose}>
        <p className="text-13 text-tertiary">{t("attachment.slots.library_help")}</p>
        <Button
          variant="secondary"
          size="sm"
          disabled={loading || error || busy !== null}
          onClick={() => setEditor({ name: "", slots: [""] })}
        >
          {t("attachment.slots.new_template")}
        </Button>
        {loading ? (
          <p role="status">{t("attachment.slots.loading")}</p>
        ) : error ? (
          <div role="alert">
            <p>{t("attachment.slots.error")}</p>
            <Button variant="secondary" onClick={() => setRetry(retry + 1)}>
              {t("attachment.slots.retry")}
            </Button>
          </div>
        ) : (
          <div className="max-h-96 space-y-3 overflow-y-auto">
            {!templates.length && <p className="text-13 text-tertiary">{t("attachment.slots.no_templates")}</p>}
            {templates.map((template) => {
              const missing = missingSlotNames(slotNames, template.slots);
              return (
                <div key={template.id} className="space-y-2 rounded-md border border-subtle p-3">
                  <p className="font-medium break-words">{template.name}</p>
                  <p className="text-13 break-words text-tertiary">{template.slots.join(" · ")}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!canApply || busy !== null || slotNames.length + missing.length > 50}
                      loading={busy === template.id}
                      onClick={async () => {
                        setBusy(template.id);
                        setError(false);
                        try {
                          await onApply(template.id);
                          if (active.current) onClose();
                        } catch {
                          if (active.current) setError(true);
                        } finally {
                          if (active.current) setBusy(null);
                        }
                      }}
                    >
                      {t("attachment.slots.apply")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => setEditor({ id: template.id, name: template.name, slots: [...template.slots] })}
                    >
                      {t("attachment.slots.edit")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => setDeleting(template)}
                    >
                      {t("attachment.slots.remove")}
                    </Button>
                  </div>
                  {slotNames.length + missing.length > 50 && (
                    <p className="text-13 text-danger-primary">{t("attachment.slots.limit")}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </AttachmentDialog>
      {editor && !loading && !error && (
        <AttachmentNameForm
          title={t(editor.id ? "attachment.slots.edit_template" : "attachment.slots.new_template")}
          initialName={editor.name}
          initialSlots={editor.slots}
          onClose={() => setEditor(null)}
          onSave={async (name, slots) => {
            if (!name || [...name].length > 100 || !slots || validateSlotNames(slots))
              throw new Error("Invalid template");
            const result = editor.id
              ? await service.updateTemplate(workspaceSlug, editor.id, { name, slots })
              : await service.createTemplate(workspaceSlug, { name, slots });
            if (active.current)
              setTemplates((previous) => [...previous.filter((item) => item.id !== result.id), result]);
          }}
        />
      )}
      {deleting && (
        <AttachmentConfirm
          title={t("attachment.slots.delete_template")}
          message={t("attachment.slots.delete_template_help", { name: deleting.name })}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await service.deleteTemplate(workspaceSlug, deleting.id);
            if (active.current) setTemplates((previous) => previous.filter((item) => item.id !== deleting.id));
          }}
        />
      )}
    </>
  );
}
