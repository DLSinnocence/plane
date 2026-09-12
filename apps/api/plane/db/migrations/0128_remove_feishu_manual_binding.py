# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.db import migrations


def clear_unsent_manual_resolutions(apps, schema_editor):
    # A frozen ID obtained through the removed fallback must be looked up by phone again.
    message = apps.get_model("db", "FeishuMessage")
    message.objects.using(schema_editor.connection.alias).filter(
        recipient_via_binding=True,
    ).exclude(status="sent").update(recipient_open_id="")


class Migration(migrations.Migration):
    dependencies = [("db", "0127_feishu_mobile_delivery")]

    operations = [
        migrations.RunPython(clear_unsent_manual_resolutions, migrations.RunPython.noop),
        migrations.RemoveField(model_name="feishumessage", name="recipient_via_binding"),
        migrations.DeleteModel(name="FeishuMemberBinding"),
    ]
