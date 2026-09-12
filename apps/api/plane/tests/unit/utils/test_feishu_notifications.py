# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import json
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from celery import Task
from django.db import transaction
from rest_framework import status

from plane.bgtasks.issue_activities_task import issue_activity
from plane.db.models import (
    FeishuIntegration,
    FeishuMessage,
    Issue,
    IssueAssignee,
    Project,
    ProjectMember,
    State,
    User,
    WorkspaceMember,
)
from plane.utils.feishu_notifications import queue_activity_notifications

pytestmark = [pytest.mark.django_db, pytest.mark.unit]


@pytest.fixture
def feishu_events(workspace, create_user, settings, monkeypatch):
    settings.APP_BASE_URL = "https://plane.example.test/subpath"
    settings.WEB_URL = "https://plane.example.test/subpath"
    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
    from django.core.cache import cache

    cache.clear()
    published = Mock()
    monkeypatch.setattr(Task, "apply_async", published)
    dispatched = Mock()
    monkeypatch.setattr("plane.bgtasks.feishu_task.dispatch_feishu_message", dispatched)
    project = Project.objects.create(workspace=workspace, name="Feishu events", identifier="FS")
    developer = User.objects.create(email="fs-dev@example.test", username="fs-dev", mobile_number="+8613800138000")
    reviewer = User.objects.create(email="fs-review@example.test", username="fs-review", mobile_number="+8613900139000")
    ProjectMember.objects.create(project=project, member=create_user, role=20)
    for user in (developer, reviewer):
        WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
        ProjectMember.objects.create(project=project, member=user, role=15)
    development = State.objects.create(project=project, name="开发中", group="started", default=True)
    acceptance = State.objects.create(project=project, name="开发完成/待验收", group="started")
    issue = Issue.objects.create(
        project=project,
        name="原始标题",
        state=development,
        state_assignees={str(development.pk): [str(developer.pk)], str(acceptance.pk): [str(reviewer.pk)]},
    )
    issue.save(created_by_id=create_user.pk)
    IssueAssignee.objects.create(issue=issue, project=project, assignee=developer)
    integration = FeishuIntegration.objects.create(
        workspace=workspace, app_id="cli_test", app_secret="ciphertext", enabled=True
    )
    return SimpleNamespace(
        issue=issue,
        project=project,
        workspace=workspace,
        actor=create_user,
        developer=developer,
        reviewer=reviewer,
        development=development,
        acceptance=acceptance,
        integration=integration,
        published=published,
        dispatched=dispatched,
    )


def queue(fixture, *, event_type="issue.activity.updated", before=None, after=None, event_key=None):
    return queue_activity_notifications(
        event_key=event_key or str(uuid4()),
        type=event_type,
        issue_id=str(fixture.issue.pk),
        project_id=str(fixture.project.pk),
        actor_id=str(fixture.actor.pk),
        current_instance=json.dumps(before) if before is not None else None,
        requested_data=json.dumps(after) if after is not None else None,
    )


def contents(message):
    return json.dumps(message.card, ensure_ascii=False)


def test_field_change_freezes_card_and_dispatches_after_commit(feishu_events, django_capture_on_commit_callbacks):
    f = feishu_events
    with django_capture_on_commit_callbacks(execute=True):
        messages = queue(f, before={"name": "旧标题"}, after={"name": "新标题"})
        f.dispatched.assert_not_called()
    assert len(messages) == 1
    message = messages[0]
    assert message.receiver_id == f.developer.pk
    assert "旧标题" in contents(message) and "新标题" in contents(message)
    action = message.card["elements"][-1]["actions"][0]
    assert action["text"]["content"] == "查看工作项"
    assert action["url"] == f"https://plane.example.test/subpath/{f.workspace.slug}/browse/FS-{f.issue.sequence_id}/"
    assert message.recipient_open_id == ""
    assert message.recipient_mobile == "+8613800138000"
    f.dispatched.assert_called_once_with(str(message.pk))
    # Subsequent changes do not rewrite an already queued event.
    f.issue.name = "后来标题"
    f.issue.save()
    message.refresh_from_db()
    assert "后来标题" not in contents(message)


