# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("db", "0124_default_chinese_states")]

    operations = [
        migrations.AddField(
            model_name="issue",
            name="state_assignees",
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
