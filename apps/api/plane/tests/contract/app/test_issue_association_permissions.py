# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import timedelta
from importlib import import_module
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from django.utils import timezone

from plane.db.models import (
    Cycle, CycleIssue, Issue, IssueLink, IssueRelation, Module, ModuleIssue,
    Project, ProjectMember, State, User, WorkspaceMember,
)

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture(autouse=True)
def association_request_settings(settings, monkeypatch):
    from django.core.cache import cache

    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
    settings.WEB_URL = "http://testserver"
    settings.APP_BASE_URL = "http://testserver"
    cache.clear()
    for module_name, task_name in [
        ("plane.middleware.logger", "process_logs"),
        ("plane.bgtasks.issue_activities_task", "issue_activity"),
        ("plane.bgtasks.webhook_task", "model_activity"),
        ("plane.bgtasks.work_item_link_task", "crawl_work_item_link_title"),
    ]:
        monkeypatch.setattr(getattr(import_module(module_name), task_name), "delay", Mock())
    yield
    cache.clear()


@pytest.fixture
def association_data(workspace, create_user):
    WorkspaceMember.objects.filter(workspace=workspace, member=create_user).update(role=15)
    other = User.objects.create(email="association-other@plane.so", username="association-other")
    WorkspaceMember.objects.create(workspace=workspace, member=other, role=15)
    project = Project.objects.create(name="Associations", identifier="ASC", workspace=workspace)
    membership = ProjectMember.objects.create(project=project, member=create_user, role=15)
    ProjectMember.objects.create(project=project, member=other, role=15)
    state = State.objects.create(name="Started", group="started", color="#000000", project=project)
    done = State.objects.create(name="Done", group="completed", color="#000000", project=project)

    def make_issue(owner, **kwargs):
        issue = Issue.objects.create(name="Association target", project=project, state=state, **kwargs)
        Issue.objects.filter(pk=issue.pk).update(created_by=owner)
        issue.refresh_from_db()
        return issue

    own = make_issue(create_user)
    forbidden = make_issue(other)
    assigned = make_issue(other, state_assignees={str(state.pk): [str(create_user.pk)]})
    cycle = Cycle.objects.create(name="Destination", project=project, owned_by=create_user)
    module = Module.objects.create(name="Destination", project=project)
    return SimpleNamespace(
        actor=create_user, other=other, project=project, workspace=workspace,
        membership=membership, state=state, done=done, own=own, forbidden=forbidden,
        assigned=assigned, cycle=cycle, module=module, make_issue=make_issue,
        base=f"/api/workspaces/{workspace.slug}/projects/{project.pk}",
    )


@pytest.fixture(params=["app-cycle", "api-cycle", "app-module", "api-module"])
def association_endpoint(request, association_data):
    d = association_data
    public = request.param.startswith("api")
    cycle = request.param.endswith("cycle")
    client = request.getfixturevalue("api_key_client" if public else "session_client")
    base = d.base.replace("/api/", "/api/v1/", 1) if public else d.base
    suffix = f"cycles/{d.cycle.pk}/cycle-issues" if cycle else (
        f"modules/{d.module.pk}/{'module-issues' if public else 'issues'}"
    )
    model = CycleIssue if cycle else ModuleIssue
    target = {"cycle": d.cycle} if cycle else {"module": d.module}
    return SimpleNamespace(client=client, url=f"{base}/{suffix}/", model=model, target=target)


def test_issue_delete_scope_handles_parent_cycles(association_data):
    from plane.utils.issue_write_scope import lock_issue_delete_scope

    d = association_data
    child = d.make_issue(d.actor, parent=d.own)
    Issue.objects.filter(pk=d.own.pk).update(parent=child)
    root = lock_issue_delete_scope(d.actor, d.workspace.slug, d.own.pk, d.project.pk)
    assert root.pk == d.own.pk


