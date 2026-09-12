# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import json
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from plane.bgtasks.feishu_task import deliver_feishu_message
from plane.db.models import (
    FeishuIntegration,
    Issue,
    IssueAssignee,
    Project,
    ProjectMember,
    State,
    User,
    WorkspaceMember,
)
from plane.utils.feishu import FeishuError, encrypt_secret
from plane.utils.feishu_card_people import NAME_SLOTS_KEY, UNAVAILABLE_NAME
from plane.utils.feishu_notifications import queue_activity_notifications

pytestmark = [pytest.mark.unit, pytest.mark.django_db]


@pytest.fixture
def notification_people(workspace, create_user, settings, monkeypatch):
    settings.APP_BASE_URL = "https://plane.example.test"
    User.objects.filter(pk=create_user.pk).update(display_name="SSO_ACTOR", mobile_number="+8613800000001")
    create_user.refresh_from_db()
    old = User.objects.create(
        email="old-person@example.test", username="old-person", display_name="SSO_OLD", mobile_number="+8613800000002"
    )
    new = User.objects.create(
        email="new-person@example.test", username="new-person", display_name="SSO_NEW", mobile_number="+8613800000003"
    )
    project = Project.objects.create(name="People cards", identifier="CARD", workspace=workspace)
    for user in (create_user, old, new):
        WorkspaceMember.objects.get_or_create(workspace=workspace, member=user, defaults={"role": 15})
        ProjectMember.objects.create(project=project, member=user, role=15)
    state = State.objects.create(project=project, name="开发中", group="started", default=True)
    issue = Issue.objects.create(project=project, state=state, name="修复登录页面")
    IssueAssignee.objects.create(project=project, issue=issue, assignee=new)
    integration = FeishuIntegration.objects.create(
        workspace=workspace, app_id="cli_people", app_secret=encrypt_secret("fixture-secret"), enabled=True
    )
    monkeypatch.setattr("plane.bgtasks.feishu_task.dispatch_feishu_message", Mock())
    monkeypatch.setattr(deliver_feishu_message, "apply_async", Mock())
    ids = {create_user.mobile_number: "ou_actor", old.mobile_number: "ou_old", new.mobile_number: "ou_new"}
    lookup = Mock(side_effect=lambda mobile: ids[mobile])
    names = Mock(
        side_effect=lambda open_id: {"ou_actor": "飞书操作人", "ou_old": "飞书原负责人", "ou_new": "飞书新负责人"}[
            open_id
        ]
    )
    send = Mock()
    monkeypatch.setattr("plane.bgtasks.feishu_task.FeishuClient.resolve_mobile", lookup)
    monkeypatch.setattr("plane.bgtasks.feishu_task.FeishuClient.get_display_name", names)
    monkeypatch.setattr("plane.bgtasks.feishu_task.FeishuClient.send_card", send)
    return SimpleNamespace(
        workspace=workspace,
        project=project,
        issue=issue,
        integration=integration,
        actor=create_user,
        old=old,
        new=new,
        lookup=lookup,
        names=names,
        send=send,
    )


def handoff(f):
    return queue_activity_notifications(
        event_key=str(uuid4()),
        type="issue.activity.updated",
        issue_id=str(f.issue.pk),
        actor_id=str(f.actor.pk),
        project_id=str(f.project.pk),
        current_instance=json.dumps({"assignee_ids": [str(f.old.pk)]}),
        requested_data=json.dumps({"assignee_ids": [str(f.new.pk)]}),
    )


def test_update_title_and_recipient_relevance_are_explicit(notification_people):
    f = notification_people
    messages = handoff(f)
    assert len(messages) == 2
    for message in messages:
        assert message.card["header"]["title"]["content"] == "工作项更新提醒 - 修复登录页面"
        assert "与你有关的工作项" in message.card["elements"][0]["text"]["content"]
        assert f"CARD-{f.issue.sequence_id}" in message.card["elements"][0]["text"]["content"]
        raw = json.dumps(message.card, ensure_ascii=False)
        assert "SSO_ACTOR" not in raw and "SSO_OLD" not in raw and "SSO_NEW" not in raw
        assert f.actor.mobile_number not in raw


def test_delivered_actor_and_assignee_names_come_from_feishu(notification_people):
    f = notification_people
    messages = handoff(f)
    for message in messages:
        deliver_feishu_message.run(str(message.pk))
        message.refresh_from_db()
        assert message.status == "sent"
        assert NAME_SLOTS_KEY not in message.card
        text = json.dumps(message.card, ensure_ascii=False)
        assert all(name in text for name in ("飞书操作人", "飞书原负责人", "飞书新负责人"))
        assert "SSO_" not in text
    assert f.send.call_count == 2
    for call in f.send.call_args_list:
        assert NAME_SLOTS_KEY not in call.args[1]


def test_unavailable_feishu_name_never_falls_back_to_sso(notification_people):
    f = notification_people
    f.names.side_effect = FeishuError("provider_rejected")
    row = handoff(f)[0]
    deliver_feishu_message.run(str(row.pk))
    row.refresh_from_db()
    assert row.status == "sent"
    text = json.dumps(row.card, ensure_ascii=False)
    assert UNAVAILABLE_NAME in text and "SSO_" not in text
    assert NAME_SLOTS_KEY not in row.card


def test_nickname_content_is_frozen_before_retry(notification_people):
    f = notification_people
    f.send.side_effect = [FeishuError("network_error", retryable=True), None]
    row = handoff(f)[0]
    deliver_feishu_message.run(str(row.pk))
    count = f.names.call_count
    row.refresh_from_db()
    assert row.status == "pending" and NAME_SLOTS_KEY not in row.card
    first_card = row.card
    f.names.side_effect = AssertionError("Names must remain frozen on transport retry")
    deliver_feishu_message.run(str(row.pk))
    row.refresh_from_db()
    assert row.status == "sent" and row.card == first_card
    assert f.names.call_count == count
    assert f.send.call_args_list[0].args == f.send.call_args_list[1].args


def test_transient_name_lookup_failure_retries_without_sending(notification_people):
    f = notification_people
    f.names.side_effect = FeishuError("network_error", retryable=True)
    row = handoff(f)[0]
    deliver_feishu_message.run(str(row.pk))
    row.refresh_from_db()
    assert row.status == "pending" and NAME_SLOTS_KEY in row.card
    f.send.assert_not_called()


def test_comment_card_relevance_and_free_text_are_preserved(notification_people):
    f = notification_people
    literal = f"评论中的字面文本 {{user_id: {f.actor.pk}}} 不应被替换"
    rows = queue_activity_notifications(
        event_key=str(uuid4()),
        type="comment.activity.created",
        issue_id=str(f.issue.pk),
        actor_id=str(f.actor.pk),
        project_id=str(f.project.pk),
        requested_data=json.dumps({"comment_html": f"<p>{literal}</p>"}),
        current_instance=None,
    )
    row = rows[0]
    deliver_feishu_message.run(str(row.pk))
    row.refresh_from_db()
    assert "飞书操作人在与你有关的工作项中发表了评论" in row.card["elements"][0]["text"]["content"]
    assert literal == row.card["elements"][1]["text"]["content"]
    assert row.card["elements"][-1]["actions"][0]["url"].endswith(f"/browse/CARD-{f.issue.sequence_id}/")
