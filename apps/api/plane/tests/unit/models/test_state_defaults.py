# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from importlib import import_module
from types import SimpleNamespace

import pytest
from django.db import connection
from django.db.migrations.loader import MigrationLoader
from django.test import override_settings
from django.utils import timezone

from plane.db.models import DEFAULT_STATES, Project


migration = import_module("plane.db.migrations.0124_default_chinese_states")
pytestmark = pytest.mark.unit


def test_chinese_default_states_keep_groups_and_order():
    assert [(state["name"], state["group"]) for state in DEFAULT_STATES] == [
        ("待规划", "backlog"),
        ("待开始", "unstarted"),
        ("开发中", "started"),
        ("开发完成/待验收", "started"),
        ("验收完成/待测试", "started"),
        ("已完成", "completed"),
        ("已取消", "cancelled"),
        ("Triage", "triage"),
    ]
    assert [state["sequence"] for state in DEFAULT_STATES] == sorted(state["sequence"] for state in DEFAULT_STATES)
    assert [state["name"] for state in DEFAULT_STATES if state.get("default")] == ["待规划"]


@pytest.fixture
def historical_states(workspace):
    with override_settings(MIGRATION_MODULES={}):
        apps = MigrationLoader(None).project_state([("db", "0136_issue_needs_testing")]).apps
    State = apps.get_model("db", "State")
    project = Project.objects.create(name="Migration project", identifier="MIG", workspace=workspace)

    def create(name, group="started", sequence=35000, **kwargs):
        state = State(
            project_id=project.pk,
            workspace_id=workspace.pk,
            name=name,
            group=group,
            color="#123456",
            sequence=sequence,
            **kwargs,
        )
        State.objects.bulk_create([state])
        return state

    def convert():
        migration.convert_default_states(apps, SimpleNamespace(connection=connection))

    return State, create, convert


@pytest.mark.django_db
def test_migration_converts_defaults_preserving_identity_and_metadata(historical_states):
    State, create, convert = historical_states
    originals = [
        create(old_name, group, 15000 + index * 10000, default=index == 0)
        for index, (group, old_name, _) in enumerate(migration.DEFAULT_NAMES)
    ]
    convert()

    for original, (_, _, expected_name) in zip(originals, migration.DEFAULT_NAMES):
        actual = State.objects.get(pk=original.pk)
        assert actual.name == expected_name
        assert actual.group == original.group
        assert actual.sequence == original.sequence
        assert actual.color == original.color
        assert actual.default == original.default
        assert actual.workspace_id == original.workspace_id
        assert actual.slug == ""

    acceptance = State.objects.get(name="开发完成/待验收")
    assert acceptance.group == "started"
    assert acceptance.default is False
    assert originals[2].sequence < acceptance.sequence < originals[3].sequence
    assert acceptance.project_id == originals[2].project_id
    assert acceptance.workspace_id == originals[2].workspace_id
    convert()
    assert State.objects.count() == 6


@pytest.mark.django_db
def test_migration_preserves_custom_imported_deleted_and_wrong_group_states(historical_states):
    State, create, convert = historical_states
    custom = [
        create("Building"),
        create("in progress"),
        create("In Progress", "backlog"),
        create("Todo", "started"),
        create("Done", "cancelled"),
        create("Backlog", "unstarted"),
        create("Cancelled", "completed"),
        create("In Progress", deleted_at=timezone.now()),
        create("Triage", "triage"),
    ]
    convert()
    assert State.objects.count() == len(custom)
    for original in custom:
        assert State.objects.get(pk=original.pk).name == original.name
    assert not State.objects.filter(name="开发完成/待验收").exists()


@pytest.mark.django_db
def test_migration_preserves_imported_default_names(historical_states):
    State, create, convert = historical_states
    imported = [
        create("In Progress", external_source="jira"),
        create("Todo", "unstarted", external_source="jira"),
    ]
    convert()
    assert State.objects.count() == len(imported)
    for original in imported:
        assert State.objects.get(pk=original.pk).name == original.name
    assert not State.objects.filter(name="开发完成/待验收").exists()


@pytest.mark.django_db
def test_migration_preserves_existing_development_name_collision(historical_states):
    State, create, convert = historical_states
    original = create("In Progress")
    custom = create("开发中", "backlog")
    convert()
    assert State.objects.get(pk=original.pk).name == "In Progress"
    assert State.objects.get(pk=custom.pk).group == "backlog"
    assert State.objects.count() == 2


@pytest.mark.django_db
def test_migration_preserves_existing_acceptance_state(historical_states):
    State, create, convert = historical_states
    original = create("In Progress")
    custom = create("开发完成/待验收", "completed", 100)
    convert()
    assert State.objects.get(pk=original.pk).name == "开发中"
    actual = State.objects.get(pk=custom.pk)
    assert (actual.group, actual.sequence, actual.color) == ("completed", 100, "#123456")
    assert State.objects.count() == 2


@pytest.mark.django_db
def test_migration_inserts_acceptance_before_next_custom_state(historical_states):
    State, create, convert = historical_states
    original = create("In Progress", sequence=91000)
    next_state = create("Review", sequence=91002)
    convert()
    assert State.objects.get(name="开发完成/待验收").sequence == 91001
    assert State.objects.get(pk=original.pk).sequence == 91000
    assert State.objects.get(pk=next_state.pk).sequence == 91002


@pytest.mark.django_db
def test_migration_appends_acceptance_when_development_is_last(historical_states):
    State, create, convert = historical_states
    create("In Progress", sequence=99000)
    convert()
    assert State.objects.get(name="开发完成/待验收").sequence > 99000
