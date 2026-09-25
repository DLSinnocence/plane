# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.db import migrations, models


TESTING_NAME = "验收完成/待测试"


def add_testing_states(apps, schema_editor):
    State = apps.get_model("db", "State")
    Project = apps.get_model("db", "Project")
    alias = schema_editor.connection.alias
    states = State.objects.using(alias).filter(deleted_at__isnull=True)
    for project in Project.objects.using(alias).filter(deleted_at__isnull=True).iterator():
        project_states = states.filter(project_id=project.pk)
        if project_states.filter(is_testing=True).exists():
            continue
        existing = project_states.filter(
            name=TESTING_NAME, group="started", default=False, external_source__isnull=True
        ).first()
        if existing is not None:
            project_states.filter(pk=existing.pk).update(is_testing=True)
            continue
        # Keep custom/imported states (and their issue references) untouched.
        name = TESTING_NAME
        suffix = 1
        while project_states.filter(name=name).exists():
            name = f"{TESTING_NAME}（可选 {suffix}）"
            suffix += 1
        anchor = project_states.filter(name="开发完成/待验收", group="started").first()
        anchor = anchor or project_states.filter(group="started").order_by("-sequence").first()
        if anchor:
            following = project_states.filter(sequence__gt=anchor.sequence).order_by("sequence").first()
            sequence = (anchor.sequence + following.sequence) / 2 if following else anchor.sequence + 10000
        else:
            completed = project_states.filter(group="completed").order_by("sequence").first()
            sequence = completed.sequence - 5000 if completed else 42500
        State.objects.using(alias).create(
            project_id=project.pk,
            workspace_id=project.workspace_id,
            name=name,
            color="#F59E0B",
            group="started",
            sequence=sequence,
            default=False,
            is_testing=True,
        )


class Migration(migrations.Migration):
    dependencies = [("db", "0135_workspace_ai_settings")]

    operations = [
        migrations.AddField(model_name="issue", name="needs_testing", field=models.BooleanField(default=True)),
        migrations.AddField(model_name="draftissue", name="needs_testing", field=models.BooleanField(default=True)),
        migrations.AddField(model_name="state", name="is_testing", field=models.BooleanField(default=False)),
        # Never delete a newly used state or rewrite project history on rollback.
        migrations.RunPython(add_testing_states, migrations.RunPython.noop),
    ]
