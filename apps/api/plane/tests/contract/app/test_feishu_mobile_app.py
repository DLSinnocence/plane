# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import uuid
from unittest.mock import patch

import pytest

from plane.bgtasks.feishu_task import deliver_feishu_message
from plane.db.models import FeishuIntegration, FeishuMessage, User, WorkspaceMember
from plane.utils.feishu import FeishuError, encrypt_secret

pytestmark = [pytest.mark.contract, pytest.mark.django_db]
MOBILE = "+8613812345678"


def url(workspace, suffix):
    return f"/api/workspaces/{workspace.slug}/integrations/feishu/{suffix}"


@pytest.fixture(autouse=True)
def isolated_transport(settings):
    settings.APP_BASE_URL = "https://plane.example.com"
    settings.WEB_URL = ""
    with patch("plane.utils.feishu.requests.post", side_effect=AssertionError("Unmocked transport")):
        yield


@pytest.fixture
def integration(workspace, create_user):
    User.objects.filter(pk=create_user.pk).update(mobile_number=MOBILE)
    create_user.refresh_from_db()
    return FeishuIntegration.objects.create(
        workspace=workspace,
        app_id="mobile-app",
        app_secret=encrypt_secret("secret"),
        enabled=True,
    )


def queued(integration, user):
    return FeishuMessage.objects.create(
        integration=integration,
        receiver=user,
        recipient_mobile=MOBILE,
        recipient_open_id="",
        app_id=integration.app_id,
        event_key=f"test:{uuid.uuid4()}",
        card={"elements": []},
    )


def test_mobile_delivery_freezes_result_and_never_resends_success(integration, create_user):
    row = queued(integration, create_user)
    with (
        patch("plane.bgtasks.feishu_task.FeishuClient.resolve_mobile", return_value="ou_mobile") as lookup,
        patch("plane.bgtasks.feishu_task.FeishuClient.send_card") as send,
    ):
        deliver_feishu_message.run(str(row.pk))
        deliver_feishu_message.run(str(row.pk))
    lookup.assert_called_once_with(MOBILE)
    send.assert_called_once_with("ou_mobile", row.card, row.id)
    row.refresh_from_db()
    assert row.status == "sent" and row.recipient_open_id == "ou_mobile"


@pytest.mark.parametrize("snapshot,reason", [("", "phone_missing"), ("invalid", "phone_invalid")])
def test_legacy_open_id_only_row_never_sends(integration, create_user, snapshot, reason):
    row = queued(integration, create_user)
    FeishuMessage.objects.filter(pk=row.pk).update(recipient_mobile=snapshot, recipient_open_id="ou_legacy_manual")
    with (
        patch("plane.bgtasks.feishu_task.FeishuClient.resolve_mobile") as lookup,
        patch("plane.bgtasks.feishu_task.FeishuClient.send_card") as send,
    ):
        deliver_feishu_message.run(str(row.pk))
    lookup.assert_not_called()
    send.assert_not_called()
    row.refresh_from_db()
    assert row.status == "skipped" and row.last_error == reason


@pytest.mark.parametrize(
    "reason,retryable,expected",
    [
        ("network_error", True, "pending"),
        ("provider_unavailable", True, "pending"),
        ("provider_rejected", False, "failed"),
        ("phone_inactive", False, "skipped"),
        ("phone_ambiguous", False, "skipped"),
        ("phone_conflict", False, "skipped"),
        ("phone_not_found", False, "skipped"),
    ],
)
def test_lookup_failures_never_send(integration, create_user, reason, retryable, expected):
    row = queued(integration, create_user)
    with (
        patch(
            "plane.bgtasks.feishu_task.FeishuClient.resolve_mobile",
            side_effect=FeishuError(reason, retryable=retryable),
        ),
        patch("plane.bgtasks.feishu_task.FeishuClient.send_card") as send,
        patch.object(deliver_feishu_message, "apply_async"),
    ):
        deliver_feishu_message.run(str(row.pk))
    send.assert_not_called()
    row.refresh_from_db()
    assert row.status == expected and row.last_error == reason
    assert row.recipient_open_id == ""
    assert MOBILE not in row.last_error


@pytest.mark.parametrize("frozen_open_id", ["", "ou_already_resolved"])
def test_mobile_changed_before_send_skips_without_lookup(integration, create_user, frozen_open_id):
    row = queued(integration, create_user)
    FeishuMessage.objects.filter(pk=row.pk).update(recipient_open_id=frozen_open_id)
    User.objects.filter(pk=create_user.pk).update(mobile_number="+8613912345678")
    with (
        patch("plane.bgtasks.feishu_task.FeishuClient.resolve_mobile") as lookup,
        patch("plane.bgtasks.feishu_task.FeishuClient.send_card") as send,
    ):
        deliver_feishu_message.run(str(row.pk))
    lookup.assert_not_called()
    send.assert_not_called()
    row.refresh_from_db()
    assert row.status == "skipped" and row.last_error == "phone_changed"


def test_mobile_changed_during_lookup_skips_before_card_transport(integration, create_user):
    row = queued(integration, create_user)

    def changed_phone(_mobile):
        User.objects.filter(pk=create_user.pk).update(mobile_number="+8613912345678")
        return "ou_mobile"

    with (
        patch("plane.bgtasks.feishu_task.FeishuClient.resolve_mobile", side_effect=changed_phone),
        patch("plane.bgtasks.feishu_task.FeishuClient.send_card") as send,
    ):
        deliver_feishu_message.run(str(row.pk))
    send.assert_not_called()
    row.refresh_from_db()
    assert row.status == "skipped" and row.last_error == "phone_changed"


