import json
import uuid
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
import requests
from django.test import override_settings
from rest_framework.exceptions import PermissionDenied

from plane.app.views.feishu import ConfigInput, FeishuAdminAPIView, config_data
from plane.bgtasks.feishu_task import dispatch_feishu_message, recipient_error, safe_error
from plane.utils.feishu import (
    FeishuClient,
    FeishuError,
    MESSAGE_URL,
    TOKEN_URL,
    configured_app_url,
    decrypt_secret,
    encrypt_secret,
)

pytestmark = pytest.mark.unit


def response(data, status=200):
    return Mock(status_code=status, json=Mock(return_value=data))


@override_settings(SECRET_KEY="feishu-test-only-key")
def test_secret_roundtrip_ciphertext_and_write_only():
    secret = "a-private-secret"
    encrypted = encrypt_secret(secret)
    assert secret not in encrypted
    assert decrypt_secret(encrypted) == secret
    serializer = ConfigInput(instance={"app_id": "app", "app_secret": secret, "enabled": True})
    assert "app_secret" not in serializer.data
    output = config_data(SimpleNamespace(id=uuid.uuid4(), app_id="app", app_secret=encrypted, enabled=True))
    assert output["has_app_secret"] is True
    assert "app_secret" not in output


@pytest.mark.parametrize("value", ["", "plaintext", "gAAAA-invalid"])
def test_decryption_fails_closed(value):
    with pytest.raises(FeishuError, match="^secret_decryption_failed$"):
        decrypt_secret(value)


def test_encryption_failure_sanitized():
    with patch("plane.utils.feishu.derive_key", side_effect=ValueError("secret-value")):
        with pytest.raises(FeishuError, match="^secret_encryption_failed$"):
            encrypt_secret("secret-value")


def test_transport_uses_fixed_urls_bounds_and_stable_uuid():
    message_id = uuid.uuid4()
    card = {"elements": [{"tag": "div", "text": {"tag": "plain_text", "content": "更新"}}]}
    with patch(
        "plane.utils.feishu.requests.post",
        side_effect=[
            response({"code": 0, "tenant_access_token": "token"}),
            response({"code": 0}),
        ],
    ) as post:
        FeishuClient("app", "secret").send_card("ou_test", card, message_id)
    assert [call.args[0] for call in post.call_args_list] == [TOKEN_URL, MESSAGE_URL]
    for call in post.call_args_list:
        assert call.kwargs["allow_redirects"] is False
        assert call.kwargs["timeout"] == (3.05, 10)
    payload = post.call_args_list[1].kwargs["json"]
    assert payload["uuid"] == str(message_id)
    assert payload["msg_type"] == "interactive"
    assert payload["receive_id"] == "ou_test"
    assert json.loads(payload["content"]) == card


@pytest.mark.parametrize("status,retryable", [(302, False), (400, False), (429, True), (500, True), (503, True)])
def test_http_failures_sanitized(status, retryable):
    with patch("plane.utils.feishu.requests.post", return_value=response({"secret": "do-not-log"}, status)):
        with pytest.raises(FeishuError) as error:
            FeishuClient("app", "secret")._token()
    assert error.value.retryable is retryable
    assert "do-not-log" not in str(error.value)


@pytest.mark.parametrize("body", [{"code": 123, "msg": "private detail"}, {}, [], {"code": "0"}, {"code": False}])
def test_provider_code_and_response_validation(body):
    with patch("plane.utils.feishu.requests.post", return_value=response(body)):
        with pytest.raises(FeishuError) as error:
            FeishuClient("app", "secret")._token()
    assert "private detail" not in str(error.value)


def test_network_failure_retryable_without_exception_text():
    with patch("plane.utils.feishu.requests.post", side_effect=requests.Timeout("token-secret")):
        with pytest.raises(FeishuError, match="^network_error$") as error:
            FeishuClient("app", "secret")._token()
    assert error.value.retryable


def test_expired_token_refresh_is_bounded_and_uuid_unchanged():
    with patch(
        "plane.utils.feishu.requests.post",
        side_effect=[
            response({"code": 0, "tenant_access_token": "first"}),
            response({"code": 99991663}),
            response({"code": 0, "tenant_access_token": "second"}),
            response({"code": 99991663}),
        ],
    ) as post:
        with pytest.raises(FeishuError):
            FeishuClient("app", "secret").send_card("ou_test", {}, uuid.uuid4())
    assert post.call_count == 4
    assert post.call_args_list[1].kwargs["json"]["uuid"] == post.call_args_list[3].kwargs["json"]["uuid"]


def test_enqueue_failure_is_recorded_without_broker_detail():
    with (
        patch("plane.bgtasks.feishu_task.deliver_feishu_message.delay", side_effect=RuntimeError("redis://secret")),
        patch("plane.bgtasks.feishu_task.FeishuMessage.objects.filter") as query,
    ):
        assert dispatch_feishu_message(uuid.uuid4()) is False
    assert query.return_value.update.call_args.kwargs["last_error"] == "enqueue_failed"


