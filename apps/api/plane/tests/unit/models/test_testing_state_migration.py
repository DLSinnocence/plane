# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from importlib import import_module
from types import SimpleNamespace

import pytest
from django.db import connection
from django.db.migrations.loader import MigrationLoader
from django.test import override_settings

from plane.db.models import Project, State

pytestmark = [pytest.mark.unit, pytest.mark.django_db]
migration = import_module("plane.db.migrations.0136_issue_needs_testing")


def migrate():
    with override_settings(MIGRATION_MODULES={}):
        historical_apps = MigrationLoader(None).project_state([("db", "0136_issue_needs_testing")]).apps
    migration.add_testing_states(historical_apps, SimpleNamespace(connection=connection))


def test_testing_state_backfill_is_idempotent(workspace):
    project = Project.objects.create(name="Testing migration", identifier="TM", workspace=workspace)
    review = State.objects.create(project=project, name="开发完成/待验收", group="started")
    completed = State.objects.create(project=project, name="已完成", group="completed")
    migrate()
    testing = State.objects.get(project=project, is_testing=True)
    assert review.sequence < testing.sequence < completed.sequence
    assert testing.name == migration.TESTING_NAME
    assert testing.default is False
    migrate()
    assert State.objects.filter(project=project, is_testing=True).count() == 1
    assert State.objects.get(project=project, is_testing=True).pk == testing.pk


@pytest.mark.parametrize("imported", [False, True])
def test_testing_backfill_preserves_existing_state_identity(workspace, imported):
    project = Project.objects.create(name="Existing testing", identifier="ET", workspace=workspace)
    existing = State.objects.create(
        project=project, name=migration.TESTING_NAME, group="started",
        external_source="import" if imported else None,
    )
    migrate()
    existing.refresh_from_db()
    testing = State.objects.get(project=project, is_testing=True)
    assert existing.name == migration.TESTING_NAME
    if imported:
        assert testing.pk != existing.pk
        assert existing.is_testing is False
    else:
        assert testing.pk == existing.pk


def test_testing_backfill_preserves_custom_state_with_conflicting_name(workspace):
    project = Project.objects.create(name="Custom testing", identifier="CT", workspace=workspace)
    custom = State.objects.create(project=project, name=migration.TESTING_NAME, group="completed")
    migrate()
    custom.refresh_from_db()
    assert custom.group == "completed"
    assert custom.is_testing is False
    assert State.objects.get(project=project, is_testing=True).pk != custom.pk
