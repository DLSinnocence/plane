# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.db import migrations, models


ACCEPTANCE_NAME = "开发完成/待验收"


def disable_testing(apps, schema_editor):
    alias = schema_editor.connection.alias
    State = apps.get_model("db", "State")
    ProjectMember = apps.get_model("db", "ProjectMember")
    model_pairs = [
        (apps.get_model("db", "Issue"), apps.get_model("db", "IssueAssignee"), "issue_id"),
        (apps.get_model("db", "DraftIssue"), apps.get_model("db", "DraftIssueAssignee"), "draft_issue_id"),
    ]
    # Historical base managers include archived and soft-deleted records.
    project_ids = set()
    for Item, _, _ in model_pairs:
        project_ids.update(
            Item._base_manager.using(alias).filter(state__is_testing=True).values_list("project_id", flat=True)
        )
    destinations = {}
    project_members = {}
    for project_id in project_ids:
        acceptance = State._base_manager.using(alias).filter(
            project_id=project_id, name=ACCEPTANCE_NAME, group="started",
            is_testing=False, is_triage=False, deleted_at__isnull=True,
        ).first()
        if acceptance is None:
            # Preflight every project before changing any data. Do not guess a
            # destination for projects with a renamed or missing acceptance stage.
            raise RuntimeError(
                f"Project {project_id} needs an active non-testing '{ACCEPTANCE_NAME}' state "
                "in the started group before migration 0137 can reset testing."
            )
        destinations[project_id] = acceptance.pk
        project_members[project_id] = {
            str(member_id)
            for member_id in ProjectMember._base_manager.using(alias).filter(
                project_id=project_id, deleted_at__isnull=True,
                is_active=True, role__gte=15, member__is_active=True,
            ).values_list("member_id", flat=True)
        }

    for Item, Assignment, item_field in model_pairs:
        items = Item._base_manager.using(alias)
        for item in items.filter(state__is_testing=True).iterator():
            destination_id = destinations[item.project_id]
            valid_members = project_members[item.project_id]
            plan = dict(item.state_assignees or {})
            key = str(destination_id)
            default = [str(item.created_by_id)] if str(item.created_by_id) in valid_members else []
            members = list(dict.fromkeys(member for member in plan.get(key, default) if member in valid_members))
            plan[key] = members
            items.filter(pk=item.pk).update(
                state_id=destination_id, state_assignees=plan, completed_at=None,
            )
            Assignment._base_manager.using(alias).filter(**{item_field: item.pk}).delete()
            Assignment._base_manager.using(alias).bulk_create([
                Assignment(
                    **{item_field: item.pk}, assignee_id=member,
                    project_id=item.project_id, workspace_id=item.workspace_id,
                    created_by_id=item.created_by_id, updated_by_id=item.updated_by_id,
                )
                for member in members
            ])
        items.update(needs_testing=False)


class Migration(migrations.Migration):
    dependencies = [("db", "0136_issue_needs_testing")]

    operations = [
        migrations.AlterField(model_name="issue", name="needs_testing", field=models.BooleanField(default=False)),
        migrations.AlterField(model_name="draftissue", name="needs_testing", field=models.BooleanField(default=False)),
        # The prior per-item choices and states cannot be reconstructed on rollback.
        migrations.RunPython(disable_testing, migrations.RunPython.noop),
    ]
