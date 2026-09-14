/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { EIssueServiceType } from "@plane/types";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useUserPermissions } from "@/hooks/store/user";
import { AttachmentTemplateLibrary } from "./template-library";

export const AttachmentTemplateLibraryButton = observer(function AttachmentTemplateLibraryButton({
  workspaceSlug,
  projectId,
  issueId,
  disabled,
}: {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const { attachment } = useIssueDetail(EIssueServiceType.ISSUES);
  const { allowPermissions } = useUserPermissions();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const lock = useRef(false);
  const requestScope = useRef<object | null>(null);
  useLayoutEffect(() => {
    requestScope.current = {};
    lock.current = false;
    setOpen(false);
    setLoading(false);
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
    <>
      <Button
        variant="secondary"
        size="lg"
        data-testid="attachment-template-library-button"
        disabled={loading}
        onClick={async () => {
          const scope = requestScope.current;
          if (lock.current || !scope) return;
          const isCurrent = () => requestScope.current === scope;
          lock.current = true;
          setLoading(true);
          setError(false);
          try {
            await attachment.fetchAttachmentSlots(workspaceSlug, projectId, issueId);
            if (isCurrent()) setOpen(true);
          } catch {
            if (isCurrent()) setError(true);
          } finally {
            if (isCurrent()) {
              lock.current = false;
              setLoading(false);
            }
          }
        }}
      >
        {t("attachment.slots.library")}
      </Button>
      {error && (
        <span role="alert" className="text-13 text-danger-primary">
          {t("attachment.slots.error")}
        </span>
      )}
      {open && (
        <AttachmentTemplateLibrary
          workspaceSlug={workspaceSlug}
          slotNames={(attachment.getAttachmentSlotsByIssueId(issueId) ?? []).map((slot) => slot.name)}
          canApply={!disabled}
          onClose={() => setOpen(false)}
          onApply={(id) => attachment.applyAttachmentTemplate(workspaceSlug, projectId, issueId, id)}
        />
      )}
    </>
  );
});
