# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.db import migrations
from django.utils.text import slugify


DEFAULT_NAMES = (
    ("backlog", "Backlog", "待规划"),
    ("unstarted", "Todo", "待开始"),
    ("started", "In Progress", "开发中"),
    ("completed", "Done", "已完成"),
    ("cancelled", "Cancelled", "已取消"),
)
ACCEPTANCE_NAME = "开发完成/待验收"


def convert_default_states(apps, schema_editor):
    State = apps.get_model("db", "State")
    states = State.objects.using(schema_editor.connection.alias)
    active_states = states.filter(deleted_at__isnull=True)

    for group, old_name, new_name in DEFAULT_NAMES:
        candidates = active_states.filter(name=old_name, group=group, external_source__isnull=True)
        for state in candidates.iterator():
            project_states = active_states.filter(project_id=state.project_id)
            # Never merge, rename, or replace a pre-existing custom state.
            if project_states.filter(name=new_name).exists():
                continue
            states.filter(pk=state.pk).update(name=new_name, slug=slugify(new_name))
            if group != "started" or project_states.filter(name=ACCEPTANCE_NAME).exists():
                continue

            next_sequence = (
                project_states.filter(sequence__gt=state.sequence)
                .order_by("sequence")
                .values_list("sequence", flat=True)
                .first()
            )
            sequence = (state.sequence + next_sequence) / 2 if next_sequence is not None else state.sequence + 10000
            states.create(
                project_id=state.project_id,
                workspace_id=state.workspace_id,
                name=ACCEPTANCE_NAME,
                slug=slugify(ACCEPTANCE_NAME),
                color="#F59E0B",
                group="started",
                sequence=sequence,
                default=False,
            )


class Migration(migrations.Migration):
    dependencies = [("db", "0123_default_chinese_locale")]

    # A reverse conversion cannot distinguish migrated names from custom Chinese
    # states, and deleting acceptance could remove states already used by issues.
    operations = [migrations.RunPython(convert_default_states, migrations.RunPython.noop)]