@pytest.mark.parametrize("public", [False, True])
@pytest.mark.parametrize("tree", ["foreign-child", "foreign-grandchild", "own-tree", "admin-tree"])
def test_issue_delete_authorizes_entire_active_tree(association_data, request, monkeypatch, public, tree):
    from plane.db.mixins import soft_delete_related_objects

    d = association_data
    client = request.getfixturevalue("api_key_client" if public else "session_client")
    if tree == "admin-tree":
        ProjectMember.objects.filter(pk=d.membership.pk).update(role=20)
    root = d.forbidden if tree == "admin-tree" else d.own
    child = d.make_issue(d.other if tree in ["foreign-child", "admin-tree"] else d.actor, parent=root)
    grandchild = d.make_issue(
        d.other if tree in ["foreign-grandchild", "admin-tree"] else d.actor, parent=child
    )
    queue = Mock()
    monkeypatch.setattr(soft_delete_related_objects, "delay", queue)
    base = d.base.replace("/api/", "/api/v1/", 1) if public else d.base
    response = client.delete(f"{base}/issues/{root.pk}/")
    denied = tree.startswith("foreign")
    assert response.status_code == (403 if denied else 204), response.data
    if denied:
        assert Issue.objects.filter(pk__in=[root.pk, child.pk, grandchild.pk]).count() == 3
        queue.assert_not_called()
    else:
        assert not Issue.objects.filter(pk=root.pk).exists()
        # Descendant deletion is asynchronous; the authorized cascade is queued.
        assert any(call.args[2] == root.pk for call in queue.call_args_list)


@pytest.mark.parametrize("public", [False, True])
@pytest.mark.parametrize("has_child", [False, True])
def test_intake_delete_checks_descendants_but_preserves_childless_guest_access(
    association_data, request, monkeypatch, public, has_child
):
    from plane.db.models import Intake, IntakeIssue
    from plane.db.mixins import soft_delete_related_objects

    d = association_data
    client = request.getfixturevalue("api_key_client" if public else "session_client")
    Project.objects.filter(pk=d.project.pk).update(intake_view=True)
    intake = Intake.objects.create(name="Deletion intake", project=d.project)
    triage = State.objects.create(
        name="Triage", group="triage", is_triage=True, color="#000000", project=d.project
    )
    Issue.objects.filter(pk=d.own.pk).update(state=triage)
    d.own.refresh_from_db()
    submission = IntakeIssue.objects.create(intake=intake, issue=d.own, project=d.project, status=-2)
    if has_child:
        Issue.objects.filter(pk=d.forbidden.pk).update(parent=d.own)
    else:
        ProjectMember.objects.filter(pk=d.membership.pk).update(role=5)
        WorkspaceMember.objects.filter(workspace=d.workspace, member=d.actor).update(role=5)
    queue = Mock()
    monkeypatch.setattr(soft_delete_related_objects, "delay", queue)
    base = d.base.replace("/api/", "/api/v1/", 1) if public else d.base
    response = client.delete(f"{base}/intake-issues/{d.own.pk}/")
    assert response.status_code == (403 if has_child else 204), response.data
    if has_child:
        assert Issue.objects.filter(pk__in=[d.own.pk, d.forbidden.pk]).count() == 2
        assert IntakeIssue.objects.filter(pk=submission.pk).exists()
        queue.assert_not_called()
    else:
        assert not Issue.objects.filter(pk=d.own.pk).exists()
        assert not IntakeIssue.objects.filter(pk=submission.pk).exists()


@pytest.mark.parametrize("route", ["issues", "work-items"])
@pytest.mark.parametrize("method", ["post", "patch", "delete"])
def test_public_link_writes_require_issue_access(association_data, api_key_client, route, method):
    d = association_data
    link = IssueLink.objects.create(issue=d.forbidden, project=d.project, url="https://example.com/original")
    base = d.base.replace("/api/", "/api/v1/", 1)
    url = f"{base}/{route}/{d.forbidden.pk}/links/"
    if method != "post":
        url += f"{link.pk}/"
    response = getattr(api_key_client, method)(url, {"url": "https://example.com/changed"}, format="json")
    assert response.status_code == 403, response.data
    assert IssueLink.objects.filter(issue=d.forbidden).count() == 1
    link.refresh_from_db()
    assert link.url == "https://example.com/original"
    from plane.bgtasks.issue_activities_task import issue_activity
    issue_activity.delay.assert_not_called()


@pytest.mark.parametrize("relation_type", ["relates_to", "blocking"])
def test_public_relation_mixed_batch_requires_both_endpoints(
    association_data, api_key_client, relation_type
):
    d = association_data
    base = d.base.replace("/api/", "/api/v1/", 1)
    response = api_key_client.post(
        f"{base}/work-items/{d.own.pk}/relations/",
        {"issues": [str(d.assigned.pk), str(d.forbidden.pk)], "relation_type": relation_type},
        format="json",
    )
    assert response.status_code == 403, response.data
    assert not IssueRelation.objects.filter(project=d.project).exists()
    from plane.bgtasks.issue_activities_task import issue_activity
    issue_activity.delay.assert_not_called()


