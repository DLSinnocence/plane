import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from celery.exceptions import Retry
from django.db import IntegrityError, transaction
from django.utils import timezone

from plane.bgtasks.feishu_task import deliver_feishu_message, recover_feishu_messages
from plane.db.models import (
    FeishuIntegration,
    FeishuMessage,
    Issue,
    Project,
    ProjectMember,
    State,
    User,
    WorkspaceMember,
)
from plane.utils.feishu import FeishuError, decrypt_secret, encrypt_secret

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def url(workspace, suffix=""):
    return f"/api/workspaces/{workspace.slug}/integrations/feishu/{suffix}"


@pytest.fixture(autouse=True)
def application_url(settings):
    settings.APP_BASE_URL = "https://plane.example.com"
    settings.WEB_URL = ""
    with (
        patch("plane.bgtasks.feishu_task.FeishuClient.resolve_mobile", return_value="ou_one"),
        patch("plane.utils.feishu.requests.post", side_effect=AssertionError("Unmocked transport")),
    ):
        yield


@pytest.fixture
def configured(workspace, create_user):
    integration = FeishuIntegration.objects.create(
        workspace=workspace, app_id="app-one", app_secret=encrypt_secret("private-secret"), enabled=True
    )
    User.objects.filter(pk=create_user.pk).update(mobile_number="+8613812345678")
    return integration


def message(integration, receiver):
    return FeishuMessage.objects.create(
        integration=integration,
        receiver=receiver,
        event_key=f"test:{uuid.uuid4()}",
        app_id=integration.app_id,
        recipient_open_id="",
        recipient_mobile="+8613812345678",
        card={"elements": []},
    )


@pytest.mark.parametrize(
    "method,suffix", [("get", ""), ("patch", ""), ("get", "recipients/"), ("get", "deliveries/"), ("post", "test/")]
)
def test_member_cannot_manage_integration(session_client, workspace, create_user, method, suffix):
    WorkspaceMember.objects.filter(workspace=workspace, member=create_user).update(role=15)
    response = getattr(session_client, method)(url(workspace, suffix), {}, format="json")
    assert response.status_code == 403


def test_inactive_admin_denied(session_client, workspace, create_user):
    WorkspaceMember.objects.filter(workspace=workspace, member=create_user).update(is_active=False)
    assert session_client.get(url(workspace)).status_code == 403


def test_config_secret_encrypted_hidden_and_blank_preserved(session_client, workspace):
    payload = {"app_id": "app-one", "app_secret": "private-secret", "enabled": True}
    response = session_client.patch(url(workspace), payload, format="json")
    assert response.status_code == 200
    assert set(response.json()) == {"id", "app_id", "enabled", "has_app_secret"}
    integration = FeishuIntegration.objects.get(workspace=workspace)
    assert integration.app_secret != "private-secret"
    assert decrypt_secret(integration.app_secret) == "private-secret"
    before = integration.app_secret
    for update in ({"app_secret": ""}, {"enabled": False}):
        assert session_client.patch(url(workspace), update, format="json").status_code == 200
        integration.refresh_from_db()
        assert integration.app_secret == before
    assert "private-secret" not in str(session_client.get(url(workspace)).json())


def test_enable_requires_credentials_and_encryption_failure_rolls_back(session_client, workspace):
    assert session_client.patch(url(workspace), {"enabled": True}, format="json").status_code == 400
    with patch("plane.app.views.feishu.encrypt_secret", side_effect=FeishuError("secret_encryption_failed")):
        response = session_client.patch(url(workspace), {"app_id": "a", "app_secret": "s"}, format="json")
    assert response.status_code == 400
    assert not FeishuIntegration.objects.filter(workspace=workspace).exists()


def test_app_change_requires_replacement_secret(session_client, workspace, configured):
    for update in ({"app_id": "app-two"}, {"app_id": "app-two", "app_secret": ""}):
        assert session_client.patch(url(workspace), update, format="json").status_code == 400
        configured.refresh_from_db()
        assert configured.app_id == "app-one"
        assert decrypt_secret(configured.app_secret) == "private-secret"
    assert (
        session_client.patch(
            url(workspace), {"app_id": "app-two", "app_secret": "new-secret"}, format="json"
        ).status_code
        == 200
    )
    configured.refresh_from_db()
    assert configured.app_id == "app-two"
    assert decrypt_secret(configured.app_secret) == "new-secret"


@pytest.mark.parametrize(
    "method,suffix",
    [("get", "members/"), ("post", "members/"), ("delete", "members/00000000-0000-0000-0000-000000000001/")],
)
def test_removed_manual_member_endpoints_return_404(session_client, workspace, method, suffix):
    assert getattr(session_client, method)(url(workspace, suffix), {}, format="json").status_code == 404


