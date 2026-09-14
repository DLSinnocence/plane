/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { Plus } from "lucide-react";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { EIssueServiceType } from "@plane/types";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useUserPermissions } from "@/hooks/store/user";
import { nextEmptyAttachmentName } from "./slot-helpers";

export const EmptyAttachmentActionButton = observer(function EmptyAttachmentActionButton({
  workspaceSlug,
  projectId,
  issueId,
  onCreated,
}: {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { attachment } = useIssueDetail(EIssueServiceType.ISSUES);
  const { allowPermissions } = useUserPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const lock = useRef(false);
  const requestScope = useRef<object | null>(null);
  useLayoutEffect(() => {
    requestScope.current = {};
    lock.current = false;
    setBusy(false);
    setError(false);
    return () => {
      requestScope.current = null;
    };
  }, [workspaceSlug, projectId, issueId]);
  if (
    !allowPermissions([EUserPermissions.ADMIN, EUserPermissions.MEMBER], EUserPermissionsLevel.WORKSPACE, workspaceSlug)
  )
    return null;
  return (
    <div className="flex items-center gap-2">
      {error && (
        <span role="alert" className="text-13 text-danger-primary">
          {t("attachment.slots.error")}
        </span>
      )}
      <Button
        variant="secondary"
        size="sm"
        data-testid="add-empty-attachment"
        aria-label={t("attachment.slots.add")}
        disabled={busy || (attachment.getAttachmentSlotsByIssueId(issueId)?.length ?? 0) >= 50}
        onClick={async (event) => {
          event.stopPropagation();
          const scope = requestScope.current;
          if (lock.current || !scope) return;
          const isCurrent = () => requestScope.current === scope;
          lock.current = true;
          setBusy(true);
          setError(false);
          try {
            await attachment.fetchAttachmentSlots(workspaceSlug, projectId, issueId);
            if (!isCurrent()) return;
            const slots = attachment.getAttachmentSlotsByIssueId(issueId) ?? [];
            if (slots.length >= 50) return;
            const slot = await attachment.createAttachmentSlot(
              workspaceSlug,
              projectId,
              issueId,
              nextEmptyAttachmentName(
                slots.map((item) => item.name),
                t("attachment.slots.default_name")
              )
            );
            if (isCurrent()) onCreated(slot.id);
          } catch {
            if (isCurrent()) {
              setError(true);
              await attachment.fetchAttachmentSlots(workspaceSlug, projectId, issueId).catch(() => undefined);
            }
          } finally {
            if (isCurrent()) {
              lock.current = false;
              setBusy(false);
            }
          }
        }}
      >
        <Plus className="size-3.5" />
      </Button>
    </div>
  );
});