@pytest.mark.parametrize("invalid_scope", ["target-membership", "anchor-project"])
def test_public_relation_checks_target_membership_and_anchor_project(
    association_data, api_key_client, invalid_scope
):
    d = association_data
    project = Project.objects.create(name="Private relation", identifier="PRL", workspace=d.workspace)
    state = State.objects.create(name="Started", group="started", color="#000000", project=project)
    target = Issue.objects.create(name="Owned in another project", project=project, state=state)
    Issue.objects.filter(pk=target.pk).update(created_by=d.actor)
    if invalid_scope == "anchor-project":
        ProjectMember.objects.create(project=project, member=d.actor, role=15)
    anchor = target if invalid_scope == "anchor-project" else d.own
    related = d.own if invalid_scope == "anchor-project" else target
    base = d.base.replace("/api/", "/api/v1/", 1)
    response = api_key_client.post(
        f"{base}/work-items/{anchor.pk}/relations/",
        {"issues": [str(related.pk)], "relation_type": "relates_to"}, format="json",
    )
    assert response.status_code == 403, response.data
    assert not IssueRelation.objects.filter(workspace=d.workspace).exists()


@pytest.mark.parametrize("access", ["creator", "current-assignee", "admin"])
@pytest.mark.parametrize("resource", ["link", "relation"])
def test_public_link_and_relation_authorized_writes_succeed(
    association_data, api_key_client, access, resource
):
    d = association_data
    target = d.own if access == "creator" else d.assigned
    if access == "admin":
        ProjectMember.objects.filter(pk=d.membership.pk).update(role=20)
        target = d.forbidden
    base = d.base.replace("/api/", "/api/v1/", 1)
    if resource == "link":
        url = f"{base}/work-items/{target.pk}/links/"
        payload = {"url": "https://example.com/allowed"}
    else:
        url = f"{base}/work-items/{d.own.pk}/relations/"
        related = d.make_issue(d.actor) if target == d.own else target
        payload = {"issues": [str(related.pk)], "relation_type": "relates_to"}
    response = api_key_client.post(url, payload, format="json")
    assert response.status_code == 201, response.data
    if resource == "link":
        assert IssueLink.objects.filter(issue=target, url=payload["url"]).exists()
    else:
        assert IssueRelation.objects.filter(issue=d.own, related_issue=related).exists()


def test_mixed_association_batch_is_rejected_without_partial_writes(association_data, association_endpoint):
    d, endpoint = association_data, association_endpoint
    response = endpoint.client.post(
        endpoint.url, {"issues": [str(d.own.pk), str(d.forbidden.pk)]}, format="json"
    )
    assert response.status_code == 403, response.data
    assert not endpoint.model.objects.filter(project=d.project).exists()
    from plane.bgtasks.issue_activities_task import issue_activity
    issue_activity.delay.assert_not_called()


@pytest.mark.parametrize("access", ["creator", "current-assignee", "admin"])
def test_authorized_association_add_succeeds(association_data, association_endpoint, access):
    d, endpoint = association_data, association_endpoint
    issue = d.own if access == "creator" else d.assigned
    if access == "admin":
        ProjectMember.objects.filter(pk=d.membership.pk).update(role=20)
        issue = d.forbidden
    response = endpoint.client.post(endpoint.url, {"issues": [str(issue.pk)]}, format="json")
    assert response.status_code in (200, 201), response.data
    assert endpoint.model.objects.filter(issue=issue, **endpoint.target).exists()


def test_association_remove_requires_issue_write_access(association_data, association_endpoint):
    d, endpoint = association_data, association_endpoint
    row = endpoint.model.objects.create(issue=d.forbidden, project=d.project, **endpoint.target)
    response = endpoint.client.delete(f"{endpoint.url}{d.forbidden.pk}/")
    assert response.status_code == 403, response.data
    assert endpoint.model.objects.filter(pk=row.pk).exists()


def test_bulk_archive_rejects_all_when_one_issue_is_forbidden(association_data, session_client):
    d = association_data
    Issue.objects.filter(pk__in=[d.own.pk, d.forbidden.pk]).update(state=d.done)
    response = session_client.post(
        f"{d.base}/bulk-archive-issues/", {"issue_ids": [str(d.own.pk), str(d.forbidden.pk)]}, format="json"
    )
    assert response.status_code == 403, response.data
    assert not Issue.objects.filter(project=d.project, archived_at__isnull=False).exists()


