# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("db", "0133_user_ai_settings")]

    operations = [
        migrations.AddField(
            model_name="useraisettings", name="supports_images", field=models.BooleanField(default=False)
        ),
    ]
