# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import inspect
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import pytest
from crum import impersonate
from rest_framework.exceptions import ValidationError

from plane.app.serializers.draft import (
    DraftIssueCreateSerializer,
    DraftIssueSerializer,
    DraftIssueDetailSerializer,
)
from plane.app.views.workspace.draft import WorkspaceDraftIssueViewSet
from plane.db.models import DraftIssue, Issue, Project, ProjectMember, State, User

pytestmark = pytest.mark.unit


@pytest.mark.parametrize("field", ["assignee_ids", "assignees"])
@pytest.mark.parametrize("editing", [False, True])
def test_direct_draft_assignments_are_rejected(field, editing):
    serializer = DraftIssueCreateSerializer(
        instance=DraftIssue() if editing else None, data={field: []}, partial=editing
    )
    assert not serializer.is_valid()
    assert field in serializer.errors


@pytest.mark.parametrize("value", [None, [], "invalid", {"invalid": []}])
def test_draft_rejects_malformed_workflow_maps(value):
    with pytest.raises(ValidationError):
        DraftIssueCreateSerializer(context={"project_id": None}).validate_state_assignees(value)


def test_projectless_draft_accepts_an_empty_map():
    with patch("plane.utils.issue_workflow.State.all_state_objects.filter") as states:
        states.return_value.values_list.return_value = []
        serializer = DraftIssueCreateSerializer(data={"state_assignees": {}}, context={"project_id": None})
        assert serializer.is_valid(), serializer.errors
        assert serializer.validated_data["state_assignees"] == {}


def test_draft_reuses_issue_workflow_validation():
    project_id = uuid4()
    plan = {str(uuid4()): [str(uuid4())]}
    serializer = DraftIssueCreateSerializer(context={"project_id": project_id})
    with patch("plane.app.serializers.draft.IssueCreateSerializer") as formal:
        formal.return_value.validate_state_assignees.return_value = plan
        assert serializer.validate_state_assignees(plan) == plan
        formal.assert_called_once_with(context={"project_id": project_id})
        formal.return_value.validate_state_assignees.assert_called_once_with(plan)


@pytest.mark.parametrize("serializer_class", [DraftIssueSerializer, DraftIssueDetailSerializer])
def test_reopened_draft_responses_include_saved_workflow(serializer_class):
    plan = {str(uuid4()): [str(uuid4())]}
    draft = DraftIssue(name="Saved", state_assignees=plan)
    assert serializer_class(draft).data["state_assignees"] == plan


@pytest.mark.parametrize("explicit", [False, True])
def test_conversion_uses_saved_map_only_when_request_omits_it(explicit):
    saved = {str(uuid4()): [str(uuid4())]}
    data = {"name": "Convert"}
    if explicit:
        data["state_assignees"] = {}
    draft = SimpleNamespace(
        project_id=uuid4(),
        state_assignees=saved,
        needs_testing=False,
        workspace_id=uuid4(),
        project=SimpleNamespace(workspace_id=uuid4(), default_assignee_id=None),
    )
    request = SimpleNamespace(data=data, user=SimpleNamespace(pk=uuid4()))
    with (
        patch("plane.app.views.workspace.draft.require_project_admin_access"),
        patch("plane.app.views.workspace.draft.DraftIssue.objects.select_for_update") as drafts,
        patch("plane.app.views.workspace.draft.IssueCreateSerializer") as formal,
    ):
        drafts.return_value.filter.return_value.first.return_value = draft
        formal.return_value.is_valid.return_value = False
        formal.return_value.errors = {"name": ["invalid"]}
        response = inspect.unwrap(WorkspaceDraftIssueViewSet.create_draft_to_issue)(
            WorkspaceDraftIssueViewSet(), request, "workspace", uuid4()
        )
    assert response.status_code == 400
    assert formal.call_args.kwargs["data"]["state_assignees"] == ({} if explicit else saved)
    assert formal.call_args.kwargs["data"]["needs_testing"] is False
    assert ("state_assignees" in request.data) == explicit


