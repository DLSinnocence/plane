# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("db", "0128_remove_feishu_manual_binding")]

    operations = [
        migrations.AddField(
            model_name="draftissue",
            name="state_assignees",
            field=models.JSONField(default=dict, blank=True),
        ),
    ]
