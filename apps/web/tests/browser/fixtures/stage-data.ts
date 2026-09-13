/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export const workflowStates = [
  { id: "backlog", name: "Backlog", group: "backlog", color: "#888888", default: true },
  { id: "todo", name: "Planning", group: "unstarted", color: "#aaaaaa", default: false },
  { id: "started", name: "Developing", group: "started", color: "#ffbb00", default: false },
  { id: "done", name: "Done", group: "completed", color: "#00bb88", default: false },
  { id: "cancelled", name: "Cancelled", group: "cancelled", color: "#cc4444", default: false },
];