def test_test_endpoint_queues_after_commit(
    session_client, workspace, configured, create_user, django_capture_on_commit_callbacks
):
    with (
        patch("plane.app.views.feishu.dispatch_feishu_message") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        response = session_client.post(url(workspace, "test/"), {"user_id": str(create_user.id)}, format="json")
        assert response.status_code == 202
        dispatch.assert_not_called()
    dispatch.assert_called_once()
    test_message = FeishuMessage.objects.get(pk=response.json()["id"])
    assert test_message.event_key.startswith("test:")
    assert test_message.card["elements"][1]["actions"][0]["url"] == "https://plane.example.com"


def test_enable_rejects_invalid_application_url(session_client, workspace, settings):
    settings.APP_BASE_URL = "javascript:alert(1)"
    response = session_client.patch(url(workspace), {"app_id": "a", "app_secret": "s", "enabled": True}, format="json")
    assert response.status_code == 400
    assert not FeishuIntegration.objects.filter(workspace=workspace).exists()


def test_recovery_only_queues_stale_nonterminal_deliveries(configured, create_user):
    pending, expired, sent, skipped = [message(configured, create_user) for _ in range(4)]
    stale = timezone.now() - timedelta(minutes=5)
    FeishuMessage.objects.filter(pk=pending.pk).update(updated_at=stale)
    FeishuMessage.objects.filter(pk=expired.pk).update(status="sending", lease_expires_at=stale)
    FeishuMessage.objects.filter(pk=sent.pk).update(status="sent", updated_at=stale)
    FeishuMessage.objects.filter(pk=skipped.pk).update(status="skipped", updated_at=stale)
    with patch("plane.bgtasks.feishu_task.dispatch_feishu_message") as dispatch:
        recover_feishu_messages.run()
    assert {call.args[0] for call in dispatch.call_args_list} == {pending.id, expired.id}


def test_deliveries_capped_and_sanitized(session_client, workspace, configured, create_user):
    for _ in range(51):
        row = message(configured, create_user)
        FeishuMessage.objects.filter(pk=row.pk).update(last_error="private-provider-response")
    result = session_client.get(url(workspace, "deliveries/")).json()
    assert len(result) == 50
    assert all(row["last_error"] == "delivery_failed" for row in result)
    assert set(result[0]) == {
        "id",
        "issue_id",
        "receiver_id",
        "status",
        "attempts",
        "last_error",
        "created_at",
        "sent_at",
    }


def test_success_never_resends_and_outbox_deduplicates(configured, create_user):
    row = message(configured, create_user)
    with patch("plane.bgtasks.feishu_task.FeishuClient.send_card") as send:
        deliver_feishu_message.run(str(row.id))
        deliver_feishu_message.run(str(row.id))
    send.assert_called_once()
    row.refresh_from_db()
    assert row.status == "sent" and row.attempts == 1 and row.sent_at
    with pytest.raises(IntegrityError), transaction.atomic():
        FeishuMessage.objects.create(integration=configured, receiver=create_user, event_key=row.event_key)


def test_live_lease_does_not_send_and_expired_lease_reclaims(configured, create_user):
    row = message(configured, create_user)
    FeishuMessage.objects.filter(pk=row.pk).update(
        status="sending", lease_expires_at=timezone.now() + timedelta(minutes=1)
    )
    with (
        patch("plane.bgtasks.feishu_task.FeishuClient.send_card") as send,
        patch.object(deliver_feishu_message, "retry", side_effect=Retry()),
    ):
        with pytest.raises(Retry):
            deliver_feishu_message.run(str(row.id))
        send.assert_not_called()
    FeishuMessage.objects.filter(pk=row.pk).update(lease_expires_at=timezone.now() - timedelta(seconds=1))
    with patch("plane.bgtasks.feishu_task.FeishuClient.send_card") as send:
        deliver_feishu_message.run(str(row.id))
    send.assert_called_once()


def test_transient_retry_does_not_resend_successful_recipient(configured, create_user):
    first, second = message(configured, create_user), message(configured, create_user)
    with (
        patch(
            "plane.bgtasks.feishu_task.FeishuClient.send_card",
            side_effect=[None, FeishuError("network_error", retryable=True)],
        ) as send,
        patch.object(deliver_feishu_message, "apply_async") as enqueue,
    ):
        deliver_feishu_message.run(str(first.id))
        deliver_feishu_message.run(str(second.id))
        deliver_feishu_message.run(str(first.id))
    assert send.call_count == 2
    enqueue.assert_called_once()
    first.refresh_from_db()
    second.refresh_from_db()
    assert first.status == "sent" and second.status == "pending"


@pytest.mark.parametrize("current_role", [5, 15, 20])
def test_sender_rechecks_project_role_after_queue(configured, create_user, current_role):
    with patch("celery.app.task.Task.apply_async"):
        project = Project.objects.create(workspace=configured.workspace, name="Feishu role test", identifier="FROLE")
        membership = ProjectMember.objects.create(project=project, member=create_user, role=20)
        state = State.objects.create(project=project, name="Started", group="started", default=True)
        issue = Issue.objects.create(project=project, state=state, name="Private activity")
        row = message(configured, create_user)
        FeishuMessage.objects.filter(pk=row.pk).update(issue=issue, event_key=f"{uuid.uuid4()}:{issue.id}")
        ProjectMember.objects.filter(pk=membership.pk).update(role=current_role)
        with patch("plane.bgtasks.feishu_task.FeishuClient.send_card") as send:
            deliver_feishu_message.run(str(row.id))
    row.refresh_from_db()
    if current_role == 5:
        send.assert_not_called()
        assert row.status == "skipped"
        assert row.last_error == "project_membership_inactive"
    else:
        send.assert_called_once()
        assert row.status == "sent"


@pytest.mark.parametrize(
    "change,reason",
    [
        ("disable", "integration_disabled"),
        ("app", "app_changed"),
        ("phone", "phone_changed"),
        ("member", "recipient_inactive"),
    ],
)
def test_sender_revalidates_before_transport(configured, create_user, change, reason):
    row = message(configured, create_user)
    if change == "disable":
        FeishuIntegration.objects.filter(pk=configured.pk).update(enabled=False)
    elif change == "app":
        FeishuIntegration.objects.filter(pk=configured.pk).update(app_id="other")
    elif change == "phone":
        User.objects.filter(pk=create_user.pk).update(mobile_number="+8613912345678")
    else:
        WorkspaceMember.objects.filter(workspace=configured.workspace, member=create_user).update(is_active=False)
    with patch("plane.bgtasks.feishu_task.FeishuClient.send_card") as send:
        deliver_feishu_message.run(str(row.id))
    send.assert_not_called()
    row.refresh_from_db()
    assert row.status == "skipped" and row.last_error == reason
