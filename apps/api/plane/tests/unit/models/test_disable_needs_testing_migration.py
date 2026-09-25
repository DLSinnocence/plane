# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from importlib import import_module
from types import SimpleNamespace

import pytest
from django.db import connection
from django.db.migrations.loader import MigrationLoader
from django.test import override_settings
from django.utils import timezone

from plane.db.models import (
    DraftIssue, DraftIssueAssignee, Issue, IssueAssignee,
    Project, ProjectMember, State, User,
)

pytestmark = [pytest.mark.unit, pytest.mark.django_db]
migration = import_module("plane.db.migrations.0137_disable_needs_testing")


def historical_apps():
    with override_settings(MIGRATION_MODULES={}):
        return MigrationLoader(None).project_state([("db", "0137_disable_needs_testing")]).apps


def migrate():
    migration.disable_testing(historical_apps(), SimpleNamespace(connection=connection))


@pytest.fixture(params=[(Issue, IssueAssignee, "issue"), (DraftIssue, DraftIssueAssignee, "draft_issue")])
def item_models(request):
    return request.param


@pytest.fixture
def workflow(workspace, create_user):
    project = Project.objects.create(name="Reset testing", identifier="RT", workspace=workspace)
    ProjectMember.objects.create(project=project, member=create_user, role=20, is_active=True)
    reviewer = User.objects.create(email="reset-reviewer@example.com", username="reset-reviewer")
    inactive = User.objects.create(email="reset-inactive@example.com", username="reset-inactive")
    ProjectMember.objects.create(project=project, member=reviewer, role=15, is_active=True)
    ProjectMember.objects.create(project=project, member=inactive, role=15, is_active=False)
    acceptance = State.objects.create(project=project, name=migration.ACCEPTANCE_NAME, group="started")
    testing = State.objects.create(project=project, name="Testing", group="started", is_testing=True)
    return SimpleNamespace(
        project=project, creator=create_user, reviewer=reviewer, inactive=inactive,
        acceptance=acceptance, testing=testing,
    )


@pytest.mark.parametrize("assignment", ["configured", "empty", "missing", "former_creator"])
def test_reset_moves_testing_items_and_syncs_acceptance_assignees(workflow, item_models, assignment):
    wf = workflow
    Item, Assignment, item_field = item_models
    plan = {str(wf.testing.pk): [str(wf.creator.pk)]}
    expected = []
    if assignment == "configured":
        plan[str(wf.acceptance.pk)] = [str(wf.reviewer.pk), str(wf.inactive.pk)]
        expected = [wf.reviewer.pk]
    elif assignment == "empty":
        plan[str(wf.acceptance.pk)] = []
    elif assignment == "missing":
        expected = [wf.creator.pk]
    else:
        ProjectMember.objects.filter(project=wf.project, member=wf.creator).update(is_active=False)
    item = Item(name="Testing item", project=wf.project, state=wf.testing, needs_testing=True, state_assignees=plan)
    item.save(created_by_id=wf.creator.pk)
    Assignment.objects.create(
        **{item_field: item}, project=wf.project, workspace=wf.project.workspace, assignee=wf.creator,
    )
    Item._base_manager.filter(pk=item.pk).update(completed_at=timezone.now())
    migrate()
    item.refresh_from_db()
    assert item.needs_testing is False
    assert item.state_id == wf.acceptance.pk
    assert item.completed_at is None
    assert item.state_assignees[str(wf.testing.pk)] == plan[str(wf.testing.pk)]
    assert item.state_assignees[str(wf.acceptance.pk)] == [str(member) for member in expected]
    assert set(Assignment._base_manager.filter(**{item_field: item}).values_list("assignee_id", flat=True)) == set(expected)
    migrate()
    assert set(Assignment._base_manager.filter(**{item_field: item}).values_list("assignee_id", flat=True)) == set(expected)


@pytest.mark.parametrize("needs_testing", [True, False])
@pytest.mark.parametrize("deleted", [True, False])
def test_reset_includes_deleted_items_and_preserves_other_states(workflow, item_models, needs_testing, deleted):
    wf = workflow
    Item, _, _ = item_models
    plan = {str(wf.acceptance.pk): []}
    item = Item.objects.create(
        name="Other item", project=wf.project, state=wf.acceptance,
        needs_testing=needs_testing, state_assignees=plan,
    )
    if deleted:
        Item._base_manager.filter(pk=item.pk).update(deleted_at=timezone.now())
    migrate()
    item.refresh_from_db()
    assert item.needs_testing is False
    assert item.state_id == wf.acceptance.pk
    assert item.state_assignees == plan
    assert bool(item.deleted_at) is deleted


def test_missing_acceptance_fails_before_any_data_changes(workflow, item_models):
    wf = workflow
    Item, _, _ = item_models
    item = Item.objects.create(name="Testing item", project=wf.project, state=wf.testing, needs_testing=True)
    other = Item.objects.create(name="Other item", project=wf.project, state=wf.acceptance, needs_testing=True)
    State.objects.filter(pk=wf.acceptance.pk).update(name="Custom stage")
    with pytest.raises(RuntimeError, match=str(wf.project.pk)):
        migrate()
    item.refresh_from_db()
    other.refresh_from_db()
    assert item.needs_testing is True
    assert item.state_id == wf.testing.pk
    assert other.needs_testing is True


def test_historical_and_current_models_default_to_false(item_models):
    Item, _, _ = item_models
    HistoricalItem = historical_apps().get_model("db", Item.__name__)
    assert HistoricalItem().needs_testing is False
    assert Item().needs_testing is False
