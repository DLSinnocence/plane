# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from importlib import import_module
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from plane.db.models import (
    DraftIssue,
    Intake,
    IntakeIssue,
    Issue,
    IssueAssignee,
    Project,
    ProjectMember,
    State,
    User,
    WorkspaceMember,
)

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def work_item_access(workspace, create_user, monkeypatch, settings):
    settings.WEB_URL = "http://testserver"
    settings.APP_BASE_URL = "http://testserver"
    WorkspaceMember.objects.filter(workspace=workspace, member=create_user).update(role=15)
    project = Project.objects.create(name="Scoped writes", identifier="SCW", workspace=workspace, intake_view=True)
    membership = ProjectMember.objects.create(project=project, member=create_user, role=15, is_active=True)
    owner = User.objects.create(email="work-item-owner@plane.so", username="work-item-owner")
    WorkspaceMember.objects.create(workspace=workspace, member=owner, role=15, is_active=True)
    ProjectMember.objects.create(project=project, member=owner, role=15, is_active=True)
    current = State.objects.create(project=project, name="In progress", group="started", default=True)
    next_state = State.objects.create(project=project, name="Review", group="started")
    triage = State.objects.create(project=project, name="Triage", group="triage")
    intake = Intake.objects.create(project=project, name="Intake")
    issue = Issue.objects.create(
        project=project,
        name="Someone else's work",
        state=current,
        created_by=owner,
        state_assignees={str(current.pk): [str(owner.pk)], str(next_state.pk): [str(create_user.pk)]},
    )
    issue.save(created_by_id=owner.pk)
    IssueAssignee.objects.create(issue=issue, project=project, assignee=owner)
    for module_name, names in {
        "plane.app.views.issue.base": ("issue_activity", "model_activity", "issue_description_version_task"),
        "plane.api.views.issue": ("issue_activity", "model_activity", "get_asset_object_metadata"),
        "plane.app.views.intake.base": ("issue_activity", "issue_description_version_task"),
        "plane.api.views.intake": ("issue_activity",),
        "plane.middleware.logger": ("process_logs",),
    }.items():
        module = import_module(module_name)
        for name in names:
            monkeypatch.setattr(getattr(module, name), "delay", Mock())
    return SimpleNamespace(
        project=project,
        membership=membership,
        actor=create_user,
        owner=owner,
        current=current,
        next=next_state,
        triage=triage,
        intake=intake,
        issue=issue,
    )


@pytest.fixture(params=["app", "public-api"])
def write_endpoint(request, work_item_access):
    public = request.param == "public-api"
    client = request.getfixturevalue("api_key_client" if public else "session_client")
    item = work_item_access.issue
    prefix = "/api/v1" if public else "/api"
    return SimpleNamespace(
        client=client,
        public=public,
        state_field="state" if public else "state_id",
        base=f"{prefix}/workspaces/{item.workspace.slug}/projects/{item.project_id}",
    )


def grant(access, kind):
    if kind == "creator":
        access.issue.save(created_by_id=access.actor.pk)
    elif kind == "assignee":
        access.issue.state_assignees[str(access.current.pk)] = [str(access.actor.pk)]
        access.issue.save(disable_auto_set_user=True)
        IssueAssignee.objects.filter(issue=access.issue).delete()
        IssueAssignee.objects.create(issue=access.issue, project=access.project, assignee=access.actor)
    elif kind == "project-admin":
        ProjectMember.objects.filter(pk=access.membership.pk).update(role=20)
    elif kind in ("workspace-admin", "workspace-admin-guest"):
        WorkspaceMember.objects.filter(workspace=access.project.workspace, member=access.actor).update(role=20)
        if kind == "workspace-admin-guest":
            ProjectMember.objects.filter(pk=access.membership.pk).update(role=5)
            # This actor can administer the project but remains ineligible for
            # workflow assignment as a project guest. Keep the target stage valid.
            access.issue.state_assignees[str(access.next.pk)] = [str(access.owner.pk)]
            access.issue.save(disable_auto_set_user=True)
    elif kind == "lead":
        access.project.project_lead = access.actor
        access.project.save()


