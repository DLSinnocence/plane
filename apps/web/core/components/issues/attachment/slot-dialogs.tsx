/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { Input, InputGroup } from "@makeplane/propel/components/input";
import { Button } from "@plane/propel/button";
import { useTranslation } from "@plane/i18n";
import { ModalCore } from "@plane/ui";

export function AttachmentDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <ModalCore isOpen handleClose={onClose}>
      <div className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-h4-medium text-secondary">{title}</h3>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t("attachment.slots.close")}
          </Button>
        </div>
        {children}
      </div>
    </ModalCore>
  );
}

export function AttachmentNameForm({
  initialName = "",
  initialSlots,
  onSave,
  onClose,
  title,
}: {
  initialName?: string;
  initialSlots?: string[];
  onSave: (name: string, slots?: string[]) => Promise<void>;
  onClose: () => void;
  title: string;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const nextSlotId = useRef(initialSlots?.length ?? 0);
  const [slots, setSlots] = useState(() => (initialSlots ?? []).map((slotName, id) => ({ id, name: slotName })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return (
    <AttachmentDialog title={title} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError(false);
          try {
            await onSave(name.trim(), initialSlots ? slots.map((slot) => slot.name.trim()) : undefined);
            if (active.current) onClose();
          } catch {
            if (active.current) setError(true);
          } finally {
            if (active.current) setBusy(false);
          }
        }}
      >
        <label className="block space-y-2">
          <span>{t("attachment.slots.name")}</span>
          <InputGroup size="lg">
            <Input size="lg" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
          </InputGroup>
        </label>
        {initialSlots && (
          <div className="max-h-64 space-y-2 overflow-y-auto">
            <p className="text-13 text-tertiary">{t("attachment.slots.template_rules")}</p>
            {slots.map((slot, index) => (
              <div key={slot.id} className="flex items-center gap-2">
                <InputGroup size="lg">
                  <Input
                    size="lg"
                    aria-label={`${t("attachment.slots.slot_name")} ${index + 1}`}
                    required
                    maxLength={100}
                    value={slot.name}
                    onChange={(event) =>
                      setSlots(
                        slots.map((value) => (value.id === slot.id ? { ...value, name: event.target.value } : value))
                      )
                    }
                  />
                </InputGroup>
                <Button variant="secondary" size="sm" onClick={() => setSlots(slots.filter((_, i) => i !== index))}>
                  {t("attachment.slots.remove")}
                </Button>
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              disabled={slots.length >= 50}
              onClick={() => setSlots([...slots, { id: nextSlotId.current++, name: "" }])}
            >
              {t("attachment.slots.add")}
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-13 text-danger-primary">
            {t("attachment.slots.save_error")}
          </p>
        )}
        <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
          {t("attachment.slots.save")}
        </Button>
      </form>
    </AttachmentDialog>
  );
}

export function AttachmentConfirm({
  title,
  message,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return (
    <AttachmentDialog title={title} onClose={onClose}>
      <p className="text-13 text-secondary">{message}</p>
      {error && (
        <p role="alert" className="text-danger-primary">
          {t("attachment.slots.error")}
        </p>
      )}
      <Button
        variant="primary"
        loading={busy}
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          setError(false);
          try {
            await onConfirm();
            if (active.current) onClose();
          } catch {
            if (active.current) setError(true);
          } finally {
            if (active.current) setBusy(false);
          }
        }}
      >
        {t("attachment.slots.confirm_delete")}
      </Button>
    </AttachmentDialog>
  );
}
