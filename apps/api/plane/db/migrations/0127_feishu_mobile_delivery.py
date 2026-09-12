# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("db", "0126_feishu_integration")]

    operations = [
        migrations.AddField(
            model_name="feishumessage",
            name="recipient_mobile",
            field=models.CharField(max_length=32, blank=True, default=""),
        ),
        migrations.AddField(
            model_name="feishumessage",
            name="recipient_via_binding",
            field=models.BooleanField(default=False),
        ),
    ]
