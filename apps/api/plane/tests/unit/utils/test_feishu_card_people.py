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


def test_delivered_actor_and_assignee_names_come_from_plane(notification_people):
    f = notification_people
    messages = handoff(f)
    for message in messages:
        deliver_feishu_message.run(str(message.pk))
        message.refresh_from_db()
        assert message.status == "sent"
        assert NAME_SLOTS_KEY not in message.card
        text = json.dumps(message.card, ensure_ascii=False)
        assert all(user.display_name in text for user in (f.actor, f.old, f.new))
        assert "飞书操作人" not in text and "飞书原负责人" not in text and "飞书新负责人" not in text
    assert f.send.call_count == 2
    looked_up_mobiles = [call.args[0] for call in f.lookup.call_args_list]
    assert sorted(looked_up_mobiles) == sorted([f.old.mobile_number, f.new.mobile_number])
    f.names.assert_not_called()
    for call in f.send.call_args_list:
        assert NAME_SLOTS_KEY not in call.args[1]


@pytest.mark.parametrize("missing_name", ["blank", "whitespace", "inactive_user", "inactive_membership"])
def test_unavailable_display_name_uses_generic_member_label(notification_people, missing_name):
    f = notification_people
    if missing_name in {"blank", "whitespace"}:
        User.objects.filter(pk=f.actor.pk).update(display_name="" if missing_name == "blank" else " \t\n ")
    elif missing_name == "inactive_user":
        User.objects.filter(pk=f.actor.pk).update(is_active=False)
    else:
        WorkspaceMember.objects.filter(workspace=f.workspace, member=f.actor).update(is_active=False)
    row = handoff(f)[0]
    deliver_feishu_message.run(str(row.pk))
    row.refresh_from_db()
    assert row.status == "sent"
    actor_text = row.card["elements"][0]["text"]["content"]
    assert f"{UNAVAILABLE_NAME}修改了与你有关的工作项" in actor_text
    assert f.actor.display_name not in actor_text
    assert NAME_SLOTS_KEY not in row.card
    f.names.assert_not_called()


def test_display_name_content_is_frozen_before_retry(notification_people):
    f = notification_people
    f.send.side_effect = [FeishuError("network_error", retryable=True), None]
    row = handoff(f)[0]
    deliver_feishu_message.run(str(row.pk))
    row.refresh_from_db()
    assert row.status == "pending" and NAME_SLOTS_KEY not in row.card
    first_card = row.card
    User.objects.filter(pk__in=[f.actor.pk, f.old.pk, f.new.pk]).update(display_name="重试前修改了昵称")
    deliver_feishu_message.run(str(row.pk))
    row.refresh_from_db()
    assert row.status == "sent" and row.card == first_card
    f.names.assert_not_called()
    assert f.send.call_args_list[0].args == f.send.call_args_list[1].args


@pytest.mark.parametrize("actor_mobile", ["", "invalid-phone", None])
def test_actor_display_name_does_not_require_mobile_or_feishu_profile(notification_people, actor_mobile):
    f = notification_people
    User.objects.filter(pk=f.actor.pk).update(mobile_number=actor_mobile)
    f.names.side_effect = FeishuError("network_error", retryable=True)
    row = handoff(f)[0]
    deliver_feishu_message.run(str(row.pk))
    row.refresh_from_db()
    assert row.status == "sent"
    assert f"{f.actor.display_name}修改了与你有关的工作项" in row.card["elements"][0]["text"]["content"]
    f.lookup.assert_called_once_with(row.recipient_mobile)
    f.names.assert_not_called()
    f.send.assert_called_once()


def test_state_assignee_changes_use_display_names(notification_people):
    f = notification_people
    rows = queue_activity_notifications(
        event_key=str(uuid4()),
        type="issue.activity.updated",
        issue_id=str(f.issue.pk),
        actor_id=str(f.actor.pk),
        project_id=str(f.project.pk),
        current_instance={"state_assignees": {str(f.issue.state_id): [str(f.old.pk)]}},
        requested_data={"state_assignees": {str(f.issue.state_id): [str(f.new.pk)]}},
    )
    assert {row.receiver_id for row in rows} == {f.old.pk, f.new.pk}
    row = rows[0]
    deliver_feishu_message.run(str(row.pk))
    row.refresh_from_db()
    assert row.status == "sent"
    assert row.card["elements"][1]["text"]["content"] == f"开发中：{f.old.display_name} → {f.new.display_name}"
    f.names.assert_not_called()


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
    assert f"{f.actor.display_name}在与你有关的工作项中发表了评论" in row.card["elements"][0]["text"]["content"]
    assert literal == row.card["elements"][1]["text"]["content"]
    assert row.card["elements"][-1]["actions"][0]["url"].endswith(f"/browse/CARD-{f.issue.sequence_id}/")