def test_reassignment_notifies_union_with_deduplication(feishu_events):
    f = feishu_events
    IssueAssignee.objects.create(issue=f.issue, project=f.project, assignee=f.reviewer)
    messages = queue(
        f,
        before={"assignee_ids": [str(f.developer.pk)]},
        after={"assignee_ids": [str(f.developer.pk), str(f.reviewer.pk)]},
    )
    assert {message.receiver_id for message in messages} == {f.developer.pk, f.reviewer.pk}
    assert len(messages) == 2


def test_removing_last_assignee_still_notifies_previous_owner(feishu_events):
    f = feishu_events
    IssueAssignee.objects.filter(issue=f.issue).delete()
    messages = queue(f, before={"assignees": [str(f.developer.pk)]}, after={"assignees": []})
    assert len(messages) == 1
    assert messages[0].receiver_id == f.developer.pk
    assert "未分配" in contents(messages[0])


def test_changed_future_state_assignees_are_also_notified(feishu_events):
    f = feishu_events
    messages = queue(
        f,
        before={"state_assignees": {str(f.acceptance.pk): [str(f.developer.pk)]}},
        after={"state_assignees": {str(f.acceptance.pk): [str(f.reviewer.pk)]}},
    )
    assert {message.receiver_id for message in messages} == {f.developer.pk, f.reviewer.pk}
    assert "开发完成/待验收" in contents(messages[0])


@pytest.mark.parametrize(
    "event_type", ["comment.activity.created", "comment.activity.updated", "comment.activity.deleted"]
)
def test_comments_produce_plain_text_cards(feishu_events, event_type):
    messages = queue(
        feishu_events,
        event_type=event_type,
        before={"comment_html": "<p>旧评论</p>"},
        after={"comment_html": "<p>验收失败，请修复</p><script>do_bad_things()</script>"}
        if not event_type.endswith("deleted")
        else {},
    )
    assert len(messages) == 1
    text = contents(messages[0])
    assert "评论" in text and "script" not in text and "do_bad_things" not in text
    assert messages[0].card["elements"][1]["text"]["tag"] == "plain_text"


def test_unchanged_fields_and_comment_do_not_notify(feishu_events):
    f = feishu_events
    assert queue(f, before={"priority": "high"}, after={"priority": "high", "sort_order": 999}) == []
    assert (
        queue(f, event_type="comment.activity.updated", before={"comment_html": "same"}, after={"comment_html": "same"})
        == []
    )
    assert FeishuMessage.objects.count() == 0


def test_duplicate_activity_task_id_does_not_queue_duplicate_messages(feishu_events):
    f = feishu_events
    key = str(uuid4())
    assert len(queue(f, event_key=key, before={"name": "a"}, after={"name": "b"})) == 1
    assert queue(f, event_key=key, before={"name": "a"}, after={"name": "b"}) == []
    assert FeishuMessage.objects.count() == 1


def test_disabled_integration_and_no_responsible_members_do_not_notify(feishu_events):
    f = feishu_events
    f.integration.enabled = False
    f.integration.save()
    assert queue(f, before={"name": "a"}, after={"name": "b"}) == []
    f.integration.enabled = True
    f.integration.save()
    IssueAssignee.objects.filter(issue=f.issue).delete()
    assert queue(f, before={"name": "a"}, after={"name": "b"}) == []


def test_missing_mobile_records_skipped_recipient(feishu_events):
    f = feishu_events
    User.objects.filter(pk=f.developer.pk).update(mobile_number="")
    messages = queue(f, before={"name": "a"}, after={"name": "b"})
    assert len(messages) == 1
    assert messages[0].status == "skipped"
    assert messages[0].last_error == "phone_missing"
    f.dispatched.assert_not_called()


