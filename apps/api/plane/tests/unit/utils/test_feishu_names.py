# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from unittest.mock import Mock, patch

import pytest
import requests

from plane.utils.feishu import CONTACT_URL, TOKEN_EXPIRED_CODES, TOKEN_URL, FeishuClient, FeishuError

pytestmark = pytest.mark.unit
OPEN_ID = "ou_official"
USER_URL = f"https://open.feishu.cn/open-apis/contact/v3/users/{OPEN_ID}?user_id_type=open_id"
MOBILE = "+8613812345678"
PRIVATE = "private-name private-token private-secret +8613812345678"


def response(body, status=200):
    return Mock(status_code=status, json=Mock(return_value=body))


def user_response(user):
    return response({"code": 0, "data": {"user": user}})


def token_response(token="private-token"):
    return response({"code": 0, "tenant_access_token": token})


@pytest.mark.parametrize(
    "user,expected",
    [
        ({"nickname": " 飞书昵称 ", "name": "Official", "en_name": "English"}, "飞书昵称"),
        ({"name": "Official", "en_name": "English"}, "Official"),
        ({"nickname": " \t", "name": " Official "}, "Official"),
        ({"nickname": None, "name": "", "en_name": " English "}, "English"),
        ({"nickname": {}, "name": 1, "en_name": "English"}, "English"),
        ({"open_id": OPEN_ID, "nickname": "Nickname"}, "Nickname"),
    ],
)
def test_official_name_priority_and_fixed_bounded_transport(user, expected):
    with (
        patch("plane.utils.feishu.requests.post", return_value=token_response()) as post,
        patch("plane.utils.feishu.requests.get", return_value=user_response(user)) as get,
    ):
        assert FeishuClient("app", "private-secret").get_display_name(OPEN_ID) == expected
    post.assert_called_once_with(
        TOKEN_URL,
        timeout=(3.05, 10),
        allow_redirects=False,
        json={"app_id": "app", "app_secret": "private-secret"},
    )
    get.assert_called_once_with(
        USER_URL,
        headers={"Authorization": "Bearer private-token", "Content-Type": "application/json; charset=utf-8"},
        timeout=(3.05, 10),
        allow_redirects=False,
    )


@pytest.mark.parametrize(
    "body",
    [
        {"code": 0},
        {"code": 0, "data": []},
        {"code": 0, "data": {}},
        {"code": 0, "data": {"user": None}},
        {"code": 0, "data": {"user": []}},
        {"code": 0, "data": {"user": {}}},
        {"code": 0, "data": {"user": {"nickname": " ", "name": None, "en_name": 7}}},
        {"code": 0, "data": {"user": {"display_name": PRIVATE, "sso_name": PRIVATE}}},
    ],
)
def test_missing_user_information_has_safe_fixed_reason(body):
    client = FeishuClient("app", "private-secret")
    client._access_token = "private-token"
    with patch("plane.utils.feishu.requests.get", return_value=response(body)):
        with pytest.raises(FeishuError, match="^user_name_unavailable$") as error:
            client.get_display_name(OPEN_ID)
    assert error.value.retryable is False


@pytest.mark.parametrize("returned_id", ["ou_other", "", None, 1, [OPEN_ID]])
def test_mismatched_returned_open_id_is_rejected(returned_id):
    client = FeishuClient("app", "secret")
    client._access_token = "private-token"
    with patch(
        "plane.utils.feishu.requests.get", return_value=user_response({"open_id": returned_id, "nickname": PRIVATE})
    ):
        with pytest.raises(FeishuError, match="^invalid_provider_response$"):
            client.get_display_name(OPEN_ID)


@pytest.mark.parametrize(
    "open_id",
    [
        "",
        None,
        1,
        [],
        "ou_",
        "on_other",
        "ou_../x",
        "ou_test/other",
        "ou_test?x=y",
        "ou_test#fragment",
        "ou_%2f",
        "ou_\\host",
        "https://example.com",
        "ou_x\n",
        "ou_" + "x" * 253,
    ],
)
def test_invalid_open_id_never_reaches_network(open_id):
    with patch("plane.utils.feishu.requests.get") as get, patch("plane.utils.feishu.requests.post") as post:
        with pytest.raises(FeishuError, match="^invalid_provider_response$"):
            FeishuClient("app", "secret").get_display_name(open_id)
    get.assert_not_called()
    post.assert_not_called()


@pytest.mark.parametrize(
    "status,code,reason,retryable",
    [
        (403, 41050, "provider_http_error", False),
        (302, 0, "provider_http_error", False),
        (429, 0, "provider_unavailable", True),
        (500, 0, "provider_unavailable", True),
        (503, 0, "provider_unavailable", True),
        (200, 41050, "provider_rejected", False),
        (200, 99991400, "provider_rejected", True),
    ],
)
def test_provider_errors_are_sanitized(status, code, reason, retryable, caplog):
    client = FeishuClient("app", "private-secret")
    client._access_token = "private-token"
    with patch("plane.utils.feishu.requests.get", return_value=response({"code": code, "msg": PRIVATE}, status)):
        with pytest.raises(FeishuError, match=f"^{reason}$") as error:
            client.get_display_name(OPEN_ID)
    assert error.value.retryable is retryable
    assert caplog.text == ""