@pytest.mark.parametrize("kind", ["member", "lead"])
def test_member_cannot_create_formal_work_items(write_endpoint, work_item_access, kind):
    grant(work_item_access, kind)
    before = Issue.objects.filter(project=work_item_access.project).count()
    response = write_endpoint.client.post(f"{write_endpoint.base}/issues/", {"name": "Direct creation"}, format="json")
    assert response.status_code == 403, response.data
    assert Issue.objects.filter(project=work_item_access.project).count() == before


@pytest.mark.parametrize("kind", ["project-admin", "workspace-admin", "workspace-admin-guest"])
def test_admin_can_create_formal_work_items(write_endpoint, work_item_access, kind):
    grant(work_item_access, kind)
    response = write_endpoint.client.post(
        f"{write_endpoint.base}/issues/", {"name": "Authorized creation"}, format="json"
    )
    assert response.status_code == 201, response.data
    assert Issue.objects.filter(project=work_item_access.project, name="Authorized creation").exists()


@pytest.mark.parametrize("kind", ["member", "lead"])
@pytest.mark.parametrize("field", ["name", "description_html", "priority", "state"])
def test_members_cannot_edit_other_work_items(write_endpoint, work_item_access, kind, field):
    grant(work_item_access, kind)
    values = {"name": "Unauthorized", "description_html": "<p>Unauthorized</p>", "priority": "urgent"}
    payload = (
        {write_endpoint.state_field: str(work_item_access.next.pk)} if field == "state" else {field: values[field]}
    )
    response = write_endpoint.client.patch(
        f"{write_endpoint.base}/issues/{work_item_access.issue.pk}/", payload, format="json"
    )
    assert response.status_code == 403, response.data
    work_item_access.issue.refresh_from_db()
    assert work_item_access.issue.name == "Someone else's work"
    assert work_item_access.issue.state_id == work_item_access.current.pk
    assert work_item_access.issue.priority == "none"


@pytest.mark.parametrize("kind", ["creator", "assignee", "project-admin", "workspace-admin", "workspace-admin-guest"])
def test_creator_current_assignee_and_admin_can_edit_and_handoff(write_endpoint, work_item_access, kind):
    grant(work_item_access, kind)
    response = write_endpoint.client.patch(
        f"{write_endpoint.base}/issues/{work_item_access.issue.pk}/",
        {"name": "Authorized change", write_endpoint.state_field: str(work_item_access.next.pk)},
        format="json",
    )
    assert response.status_code == 200, response.data
    work_item_access.issue.refresh_from_db()
    assert work_item_access.issue.name == "Authorized change"
    assert work_item_access.issue.state_id == work_item_access.next.pk


@pytest.mark.parametrize("kind", ["creator", "assignee", "project-admin", "workspace-admin", "workspace-admin-guest"])
@pytest.mark.parametrize("membership", ["project", "workspace"])
def test_write_authority_requires_both_active_memberships(write_endpoint, work_item_access, kind, membership):
    grant(work_item_access, kind)
    if membership == "project":
        ProjectMember.objects.filter(pk=work_item_access.membership.pk).update(is_active=False)
    else:
        WorkspaceMember.objects.filter(
            workspace=work_item_access.project.workspace, member=work_item_access.actor
        ).update(is_active=False)
    response = write_endpoint.client.patch(
        f"{write_endpoint.base}/issues/{work_item_access.issue.pk}/", {"name": "Denied"}, format="json"
    )
    assert response.status_code == 403, response.data
    work_item_access.issue.refresh_from_db()
    assert work_item_access.issue.name == "Someone else's work"