@pytest.mark.parametrize("method", ["post", "delete"])
def test_single_archive_and_unarchive_require_write_access(association_data, session_client, method):
    d = association_data
    Issue.objects.filter(pk=d.forbidden.pk).update(
        state=d.done, archived_at=timezone.now().date() if method == "delete" else None
    )
    response = getattr(session_client, method)(f"{d.base}/issues/{d.forbidden.pk}/archive/")
    assert response.status_code == 403, response.data
    d.forbidden.refresh_from_db()
    assert (d.forbidden.archived_at is not None) == (method == "delete")


@pytest.mark.parametrize("method", ["post", "patch", "put", "delete"])
def test_link_writes_including_inherited_put_require_access(association_data, session_client, method):
    d = association_data
    link = IssueLink.objects.create(issue=d.forbidden, project=d.project, url="https://example.com/original")
    url = f"{d.base}/issues/{d.forbidden.pk}/issue-links/"
    if method != "post":
        url += f"{link.pk}/"
    response = getattr(session_client, method)(url, {"url": "https://example.com/changed"}, format="json")
    assert response.status_code == 403, response.data
    assert IssueLink.objects.filter(issue=d.forbidden).count() == 1
    link.refresh_from_db()
    assert link.url == "https://example.com/original"


@pytest.mark.parametrize("operation", ["create", "remove"])
def test_relation_requires_both_endpoints(association_data, session_client, operation):
    d = association_data
    if operation == "remove":
        IssueRelation.objects.create(
            issue=d.own, related_issue=d.forbidden, relation_type="relates_to", project=d.project
        )
    url = f"{d.base}/issues/{d.own.pk}/{'issue-relation' if operation == 'create' else 'remove-relation'}/"
    payload = {"issues": [str(d.assigned.pk), str(d.forbidden.pk)], "relation_type": "relates_to"}
    if operation == "remove":
        payload = {"related_issue": str(d.forbidden.pk)}
    response = session_client.post(url, payload, format="json")
    assert response.status_code == 403, response.data
    assert IssueRelation.objects.filter(project=d.project).count() == (1 if operation == "remove" else 0)


def test_cross_project_relation_requires_target_membership(association_data, session_client):
    d = association_data
    project = Project.objects.create(name="Private", identifier="PRV", workspace=d.workspace)
    state = State.objects.create(name="Started", group="started", color="#000000", project=project)
    target = Issue.objects.create(name="Previously owned", project=project, state=state)
    Issue.objects.filter(pk=target.pk).update(created_by=d.actor)
    response = session_client.post(
        f"{d.base}/issues/{d.own.pk}/issue-relation/",
        {"issues": [str(target.pk)], "relation_type": "relates_to"}, format="json",
    )
    assert response.status_code == 403, response.data
    assert not IssueRelation.objects.filter(issue=d.own).exists()


@pytest.mark.parametrize("forbidden_side", ["child", "new-parent", "old-parent"])
def test_reparenting_requires_children_and_both_parents(association_data, session_client, forbidden_side):
    d = association_data
    old_parent = d.forbidden if forbidden_side == "old-parent" else d.make_issue(d.actor)
    child = d.forbidden if forbidden_side == "child" else d.make_issue(d.actor)
    new_parent = d.forbidden if forbidden_side == "new-parent" else d.own
    Issue.objects.filter(pk=child.pk).update(parent=old_parent)
    response = session_client.post(
        f"{d.base}/issues/{new_parent.pk}/sub-issues/",
        {"sub_issue_ids": [str(child.pk)]}, format="json",
    )
    assert response.status_code == 403, response.data
    child.refresh_from_db()
    assert child.parent_id == old_parent.pk


@pytest.mark.parametrize("public", [False, True])
def test_transfer_rejects_entire_batch_before_snapshot(association_data, request, public):
    d = association_data
    client = request.getfixturevalue("api_key_client" if public else "session_client")
    old_cycle = Cycle.objects.create(
        name="Finished", project=d.project, owned_by=d.actor, end_date=timezone.now() - timedelta(days=1)
    )
    for issue in [d.own, d.forbidden]:
        CycleIssue.objects.create(issue=issue, cycle=old_cycle, project=d.project)
    base = d.base.replace("/api/", "/api/v1/", 1) if public else d.base
    response = client.post(
        f"{base}/cycles/{old_cycle.pk}/transfer-issues/",
        {"new_cycle_id": str(d.cycle.pk)}, format="json",
    )
    assert response.status_code == 403, response.data
    assert CycleIssue.objects.filter(cycle=old_cycle).count() == 2
    assert not CycleIssue.objects.filter(cycle=d.cycle).exists()
    old_cycle.refresh_from_db()
    assert not old_cycle.progress_snapshot


