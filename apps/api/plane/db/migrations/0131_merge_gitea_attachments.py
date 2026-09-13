# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0130_attachment_templates_slots"),
        ("db", "0130_gitea_integration"),
    ]

    operations = []