@pytest.mark.parametrize("active,allowed", [(False, True), (True, False)])
def test_workspace_admin_requires_active_user_and_admin_membership(active, allowed):
    request = SimpleNamespace(user=SimpleNamespace(is_active=active))
    with (
        patch("plane.app.views.feishu.get_object_or_404", return_value=Mock()),
        patch("plane.app.views.feishu.WorkspaceMember.objects.filter") as query,
    ):
        query.return_value.exists.return_value = allowed
        with pytest.raises(PermissionDenied):
            FeishuAdminAPIView().workspace(request, "space")
        if active:
            assert query.call_args.kwargs["role"] == 20
            assert query.call_args.kwargs["is_active"] is True


def recipient_fixture():
    integration = SimpleNamespace(
        enabled=True,
        deleted_at=None,
        workspace=SimpleNamespace(deleted_at=None),
        workspace_id=uuid.uuid4(),
        app_id="app",
    )
    message = SimpleNamespace(
        app_id="app",
        receiver_id=uuid.uuid4(),
        recipient_open_id="ou_test",
        recipient_mobile="+8613812345678",
        issue_id=None,
        event_key="test:event",
    )
    return message, integration


@pytest.mark.parametrize("change,expected", [("disabled", "integration_disabled"), ("app", "app_changed")])
def test_invalid_integration_rejected_before_recipient_lookup(change, expected):
    message, integration = recipient_fixture()
    if change == "disabled":
        integration.enabled = False
    else:
        integration.app_id = "new-app"
    assert recipient_error(message, integration) == expected


@pytest.mark.parametrize("mobile,reason", [("", "phone_missing"), ("invalid", "phone_invalid")])
def test_mobile_snapshot_required_even_with_frozen_open_id(mobile, reason):
    message, integration = recipient_fixture()
    message.recipient_mobile = mobile
    assert recipient_error(message, integration) == reason


def test_changed_phone_skips_recipient():
    message, integration = recipient_fixture()
    with patch("plane.bgtasks.feishu_task.User.objects.filter") as users:
        users.return_value.values_list.return_value.first.return_value = "+8613912345678"
        assert recipient_error(message, integration) == "phone_changed"


def test_inactive_workspace_recipient_skipped():
    message, integration = recipient_fixture()
    with (
        patch("plane.bgtasks.feishu_task.User.objects.filter") as users,
        patch("plane.bgtasks.feishu_task.WorkspaceMember.objects.filter") as members,
    ):
        users.return_value.values_list.return_value.first.return_value = message.recipient_mobile
        members.return_value.exists.return_value = False
        assert recipient_error(message, integration) == "recipient_inactive"
        assert members.call_args.kwargs["is_active"] is True
        assert members.call_args.kwargs["member__is_active"] is True


def test_inactive_project_member_skipped():
    message, integration = recipient_fixture()
    message.issue_id = uuid.uuid4()
    with (
        patch("plane.bgtasks.feishu_task.User.objects.filter") as users,
        patch("plane.bgtasks.feishu_task.WorkspaceMember.objects.filter") as members,
        patch("plane.bgtasks.feishu_task.Issue.objects.filter") as issues,
        patch("plane.bgtasks.feishu_task.ProjectMember.objects.filter") as projects,
    ):
        users.return_value.values_list.return_value.first.return_value = message.recipient_mobile
        members.return_value.exists.return_value = True
        issues.return_value.first.return_value = SimpleNamespace(
            project=SimpleNamespace(deleted_at=None), project_id=uuid.uuid4()
        )
        projects.return_value.exists.return_value = False
        assert recipient_error(message, integration) == "project_membership_inactive"
        assert projects.call_args.kwargs["is_active"] is True
        assert projects.call_args.kwargs["role__gte"] == 15


def test_delivery_error_allowlist():
    assert safe_error("token=secret provider body") == "delivery_failed"
    assert safe_error("network_error") == "network_error"
    assert safe_error("phone_missing") == "phone_missing"
    assert safe_error("phone_changed") == "phone_changed"


@pytest.mark.parametrize(
    "value",
    [
        "",
        "javascript:alert(1)",
        "https://user:pass@example.com",
        "https://example.com/?x=1",
        "https://example.com/#x",
        "https://example.com:99999",
        "https://exa mple.com",
        "https://example.com/\n",
    ],
)
def test_invalid_application_url_rejected(settings, value):
    settings.APP_BASE_URL = value
    settings.WEB_URL = ""
    with pytest.raises(FeishuError, match="^invalid_application_url$"):
        configured_app_url()


def test_application_url_prefers_server_app_base_and_falls_back(settings):
    settings.APP_BASE_URL = "https://plane.example.com/base/"
    settings.WEB_URL = "https://fallback.example.com"
    assert configured_app_url() == "https://plane.example.com/base"
    settings.APP_BASE_URL = ""
    assert configured_app_url() == "https://fallback.example.com"