@pytest.mark.parametrize("public", [False, True])
def test_transfer_rechecks_late_arrival_and_rolls_back_snapshot(
    association_data, request, monkeypatch, public
):
    from plane.utils import cycle_transfer_issues
    from plane.bgtasks.issue_activities_task import issue_activity

    d = association_data
    client = request.getfixturevalue("api_key_client" if public else "session_client")
    snapshot = {"previous_snapshot": True}
    old_cycle = Cycle.objects.create(
        name="Finished before publication", project=d.project, owned_by=d.actor,
        end_date=timezone.now() - timedelta(days=1), progress_snapshot=snapshot,
    )
    CycleIssue.objects.create(issue=d.own, cycle=old_cycle, project=d.project)
    checked_scope = Mock(wraps=cycle_transfer_issues.lock_issue_write_scope)
    monkeypatch.setattr(cycle_transfer_issues, "lock_issue_write_scope", checked_scope)

    def publish_after_preflight(**kwargs):
        # Simulate draft publication between endpoint authorization and the
        # utility's final query. This test insertion shares the rollback scope.
        CycleIssue.objects.create(issue=d.forbidden, cycle=old_cycle, project=d.project)
        return {}

    plot = Mock(side_effect=publish_after_preflight)
    monkeypatch.setattr(cycle_transfer_issues, "burndown_plot", plot)
    base = d.base.replace("/api/", "/api/v1/", 1) if public else d.base
    response = client.post(
        f"{base}/cycles/{old_cycle.pk}/transfer-issues/",
        {"new_cycle_id": str(d.cycle.pk)}, format="json",
    )

    assert response.status_code == 403, response.data
    plot.assert_called_once()
    checked_scope.assert_called_once()
    assert {str(pk) for pk in checked_scope.call_args.args[2]} == {str(d.own.pk), str(d.forbidden.pk)}
    assert CycleIssue.objects.filter(cycle=old_cycle, issue=d.own).exists()
    assert not CycleIssue.objects.filter(cycle=d.cycle).exists()
    old_cycle.refresh_from_db()
    assert old_cycle.progress_snapshot == snapshot
    issue_activity.delay.assert_not_called()


def test_issue_module_batch_rejects_foreign_module_before_any_write(association_data, session_client):
    d = association_data
    project = Project.objects.create(name="Foreign", identifier="FRN", workspace=d.workspace)
    foreign = Module.objects.create(name="Foreign module", project=project)
    response = session_client.post(
        f"{d.base}/issues/{d.own.pk}/modules/",
        {"modules": [str(d.module.pk), str(foreign.pk)]}, format="json",
    )
    assert response.status_code == 403, response.data
    assert not ModuleIssue.objects.filter(issue=d.own).exists()


def test_association_permission_checks_run_after_row_lock(
    association_data, session_client, monkeypatch
):
    from django.db import connection
    from django.test.utils import CaptureQueriesContext
    from plane.utils import issue_write_scope

    d = association_data
    original = issue_write_scope.require_issue_write_access
    checked = []
    with CaptureQueriesContext(connection) as queries:
        def check_locked(user, issue):
            assert connection.in_atomic_block
            assert any("FOR UPDATE" in query["sql"] and "issues" in query["sql"] for query in queries)
            checked.append(issue.pk)
            return original(user, issue)

        monkeypatch.setattr(issue_write_scope, "require_issue_write_access", check_locked)
        response = session_client.post(
            f"{d.base}/modules/{d.module.pk}/issues/", {"issues": [str(d.own.pk)]}, format="json"
        )
    assert response.status_code == 201, response.data
    assert checked == [d.own.pk]


@pytest.mark.parametrize("resource", ["cycle", "module"])
@pytest.mark.parametrize("method", ["patch", "put"])
def test_inherited_bridge_updates_cannot_replace_issue(association_data, session_client, resource, method):
    d = association_data
    if resource == "cycle":
        row = CycleIssue.objects.create(issue=d.own, cycle=d.cycle, project=d.project)
        suffix = f"cycles/{d.cycle.pk}/cycle-issues"
    else:
        row = ModuleIssue.objects.create(issue=d.own, module=d.module, project=d.project)
        suffix = f"modules/{d.module.pk}/issues"
    response = getattr(session_client, method)(
        f"{d.base}/{suffix}/{d.own.pk}/", {"issue": str(d.forbidden.pk)}, format="json"
    )
    assert response.status_code == 405, response.data
    row.refresh_from_db()
    assert row.issue_id == d.own.pk
