# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""Lock persisted work items before authorizing association and bulk writes."""

from django.db import transaction
from rest_framework.exceptions import PermissionDenied

from plane.db.models import Cycle, CycleIssue, Issue
from plane.utils.issue_permissions import require_issue_write_access


def lock_issue_write_scope(user, slug, issue_ids, project_id=None):
    """Return every requested issue, or reject the entire batch before any writes.

    Callers must keep the surrounding transaction open through the mutation.
    Explicit primary-database reads avoid authorizing stale replica state.
    """
    if not transaction.get_connection().in_atomic_block:
        raise RuntimeError("Issue write authorization requires an atomic transaction")
    ids = {str(issue_id) for issue_id in issue_ids}
    queryset = Issue.objects.using("default").filter(workspace__slug=slug, pk__in=ids)
    if project_id is not None:
        queryset = queryset.filter(project_id=project_id)
    issues = list(queryset.order_by("pk").select_for_update())
    if {str(issue.pk) for issue in issues} != ids:
        raise PermissionDenied("One or more work items are unavailable for this operation.")
    for issue in issues:
        require_issue_write_access(user, issue)
    return issues


def lock_issue_delete_scope(user, slug, issue_id, project_id):
    """Lock and authorize every active issue affected by the parent CASCADE.

    Traverse without project filters so historical cross-project parent links
    cannot hide descendants. Each discovered issue is scoped to the workspace
    and authorized against its own persisted project membership. Parent locks
    are retained through deletion; visited IDs also make corrupt cycles finite.
    """
    root = lock_issue_write_scope(user, slug, [issue_id], project_id)[0]
    visited = {root.pk}
    frontier = [root.pk]
    while frontier:
        child_ids = list(
            Issue.objects.using("default")
            .filter(parent_id__in=frontier)
            .exclude(pk__in=visited)
            .values_list("pk", flat=True)
        )
        children = lock_issue_write_scope(user, slug, child_ids)
        frontier = [issue.pk for issue in children]
        visited.update(frontier)
    return root


def lock_cycle_write_scope(slug, project_id):
    """Serialize cycle association changes, including transfers, before issue locks."""
    return list(
        Cycle.objects.using("default")
        .filter(workspace__slug=slug, project_id=project_id)
        .order_by("pk")
        .select_for_update()
    )


def authorize_cycle_transfer(user, slug, project_id, cycle_id):
    """Stabilize cycle membership and state, then authorize only transferred issues."""
    lock_cycle_write_scope(slug, project_id)
    # Lock every project issue: a completed issue may concurrently become unfinished.
    list(
        Issue.objects.using("default")
        .filter(workspace__slug=slug, project_id=project_id)
        .order_by("pk")
        .select_for_update()
    )
    issue_ids = CycleIssue.objects.using("default").filter(
        workspace__slug=slug,
        project_id=project_id,
        cycle_id=cycle_id,
        issue__archived_at__isnull=True,
        issue__is_draft=False,
        issue__state__group__in=["backlog", "unstarted", "started"],
    ).values_list("issue_id", flat=True)
    lock_issue_write_scope(user, slug, issue_ids, project_id)