def test_transient_send_reuses_frozen_id_and_uuid_without_second_lookup(integration, create_user):
    row = queued(integration, create_user)
    with (
        patch("plane.bgtasks.feishu_task.FeishuClient.resolve_mobile", return_value="ou_mobile") as lookup,
        patch(
            "plane.bgtasks.feishu_task.FeishuClient.send_card",
            side_effect=[FeishuError("network_error", retryable=True), None],
        ) as send,
        patch.object(deliver_feishu_message, "apply_async"),
    ):
        deliver_feishu_message.run(str(row.pk))
        deliver_feishu_message.run(str(row.pk))
    lookup.assert_called_once()
    assert send.call_count == 2
    assert send.call_args_list[0].args == send.call_args_list[1].args
    row.refresh_from_db()
    assert row.status == "sent" and row.attempts == 2


def test_mobile_delivery_requires_active_membership(integration, create_user):
    row = queued(integration, create_user)
    WorkspaceMember.objects.filter(workspace=integration.workspace, member=create_user).update(is_active=False)
    with patch("plane.bgtasks.feishu_task.FeishuClient.resolve_mobile") as lookup:
        deliver_feishu_message.run(str(row.pk))
    lookup.assert_not_called()
    row.refresh_from_db()
    assert row.status == "skipped" and row.last_error == "recipient_inactive"


def test_recipient_candidates_mask_phones_and_exclude_inactive_users(
    session_client, workspace, integration, create_user
):
    inactive_user = User.objects.create(
        email="inactive-mobile@example.com",
        username=f"inactive-{uuid.uuid4()}",
        is_active=False,
        mobile_number="+8613912345678",
    )
    inactive_member = User.objects.create(
        email="inactive-member-mobile@example.com", username=f"inactive-member-{uuid.uuid4()}"
    )
    WorkspaceMember.objects.create(workspace=workspace, member=inactive_user, role=15)
    WorkspaceMember.objects.create(workspace=workspace, member=inactive_member, role=15, is_active=False)
    response = session_client.get(url(workspace, "recipients/"))
    assert response.status_code == 200
    rows = response.json()
    assert rows == [{"user_id": str(create_user.id), "has_mobile": True, "mobile_hint": "+*********5678"}]
    assert MOBILE not in str(rows)


def test_recipient_candidates_report_missing_mobile_without_exposing_invalid_input(
    session_client, workspace, integration, create_user
):
    User.objects.filter(pk=create_user.pk).update(mobile_number="invalid-phone-value")
    rows = session_client.get(url(workspace, "recipients/")).json()
    assert rows == [{"user_id": str(create_user.id), "has_mobile": False, "mobile_hint": ""}]


def test_recipient_candidates_require_workspace_admin(session_client, workspace, integration, create_user):
    WorkspaceMember.objects.filter(workspace=workspace, member=create_user).update(role=15)
    assert session_client.get(url(workspace, "recipients/")).status_code == 403


def test_test_endpoint_queues_existing_user_mobile_and_ignores_supplied_phone(
    session_client, workspace, integration, create_user, django_capture_on_commit_callbacks
):
    with (
        patch("plane.app.views.feishu.dispatch_feishu_message") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        response = session_client.post(
            url(workspace, "test/"),
            {"user_id": str(create_user.id), "mobile": "+8613912345678", "open_id": "ou_untrusted"},
            format="json",
        )
        assert response.status_code == 202
        dispatch.assert_not_called()
    dispatch.assert_called_once()
    row = FeishuMessage.objects.get(pk=response.json()["id"])
    assert row.recipient_mobile == MOBILE and row.recipient_open_id == ""
    assert MOBILE not in str(response.json())


@pytest.mark.parametrize("mobile,reason", [("", "phone_missing"), ("invalid", "phone_invalid")])
def test_test_endpoint_rejects_missing_or_invalid_mobile(
    session_client, workspace, integration, create_user, mobile, reason
):
    User.objects.filter(pk=create_user.pk).update(mobile_number=mobile)
    with patch("plane.app.views.feishu.dispatch_feishu_message") as dispatch:
        response = session_client.post(
            url(workspace, "test/"), {"user_id": str(create_user.id), "open_id": "ou_untrusted"}, format="json"
        )
    dispatch.assert_not_called()
    assert response.status_code == 400 and response.json()["error"] == reason
    assert not FeishuMessage.objects.filter(integration=integration).exists()


def test_test_endpoint_rejects_unknown_or_nonmember_user(session_client, workspace, integration):
    outsider = User.objects.create(
        email="outside-mobile@example.com", username=f"outside-{uuid.uuid4()}", mobile_number=MOBILE
    )
    for user_id in (outsider.pk, uuid.uuid4()):
        response = session_client.post(url(workspace, "test/"), {"user_id": str(user_id)}, format="json")
        assert response.status_code == 400
    assert not FeishuMessage.objects.filter(integration=integration).exists()


def test_delivery_history_never_exposes_phone_snapshot(session_client, workspace, integration, create_user):
    row = queued(integration, create_user)
    FeishuMessage.objects.filter(pk=row.pk).update(status="skipped", last_error="phone_not_found")
    response = session_client.get(url(workspace, "deliveries/"))
    assert response.status_code == 200
    result = response.json()
    assert result[0]["last_error"] == "phone_not_found"
    assert "recipient_mobile" not in result[0]
    assert MOBILE not in str(result)