@pytest.mark.parametrize("field", ["state_id", "state_assignees", "project_id", "name"])
def test_draft_update_returns_refreshed_details_only_for_workflow_fields(field):
    draft = SimpleNamespace(pk=uuid4(), project_id=uuid4())
    refreshed = DraftIssue(name="Saved", state_assignees={str(uuid4()): []})
    refreshed.assignee_ids = [uuid4()]
    request = SimpleNamespace(user=SimpleNamespace(pk=uuid4()), data={field: {}})
    view = WorkspaceDraftIssueViewSet()
    with (
        patch("plane.app.views.workspace.draft.DraftIssue.objects.select_for_update") as drafts,
        patch("plane.app.views.workspace.draft.DraftIssueCreateSerializer") as serializer,
        patch.object(view, "get_queryset") as queryset,
    ):
        drafts.return_value.filter.return_value.first.return_value = draft
        serializer.return_value.is_valid.return_value = True
        queryset.return_value.get.return_value = refreshed
        response = inspect.unwrap(WorkspaceDraftIssueViewSet.partial_update)(view, request, "workspace", draft.pk)
        serializer.return_value.save.assert_called_once_with()
        if field == "name":
            assert response.status_code == 204
            assert response.data is None
            queryset.assert_not_called()
        else:
            assert response.status_code == 200
            assert response.data["state_assignees"] == refreshed.state_assignees
            assert response.data["assignee_ids"] == [str(refreshed.assignee_ids[0])]
            queryset.return_value.get.assert_called_once_with(pk=draft.pk)


@pytest.fixture
def draft_workflow(workspace, create_user):
    with impersonate(create_user):
        project = Project.objects.create(name="Draft workflow", identifier="DF", workspace=workspace)
        ProjectMember.objects.create(project=project, member=create_user, role=20, is_active=True)
        reviewer = User.objects.create(email="draft-reviewer@example.com", username="draft-reviewer")
        ProjectMember.objects.create(project=project, member=reviewer, role=15, is_active=True)
        backlog = State.objects.create(name="Backlog", group="backlog", project=project, default=True)
        review = State.objects.create(name="Review", group="started", project=project)
        completed = State.objects.create(name="Done", group="completed", project=project)
        cancelled = State.objects.create(name="Cancelled", group="cancelled", project=project)
        context = {
            "request": SimpleNamespace(user=create_user),
            "project_id": project.id,
            "workspace_id": workspace.id,
        }
        yield SimpleNamespace(
            project=project,
            creator=create_user,
            reviewer=reviewer,
            backlog=backlog,
            review=review,
            completed=completed,
            cancelled=cancelled,
            context=context,
        )


def save_draft(workflow, data, instance=None, context=None):
    serializer = DraftIssueCreateSerializer(
        instance, data=data, partial=instance is not None, context=context or workflow.context
    )
    serializer.is_valid(raise_exception=True)
    return serializer.save()


