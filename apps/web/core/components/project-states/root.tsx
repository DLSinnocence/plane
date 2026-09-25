/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import useSWR from "swr";
import { ProjectStateLoader } from "@/components/project-states";
import { useProjectState } from "@/hooks/store/use-project-state";
import { ReadOnlyStateList } from "./read-only-list";

type TProjectState = {
  workspaceSlug: string;
  projectId: string;
};

export const ProjectStateRoot = observer(function ProjectStateRoot({ workspaceSlug, projectId }: TProjectState) {
  const { groupedProjectStates, fetchProjectStates } = useProjectState();
  useSWR(
    workspaceSlug && projectId ? `PROJECT_STATES_${workspaceSlug}_${projectId}` : null,
    workspaceSlug && projectId ? () => fetchProjectStates(workspaceSlug, projectId) : null,
    { revalidateIfStale: false, revalidateOnFocus: false }
  );

  if (!groupedProjectStates) return <ProjectStateLoader />;

  // State definitions are platform-managed for every project and every role.
  // Keep historical states visible without exposing any mutation or drag handlers.
  return <ReadOnlyStateList groupedStates={groupedProjectStates} />;
});