def test_public_upsert_route_is_not_exposed(api_key_client, work_item_access):
    item = work_item_access.issue
    url = f"/api/v1/workspaces/{item.workspace.slug}/projects/{item.project_id}/issues/"
    item.external_id, item.external_source = "existing", "permission-test"
    item.save(disable_auto_set_user=True)
    for external_id in ("existing", "new"):
        response = api_key_client.put(
            url,
            {"name": "Denied upsert", "external_id": external_id, "external_source": "permission-test"},
            format="json",
        )
        assert response.status_code == 405, response.data
    assert not Issue.objects.filter(project=item.project, name="Denied upsert").exists()


def test_member_can_submit_intake_and_edit_own_content(write_endpoint, work_item_access):
    response = write_endpoint.client.post(
        f"{write_endpoint.base}/intake-issues/",
        {"issue": {"name": "Please review", "priority": "medium"}},
        format="json",
    )
    assert response.status_code in (200, 201), response.data
    item = Issue.objects.get(project=work_item_access.project, name="Please review")
    assert item.created_by_id == work_item_access.actor.pk
    assert item.state_id == work_item_access.triage.pk
    assert IntakeIssue.objects.get(issue=item).status == -2
    response = write_endpoint.client.patch(
        f"{write_endpoint.base}/intake-issues/{item.pk}/", {"issue": {"name": "More detail"}}, format="json"
    )
    assert response.status_code == 200, response.data
    item.refresh_from_db()
    assert item.name == "More detail"


@pytest.mark.parametrize("path", ["review", "nested-state", "formal-state"])
def test_member_cannot_promote_own_intake_without_admin_review(write_endpoint, work_item_access, path):
    item = work_item_access.issue
    item.state = work_item_access.triage
    item.save(created_by_id=work_item_access.actor.pk)
    intake_issue = IntakeIssue.objects.create(project=item.project, intake=work_item_access.intake, issue=item)
    url = f"{write_endpoint.base}/intake-issues/{item.pk}/"
    payload = {"status": 1}
    if path != "review":
        payload = {write_endpoint.state_field: str(work_item_access.current.pk)}
        if path == "nested-state":
            payload = {"issue": payload}
        else:
            url = f"{write_endpoint.base}/issues/{item.pk}/"
    response = write_endpoint.client.patch(url, payload, format="json")
    expected_status = 404 if path == "formal-state" and not write_endpoint.public else 403
    assert response.status_code == expected_status, response.data
    item.refresh_from_db()
    intake_issue.refresh_from_db()
    assert item.state_id == work_item_access.triage.pk
    assert intake_issue.status == -2


def test_member_cannot_publish_draft(session_client, work_item_access):
    draft = DraftIssue.objects.create(
        name="Private draft",
        project=work_item_access.project,
        workspace=work_item_access.project.workspace,
        created_by=work_item_access.actor,
    )
    response = session_client.post(
        f"/api/workspaces/{draft.workspace.slug}/draft-to-issue/{draft.pk}/", {"name": "Published draft"}, format="json"
    )
    assert response.status_code == 403, response.data
    assert DraftIssue.objects.filter(pk=draft.pk).exists()
    assert not Issue.objects.filter(project=draft.project, name="Published draft").exists()


def test_assigned_child_is_returned_without_its_unassigned_parent(session_client, work_item_access):
    parent = work_item_access.issue
    child = Issue.objects.create(
        project=parent.project,
        workspace=parent.workspace,
        parent=parent,
        name="Assigned child",
        state=parent.state,
        created_by=work_item_access.owner,
        state_assignees={str(parent.state_id): [str(work_item_access.actor.pk)]},
    )
    child.save(created_by_id=work_item_access.owner.pk)
    IssueAssignee.objects.create(issue=child, project=parent.project, assignee=work_item_access.actor)
    response = session_client.get(
        f"/api/workspaces/{parent.workspace.slug}/user-issues/{work_item_access.actor.pk}/",
        {"assignees": str(work_item_access.actor.pk), "sub_issue": "true"},
    )
    assert response.status_code == 200, response.data
    assert [item["id"] for item in response.json()["results"]] == [str(child.pk)]