@pytest.mark.django_db
def test_draft_workflow_survives_save_reopen_edit_and_conversion(draft_workflow):
    wf = draft_workflow
    plan = {str(wf.review.id): [str(wf.reviewer.id)]}
    draft = save_draft(wf, {"name": "Draft", "state_assignees": plan, "needs_testing": False})
    draft.refresh_from_db()
    assert draft.needs_testing is False
    assert draft.state_assignees[str(wf.review.id)] == [str(wf.reviewer.id)]
    for state in (wf.backlog, wf.completed, wf.cancelled):
        assert draft.state_assignees[str(state.id)] == [str(wf.creator.id)]
    assert list(draft.assignees.all()) == [wf.creator]
    view = WorkspaceDraftIssueViewSet()
    view.kwargs = {"slug": wf.project.workspace.slug}
    reopened = view.get_queryset().get(pk=draft.pk)
    for serializer in (DraftIssueSerializer, DraftIssueDetailSerializer):
        assert serializer(reopened).data["state_assignees"] == draft.state_assignees
    draft = save_draft(wf, {"name": "Renamed"}, draft)
    assert draft.state_assignees[str(wf.review.id)] == [str(wf.reviewer.id)]
    draft = save_draft(wf, {"state_assignees": {str(wf.review.id): []}}, draft)
    draft.refresh_from_db()
    assert draft.state_assignees[str(wf.review.id)] == []
    draft = save_draft(wf, {"state_assignees": plan, "state_id": str(wf.review.id)}, draft)
    assert list(draft.assignees.all()) == [wf.reviewer]
    request = SimpleNamespace(user=wf.creator, data={"name": draft.name, "state_id": str(wf.review.id)})
    view.request = request
    with (
        patch("plane.app.views.workspace.draft.issue_activity.delay"),
        patch("plane.app.views.workspace.draft.base_host", return_value="http://testserver"),
    ):
        response = inspect.unwrap(WorkspaceDraftIssueViewSet.create_draft_to_issue)(
            view, request, wf.project.workspace.slug, draft.pk
        )
    assert response.status_code == 201, response.data
    formal = Issue.objects.get(pk=response.data["id"])
    assert formal.state_assignees == draft.state_assignees
    assert formal.needs_testing is False
    assert list(formal.assignees.all()) == [wf.reviewer]
    assert not DraftIssue.objects.filter(pk=draft.pk).exists()


@pytest.mark.django_db
@pytest.mark.parametrize("field", ["state_id", "state_assignees", "project_id", "name"])
def test_draft_update_response_matches_persisted_responsibility(draft_workflow, field):
    wf = draft_workflow
    draft = save_draft(
        wf,
        {
            "name": "Draft",
            "state_id": str(wf.review.id),
            "state_assignees": {str(wf.review.id): [str(wf.reviewer.id)]},
        },
    )
    values = {
        "state_id": str(wf.backlog.id),
        "state_assignees": {str(wf.review.id): []},
        "project_id": None,
        "name": "Renamed",
    }
    request = SimpleNamespace(user=wf.creator, data={field: values[field]})
    view = WorkspaceDraftIssueViewSet()
    view.kwargs = {"slug": wf.project.workspace.slug}
    response = inspect.unwrap(WorkspaceDraftIssueViewSet.partial_update)(
        view, request, wf.project.workspace.slug, draft.pk
    )
    draft.refresh_from_db()
    if field == "name":
        assert response.status_code == 204
        assert draft.name == "Renamed"
        return
    assert response.status_code == 200, response.data
    assert response.data["state_assignees"] == draft.state_assignees
    assert response.data["assignee_ids"] == [str(user.pk) for user in draft.assignees.all()]
    assert response.data["assignee_ids"] == ([str(wf.creator.id)] if field == "state_id" else [])
    if field == "project_id":
        assert response.data["project_id"] is None
        assert response.data["state_assignees"] == {}


@pytest.mark.django_db
def test_projectless_draft_can_later_save_stage_choices(draft_workflow):
    wf = draft_workflow
    draft = save_draft(wf, {"state_assignees": {}}, context={**wf.context, "project_id": None})
    assert draft.project_id is None
    assert draft.state_assignees == {}
    draft = save_draft(wf, {"state_assignees": {str(wf.review.id): []}}, draft)
    draft.refresh_from_db()
    assert draft.project_id == wf.project.id
    assert draft.state_assignees[str(wf.review.id)] == []


@pytest.mark.django_db
@pytest.mark.parametrize("group", ["backlog", "completed", "cancelled"])
def test_draft_rejects_configuring_fixed_stages(draft_workflow, group):
    wf = draft_workflow
    with pytest.raises(ValidationError):
        save_draft(wf, {"state_assignees": {str(getattr(wf, group).id): [str(wf.reviewer.id)]}})
    assert not DraftIssue.objects.filter(project=wf.project).exists()


@pytest.mark.django_db
def test_draft_rejects_foreign_states_and_ineligible_members(draft_workflow):
    wf = draft_workflow
    for plan in ({str(uuid4()): []}, {str(wf.review.id): [str(uuid4())]}):
        with pytest.raises(ValidationError):
            save_draft(wf, {"state_assignees": plan})