@pytest.mark.parametrize("body", [[], {}, {"code": False}, {"code": "0"}])
def test_get_requires_integer_success_code(body):
    client = FeishuClient("app", "secret")
    client._access_token = "private-token"
    with patch("plane.utils.feishu.requests.get", return_value=response(body)):
        with pytest.raises(FeishuError, match="^invalid_provider_response$"):
            client.get_display_name(OPEN_ID)


def test_invalid_json_is_safe():
    client = FeishuClient("app", "secret")
    client._access_token = "private-token"
    with patch(
        "plane.utils.feishu.requests.get",
        return_value=Mock(status_code=200, json=Mock(side_effect=ValueError(PRIVATE))),
    ):
        with pytest.raises(FeishuError, match="^invalid_provider_response$"):
            client.get_display_name(OPEN_ID)


@pytest.mark.parametrize("exception", [requests.Timeout(PRIVATE), requests.ConnectionError(PRIVATE)])
def test_network_failures_are_retryable_and_not_cached(exception):
    client = FeishuClient("app", "secret")
    client._access_token = "private-token"
    with patch(
        "plane.utils.feishu.requests.get", side_effect=[exception, user_response({"nickname": "Recovered"})]
    ) as get:
        with pytest.raises(FeishuError, match="^network_error$") as error:
            client.get_display_name(OPEN_ID)
        assert error.value.retryable is True
        assert client.get_display_name(OPEN_ID) == "Recovered"
    assert get.call_count == 2


@pytest.mark.parametrize("status,code", [(401, 0)] + [(200, code) for code in sorted(TOKEN_EXPIRED_CODES)])
def test_expired_token_refreshes_once_and_reuses_refreshed_token(status, code):
    client = FeishuClient("app", "secret")
    client._access_token = "old-token"
    with (
        patch("plane.utils.feishu.requests.post", return_value=token_response("refreshed-token")) as post,
        patch(
            "plane.utils.feishu.requests.get",
            side_effect=[response({"code": code}, status), user_response({"nickname": "Name"})],
        ) as get,
    ):
        assert client.get_display_name(OPEN_ID) == "Name"
    assert post.call_count == 1
    assert [call.kwargs["headers"]["Authorization"] for call in get.call_args_list] == [
        "Bearer old-token",
        "Bearer refreshed-token",
    ]
    assert client._access_token == "refreshed-token"


@pytest.mark.parametrize("status,code", [(401, 0), (200, 99991663)])
def test_repeated_expiration_does_not_loop(status, code):
    client = FeishuClient("app", "secret")
    with (
        patch("plane.utils.feishu.requests.post", return_value=token_response()) as post,
        patch("plane.utils.feishu.requests.get", return_value=response({"code": code}, status)) as get,
    ):
        with pytest.raises(FeishuError) as error:
            client.get_display_name(OPEN_ID)
    assert error.value.token_expired is True
    assert post.call_count == 2
    assert get.call_count == 2


def test_successful_name_cache_is_keyed_by_open_id_and_client_instance():
    client = FeishuClient("app", "secret")
    with (
        patch("plane.utils.feishu.requests.post", return_value=token_response()) as post,
        patch(
            "plane.utils.feishu.requests.get",
            side_effect=[
                user_response({"nickname": "First"}),
                user_response({"nickname": "Second"}),
                user_response({"nickname": "Fresh"}),
            ],
        ) as get,
    ):
        assert client.get_display_name(OPEN_ID) == "First"
        assert client.get_display_name(OPEN_ID) == "First"
        assert client.get_display_name("ou_other") == "Second"
        assert FeishuClient("app", "secret").get_display_name(OPEN_ID) == "Fresh"
    assert get.call_count == 3
    assert post.call_count == 2


def test_unavailable_name_is_not_cached():
    client = FeishuClient("app", "secret")
    client._access_token = "private-token"
    with patch(
        "plane.utils.feishu.requests.get", side_effect=[user_response({}), user_response({"name": "Available"})]
    ) as get:
        with pytest.raises(FeishuError, match="^user_name_unavailable$"):
            client.get_display_name(OPEN_ID)
        assert client.get_display_name(OPEN_ID) == "Available"
    assert get.call_count == 2


def test_mobile_cache_only_contains_validated_success_and_reuses_token_for_name():
    client = FeishuClient("app", "secret")
    with (
        patch(
            "plane.utils.feishu.requests.post",
            side_effect=[
                token_response(),
                response({"code": 0, "data": {"user_list": [{"user_id": OPEN_ID, "status": {"is_activated": False}}]}}),
                response({"code": 0, "data": {"user_list": [{"user_id": OPEN_ID, "status": {"is_activated": True}}]}}),
            ],
        ) as post,
        patch("plane.utils.feishu.requests.get", return_value=user_response({"nickname": "Official"})),
    ):
        with pytest.raises(FeishuError, match="^phone_inactive$"):
            client.resolve_mobile(MOBILE)
        assert client.resolve_mobile(MOBILE) == OPEN_ID
        assert client.resolve_mobile(MOBILE) == OPEN_ID
        assert client.get_display_name(OPEN_ID) == "Official"
        with pytest.raises(FeishuError, match="^phone_invalid$"):
            client.resolve_mobile("13812345678")
        with pytest.raises(FeishuError, match="^phone_missing$"):
            client.resolve_mobile("")
    assert [call.args[0] for call in post.call_args_list] == [TOKEN_URL, CONTACT_URL, CONTACT_URL]
