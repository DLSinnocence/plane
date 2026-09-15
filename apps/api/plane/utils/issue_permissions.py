# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from rest_framework.exceptions import PermissionDenied

from plane.db.models import ProjectMember, WorkspaceMember


FIXED_ASSIGNEE_STATE_GROUPS = frozenset({"backlog", "completed", "cancelled"})


def project_access_role(user, project_id, workspace_id):
    """Require active access to both the workspace and the specific project."""
    if not user or not getattr(user, "is_active", False) or not getattr(user, "pk", None):
        return None
    membership = ProjectMember.objects.filter(
        project_id=project_id,
        workspace_id=workspace_id,
        project__workspace_id=workspace_id,
        project__deleted_at__isnull=True,
        member_id=user.pk,
        member__is_active=True,
        is_active=True,
    ).first()
    if membership is None:
        return None
    workspace_role = (
        WorkspaceMember.objects.filter(
            workspace_id=workspace_id,
            workspace__deleted_at__isnull=True,
            member_id=user.pk,
            is_active=True,
        )
        .values_list("role", flat=True)
        .first()
    )
    if workspace_role is None:
        return None
    return 20 if workspace_role == 20 else membership.role


def has_project_admin_access(user, project_id, workspace_id):
    return project_access_role(user, project_id, workspace_id) == 20


def require_project_admin_access(user, project_id, workspace_id):
    if not has_project_admin_access(user, project_id, workspace_id):
        raise PermissionDenied("Only administrators may create or accept project work items. Submit through intake.")


def is_issue_creator_or_assignee(user, issue):
    """Use the saved current stage, never proposed assignments or a future stage."""
    actor_id = str(user.pk)
    if str(issue.created_by_id) == actor_id:
        return True
    if getattr(issue.state, "group", None) in FIXED_ASSIGNEE_STATE_GROUPS:
        return False
    current = (issue.state_assignees or {}).get(str(issue.state_id), [])
    return isinstance(current, list) and actor_id in current


def has_issue_write_access(user, issue):
    role = project_access_role(user, issue.project_id, issue.workspace_id)
    return role == 20 or (role == 15 and is_issue_creator_or_assignee(user, issue))


def require_intake_write_access(user, issue):
    role = project_access_role(user, issue.project_id, issue.workspace_id)
    if role == 5 and str(issue.created_by_id) == str(user.pk) and getattr(issue.state, "group", None) == "triage":
        return
    require_issue_write_access(user, issue)


def require_issue_write_access(user, issue):
    """Call with the persisted issue under its row lock before making changes."""
    if not has_issue_write_access(user, issue):
        raise PermissionDenied("Only administrators, the creator, or current assignees may modify this work item.")