def test_mobile_snapshot_queues_without_manual_binding_or_network(feishu_events, monkeypatch):
    f = feishu_events
    User.objects.filter(pk=f.developer.pk).update(mobile_number="138 0013 8000")
    network = Mock(side_effect=AssertionError("Network access must happen in the sender task"))
    monkeypatch.setattr("requests.post", network)
    messages = queue(f, event_type="comment.activity.created", after={"comment_html": "<p>请验收</p>"})
    assert len(messages) == 1
    message = messages[0]
    assert message.status == "pending"
    assert message.recipient_mobile == "+8613800138000"
    assert message.recipient_open_id == ""
    assert "13800138000" not in contents(message)
    network.assert_not_called()
    User.objects.filter(pk=f.developer.pk).update(mobile_number="+8613900139000")
    message.refresh_from_db()
    assert message.recipient_mobile == "+8613800138000"


def test_mobile_is_the_only_recipient_identity(feishu_events):
    f = feishu_events
    User.objects.filter(pk=f.developer.pk).update(mobile_number="+8613800138000")
    messages = queue(f, before={"name": "a"}, after={"name": "b"})
    assert messages[0].recipient_mobile == "+8613800138000"
    assert messages[0].recipient_open_id == ""


def test_invalid_mobile_is_skipped_without_fallback(feishu_events):
    f = feishu_events
    User.objects.filter(pk=f.developer.pk).update(mobile_number="invalid-phone")
    messages = queue(f, before={"name": "a"}, after={"name": "b"})
    assert messages[0].recipient_mobile == ""
    assert messages[0].recipient_open_id == ""
    assert messages[0].status == "skipped"
    assert messages[0].last_error == "phone_invalid"


@pytest.mark.parametrize("revocation", ["project", "workspace", "user", "guest"])
def test_revoked_members_do_not_receive_private_cards(feishu_events, revocation):
    f = feishu_events
    if revocation == "project":
        ProjectMember.objects.filter(project=f.project, member=f.developer).update(is_active=False)
    elif revocation == "workspace":
        WorkspaceMember.objects.filter(workspace=f.workspace, member=f.developer).update(is_active=False)
    elif revocation == "user":
        User.objects.filter(pk=f.developer.pk).update(is_active=False)
    else:
        ProjectMember.objects.filter(project=f.project, member=f.developer).update(role=5)
    assert queue(f, before={"name": "a"}, after={"name": "b"}) == []


def test_rollback_discards_outbox_and_dispatch(feishu_events, django_capture_on_commit_callbacks):
    f = feishu_events
    with django_capture_on_commit_callbacks(execute=True):
        with transaction.atomic():
            queue(f, before={"name": "a"}, after={"name": "b"})
            transaction.set_rollback(True)
    assert FeishuMessage.objects.count() == 0
    f.dispatched.assert_not_called()


def test_activity_publication_captures_even_when_in_app_notification_disabled(feishu_events):
    f = feishu_events
    issue_activity.apply_async(
        kwargs={
            "type": "issue.activity.updated",
            "issue_id": str(f.issue.pk),
            "project_id": str(f.project.pk),
            "actor_id": str(f.developer.pk),
            "requested_data": json.dumps({"name": "new"}),
            "current_instance": json.dumps({"name": "old"}),
            "epoch": 0,
            "notification": False,
        },
        task_id="stable-event",
    )
    assert FeishuMessage.objects.get().receiver_id == f.developer.pk
    assert FeishuMessage.objects.get().event_key == f"stable-event:{f.issue.pk}"
    f.published.assert_called_once()


def test_capture_failure_does_not_block_existing_activity(feishu_events, monkeypatch):
    f = feishu_events
    monkeypatch.setattr(
        "plane.utils.feishu_notifications.queue_activity_notifications", Mock(side_effect=RuntimeError("private data"))
    )
    issue_activity.delay(type="comment.activity.created", issue_id=str(f.issue.pk), project_id=str(f.project.pk))
    f.published.assert_called_once()


