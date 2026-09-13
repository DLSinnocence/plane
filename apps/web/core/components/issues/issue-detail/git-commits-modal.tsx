/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Dialog } from "@headlessui/react";
import { useTranslation } from "@plane/i18n";
import { EModalWidth, ModalCore } from "@plane/ui";
import { IssueGitCommits } from "./git-commits";

type Props = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  isOpen: boolean;
  onClose: () => void;
};

export function IssueGitCommitsModal({ workspaceSlug, projectId, issueId, isOpen, onClose }: Props) {
  const { t } = useTranslation();

  return (
    <ModalCore isOpen={isOpen} handleClose={onClose} width={EModalWidth.XXL}>
      <div className="flex items-center justify-between gap-3 border-b border-subtle px-5 py-4">
        <Dialog.Title as="h3" className="text-16 font-medium">
          {t("gitea_integration.commits")}
        </Dialog.Title>
        <button type="button" className="shrink-0 rounded border border-subtle px-3 py-1 text-13" onClick={onClose}>
          {t("close")}
        </button>
      </div>
      <div className="vertical-scrollbar scrollbar-sm max-h-[70dvh] overflow-y-auto p-4">
        {isOpen && <IssueGitCommits workspaceSlug={workspaceSlug} projectId={projectId} issueId={issueId} />}
      </div>
    </ModalCore>
  );
}
