# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from django.db import migrations
from django.db.migrations.loader import MigrationLoader

from plane.app.serializers.cycle import CycleWriteSerializer
from plane.db.models import Cycle, Profile, Project, User, Workspace
from plane.db.models.base import BaseModel
from plane.utils.timezone_converter import convert_to_utc


pytestmark = pytest.mark.unit

LOCALE_FIELDS = [
    (User, "user_timezone", "Asia/Shanghai", "UTC"),
    (Profile, "language", "zh-CN", "en"),
    (Workspace, "timezone", "Asia/Shanghai", "UTC"),
    (Project, "timezone", "Asia/Shanghai", "UTC"),
    (Cycle, "timezone", "Asia/Shanghai", "UTC"),
]


@pytest.mark.parametrize("model,field,default,previous", LOCALE_FIELDS)
def test_new_model_locale_defaults(model, field, default, previous):
    instance = model()
    assert getattr(instance, field) == default
    model._meta.get_field(field).validate(default, instance)


@pytest.mark.parametrize("model,field,default,previous", LOCALE_FIELDS)
def test_explicit_and_loaded_locale_values_are_retained(model, field, default, previous):
    for value in (previous, "fr" if field == "language" else "America/New_York"):
        assert getattr(model(**{field: value}), field) == value
        # Use Django's hydration path, which supplies fields positionally.
        instance = model.from_db("default", [field], [value])
        assert not instance._state.adding
        assert getattr(instance, field) == value


@pytest.mark.parametrize("workspace_timezone", ["Asia/Shanghai", "UTC", "Europe/Paris"])
@pytest.mark.parametrize("explicit_timezone", [None, "UTC", "America/New_York"])
def test_project_creation_preserves_workspace_inheritance(workspace_timezone, explicit_timezone):
    workspace = Workspace(timezone=workspace_timezone)
    kwargs = {} if explicit_timezone is None else {"timezone": explicit_timezone}
    project = Project(name="Project", identifier="TEST", workspace=workspace, **kwargs)
    # Exercise the real creation hook, mocking only database access.
    with patch.object(Workspace.objects, "get", return_value=workspace), patch.object(BaseModel, "save"):
        project.save()
    assert project.timezone == (explicit_timezone or workspace_timezone)


def test_saving_existing_project_does_not_inherit_changed_workspace_timezone():
    project = Project.from_db("default", ["identifier", "timezone"], ["TEST", "UTC"])
    with patch.object(Workspace.objects, "get") as get_workspace, patch.object(BaseModel, "save"):
        project.save()
    get_workspace.assert_not_called()
    assert project.timezone == "UTC"


@pytest.mark.parametrize("explicit_timezone", [None, "UTC", "Europe/Paris"])
def test_cycle_serializer_creation_retains_defaults_and_explicit_values(explicit_timezone):
    data = {"name": "Cycle"}
    if explicit_timezone is not None:
        data["timezone"] = explicit_timezone
    serializer = CycleWriteSerializer(data=data)
    assert serializer.is_valid(), serializer.errors
    # Let DRF pass its actual validated creation data to the model constructor.
    with patch.object(Cycle.objects, "create", side_effect=Cycle):
        cycle = serializer.save()
    assert cycle.timezone == (explicit_timezone or "Asia/Shanghai")


def test_chinese_project_dates_are_still_normalized_to_utc():
    project = Project()
    with patch.object(Project.objects, "get", return_value=project):
        result = convert_to_utc("2020-01-02", project.id)
    assert result == datetime(2020, 1, 2, 15, 59, tzinfo=timezone.utc)
    assert result.utcoffset().total_seconds() == 0


def test_forward_migration_changes_only_defaults():
    # Loading migration state without a connection needs no live database.
    loader = MigrationLoader(None)
    target = ("db", "0123_default_chinese_locale")
    migration = loader.get_migration(*target)
    before = loader.project_state(migration.dependencies)
    after = loader.project_state([target])
    assert len(migration.operations) == len(LOCALE_FIELDS)
    assert all(type(operation) is migrations.AlterField for operation in migration.operations)
    for model, field, default, previous in LOCALE_FIELDS:
        old_model = before.apps.get_model("db", model.__name__)
        new_model = after.apps.get_model("db", model.__name__)
        old_field = old_model._meta.get_field(field)
        new_field = new_model._meta.get_field(field)
        assert old_field.default == previous
        assert new_field.default == default
        assert getattr(new_model(**{field: previous}), field) == previous
        old_definition = old_field.deconstruct()[3]
        new_definition = new_field.deconstruct()[3]
        old_definition.pop("default")
        new_definition.pop("default")
        assert old_definition == new_definition
