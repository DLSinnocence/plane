# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import json
from datetime import timedelta

# Third party imports
from celery import shared_task
from django.db.models import Q

# Django imports
from django.utils import timezone

# Module imports
from plane.bgtasks.issue_activities_task import issue_activity
from functools import partial
from django.db import transaction
from plane.db.models import Issue, IssueAssignee, Project, ProjectMember, State
from plane.utils.exception_logger import log_exception


@shared_task
def archive_and_close_old_issues():
    archive_old_issues()
    close_old_issues()


def archive_old_issues():
    try:
        # Get all the projects whose archive_in is greater than 0
        projects = Project.objects.filter(archive_in__gt=0)

        for project in projects:
            project_id = project.id
            archive_in = project.archive_in

            # Get all the issues whose updated_at in less that the archive_in month
            issues = Issue.issue_objects.filter(
                Q(
                    project=project_id,
                    archived_at__isnull=True,
                    updated_at__lte=(timezone.now() - timedelta(days=archive_in * 30)),
                    state__group__in=["completed", "cancelled"],
                ),
                Q(issue_cycle__isnull=True)
                | (Q(issue_cycle__cycle__end_date__lt=timezone.now()) & Q(issue_cycle__isnull=False)),
                Q(issue_module__isnull=True)
                | (Q(issue_module__module__target_date__lt=timezone.now()) & Q(issue_module__isnull=False)),
            ).filter(
                Q(issue_intake__status=1)
                | Q(issue_intake__status=-1)
                | Q(issue_intake__status=2)
                | Q(issue_intake__isnull=True)
            )

            # Check if Issues
            if issues:
                # Set the archive time to current time
                archive_at = timezone.now().date()

                issues_to_update = []
                for issue in issues:
                    issue.archived_at = archive_at
                    issues_to_update.append(issue)

                # Bulk Update the issues and log the activity
                if issues_to_update:
                    Issue.objects.bulk_update(issues_to_update, ["archived_at"], batch_size=100)
                    _ = [
                        issue_activity.delay(
                            type="issue.activity.updated",
                            requested_data=json.dumps({"archived_at": str(archive_at), "automation": True}),
                            actor_id=str(project.created_by_id),
                            issue_id=issue.id,
                            project_id=project_id,
                            current_instance=json.dumps({"archived_at": None}),
                            subscriber=False,
                            epoch=int(timezone.now().timestamp()),
                            notification=True,
                        )
                        for issue in issues_to_update
                    ]
        return
    except Exception as e:
        log_exception(e)
        return


def close_old_issues():
    try:
        # Get all the projects whose close_in is greater than 0
        projects = Project.objects.filter(close_in__gt=0).select_related("default_state")

        for project in projects:
            project_id = project.id
            close_in = project.close_in

            # Get all the issues whose updated_at in less that the close_in month
            issues = Issue.issue_objects.filter(
                Q(
                    project=project_id,
                    archived_at__isnull=True,
                    updated_at__lte=(timezone.now() - timedelta(days=close_in * 30)),
                    state__group__in=["backlog", "unstarted", "started"],
                ),
                Q(issue_cycle__isnull=True)
                | (Q(issue_cycle__cycle__end_date__lt=timezone.now()) & Q(issue_cycle__isnull=False)),
                Q(issue_module__isnull=True)
                | (Q(issue_module__module__target_date__lt=timezone.now()) & Q(issue_module__isnull=False)),
            ).filter(
                Q(issue_intake__status=1)
                | Q(issue_intake__status=-1)
                | Q(issue_intake__status=2)
                | Q(issue_intake__isnull=True)
            )

            # Project automation is a system action. It still uses the same
            # issue lock and destination assignment semantics as user handoffs.
            close_state = project.default_state or State.objects.filter(
                project_id=project_id, group="cancelled"
            ).first()
            if close_state is None or close_state.project_id != project_id:
                continue
            for issue_id in issues.values_list("id", flat=True).distinct():
                with transaction.atomic():
                    issue = Issue.objects.select_for_update().get(pk=issue_id)
                    # A user may have changed the issue after candidate selection.
                    if not issues.filter(pk=issue_id).exists():
                        continue
                    assignee_key = str(close_state.id)
                    requested_data = {"closed_to": assignee_key}
                    current_instance = {
                        "assignee_ids": [
                            str(pk) for pk in IssueAssignee.objects.filter(issue=issue)
                            .values_list("assignee_id", flat=True)
                        ]
                    }
                    if assignee_key in issue.state_assignees:
                        assigned = issue.state_assignees[assignee_key]
                        valid_members = {
                            str(pk) for pk in ProjectMember.objects.filter(
                                project_id=project_id, is_active=True, role__gte=15,
                                member__is_active=True, member_id__in=assigned
                            ).values_list("member_id", flat=True)
                        }
                        # Do not activate an obsolete plan after a member leaves.
                        if set(assigned) - valid_members:
                            continue
                        IssueAssignee.objects.filter(issue=issue).delete()
                        IssueAssignee.objects.bulk_create([
                            IssueAssignee(
                                issue=issue, project_id=project_id, workspace_id=issue.workspace_id,
                                assignee_id=member, created_by_id=project.created_by_id,
                            ) for member in assigned
                        ], ignore_conflicts=True)
                        requested_data["assignee_ids"] = assigned
                    issue.state = close_state
                    issue.save()
                    transaction.on_commit(partial(
                        issue_activity.delay,
                        type="issue.activity.updated",
                        requested_data=json.dumps(requested_data),
                        actor_id=str(project.created_by_id),
                        issue_id=issue.id,
                        project_id=project_id,
                        current_instance=json.dumps(current_instance),
                        subscriber=False,
                        epoch=int(timezone.now().timestamp()),
                        notification=True,
                    ))
        return
    except Exception as e:
        log_exception(e)
        return