@pytest.mark.parametrize("api", ["app", "external"])
def test_http_state_handoff_notifies_previous_and_new_assignees(
    feishu_events, api, request, django_capture_on_commit_callbacks
):
    f = feishu_events
    client = request.getfixturevalue("session_client" if api == "app" else "api_key_client")
    prefix, state_key = ("/api", "state_id") if api == "app" else ("/api/v1", "state")
    url = f"{prefix}/workspaces/{f.workspace.slug}/projects/{f.project.pk}/issues/{f.issue.pk}/"
    with django_capture_on_commit_callbacks(execute=True):
        response = client.patch(url, {state_key: str(f.acceptance.pk)}, format="json")
    assert response.status_code == status.HTTP_200_OK, response.data
    assert set(FeishuMessage.objects.values_list("receiver_id", flat=True)) == {f.developer.pk, f.reviewer.pk}
    assert all("开发完成/待验收" in contents(message) for message in FeishuMessage.objects.all())
    assert f.dispatched.call_count == 2


def test_http_comment_notifies_assignee_even_when_they_are_the_actor(
    feishu_events, session_client, django_capture_on_commit_callbacks
):
    f = feishu_events
    session_client.force_authenticate(user=f.developer)
    url = f"/api/workspaces/{f.workspace.slug}/projects/{f.project.pk}/issues/{f.issue.pk}/comments/"
    with django_capture_on_commit_callbacks(execute=True):
        response = session_client.post(url, {"comment_html": "<p>已修复，请验收</p>"}, format="json")
    assert response.status_code == status.HTTP_201_CREATED, response.data
    message = FeishuMessage.objects.get()
    assert message.receiver_id == f.developer.pk
    assert "已修复，请验收" in contents(message)


def test_http_forbidden_assignment_does_not_send_cards(
    feishu_events, session_client, django_capture_on_commit_callbacks
):
    f = feishu_events
    session_client.force_authenticate(user=f.developer)
    url = f"/api/workspaces/{f.workspace.slug}/projects/{f.project.pk}/issues/{f.issue.pk}/"
    with django_capture_on_commit_callbacks(execute=True):
        response = session_client.patch(url, {"assignee_ids": [str(f.reviewer.pk)]}, format="json")
    assert response.status_code == status.HTTP_403_FORBIDDEN
    assert FeishuMessage.objects.count() == 0
    f.dispatched.assert_not_called()


def test_http_bulk_dates_send_one_card_after_success(feishu_events, session_client, django_capture_on_commit_callbacks):
    f = feishu_events
    url = f"/api/workspaces/{f.workspace.slug}/projects/{f.project.pk}/issue-dates/"
    with django_capture_on_commit_callbacks(execute=True):
        response = session_client.post(
            url,
            {
                "updates": [
                    {
                        "id": str(f.issue.pk),
                        "start_date": "2026-09-01",
                        "target_date": "2026-09-30",
                    }
                ]
            },
            format="json",
        )
    assert response.status_code == status.HTTP_200_OK, response.data
    f.issue.refresh_from_db()
    assert str(f.issue.start_date) == "2026-09-01"
    assert str(f.issue.target_date) == "2026-09-30"
    message = FeishuMessage.objects.get()
    assert "开始日期" in contents(message) and "截止日期" in contents(message)


def test_http_invalid_bulk_dates_do_not_notify_or_update(
    feishu_events, session_client, django_capture_on_commit_callbacks
):
    f = feishu_events
    other = Issue.objects.create(project=f.project, name="invalid dates", state=f.development)
    url = f"/api/workspaces/{f.workspace.slug}/projects/{f.project.pk}/issue-dates/"
    with django_capture_on_commit_callbacks(execute=True):
        response = session_client.post(
            url,
            {
                "updates": [
                    {"id": str(f.issue.pk), "start_date": "2026-09-01"},
                    {"id": str(other.pk), "start_date": "2026-10-01", "target_date": "2026-09-01"},
                ]
            },
            format="json",
        )
    assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
    f.issue.refresh_from_db()
    assert f.issue.start_date is None
    assert FeishuMessage.objects.count() == 0


def test_cycle_batch_event_captures_each_affected_issue(feishu_events):
    f = feishu_events
    messages = queue_activity_notifications(
        event_key=str(uuid4()),
        type="cycle.activity.created",
        issue_id=None,
        project_id=str(f.project.pk),
        actor_id=str(f.actor.pk),
        requested_data="{}",
        current_instance=json.dumps({"updated_cycle_issues": [{"issue_id": str(f.issue.pk)}]}),
    )
    assert len(messages) == 1
    assert messages[0].receiver_id == f.developer.pk
    assert "周期" in contents(messages[0])


@pytest.mark.parametrize(
    "event_type",
    [
        "link.activity.created",
        "link.activity.deleted",
        "attachment.activity.created",
        "attachment.activity.deleted",
        "issue_relation.activity.created",
        "issue_relation.activity.deleted",
    ],
)
def test_related_activity_produces_detail_card(feishu_events, event_type):
    messages = queue(feishu_events, event_type=event_type, after={})
    assert len(messages) == 1
    assert messages[0].card["elements"][-1]["actions"][0]["url"].startswith("https://plane.example.test/")


def test_sso_phone_to_feishu_card_end_to_end(feishu_events, monkeypatch):
    from django.test import RequestFactory
    from plane.authentication.provider.oauth.meowalive import MeowAliveOAuthProvider
    from plane.bgtasks.feishu_task import deliver_feishu_message
    from plane.utils.feishu import CONTACT_URL, MESSAGE_URL, TOKEN_URL, encrypt_secret

    f = feishu_events
    provider = object.__new__(MeowAliveOAuthProvider)
    provider.request = RequestFactory().get("/auth/meowalive/callback/", HTTP_USER_AGENT="Feishu integration test")
    provider.provider = "meowalive"
    provider.profile = {"phone_number": "138 0013 8000", "phone_number_verified": True}
    provider.save_user_data(f.developer)
    f.developer.refresh_from_db()
    assert f.developer.mobile_number == "+8613800138000"
    f.integration.app_secret = encrypt_secret("test-app-secret")
    f.integration.save()
    message = queue(f, event_type="comment.activity.created", after={"comment_html": "<p>请查看验收结果</p>"})[0]
    replies = [
        {"code": 0, "tenant_access_token": "test-tenant-token"},
        {"code": 0, "data": {"user_list": [{"user_id": "ou_sso_member", "mobile": "+8613800138000"}]}},
        {"code": 0, "data": {"message_id": "om_example"}},
    ]
    transport = Mock(side_effect=[Mock(status_code=200, json=Mock(return_value=payload)) for payload in replies])
    monkeypatch.setattr("requests.post", transport)
    deliver_feishu_message.run(str(message.pk))
    message.refresh_from_db()
    assert message.status == "sent"
    assert message.recipient_open_id == "ou_sso_member"
    assert [call.args[0] for call in transport.call_args_list] == [TOKEN_URL, CONTACT_URL, MESSAGE_URL]
    assert transport.call_args_list[1].kwargs["json"] == {"mobiles": ["+8613800138000"], "include_resigned": False}
    sent = transport.call_args_list[2].kwargs["json"]
    assert sent["receive_id"] == "ou_sso_member"
    assert sent["msg_type"] == "interactive"
    assert sent["uuid"] == str(message.pk)
    card = json.loads(sent["content"])
    assert "请查看验收结果" in json.dumps(card, ensure_ascii=False)
    assert card["elements"][-1]["actions"][0]["url"].endswith(f"/browse/FS-{f.issue.sequence_id}/")
