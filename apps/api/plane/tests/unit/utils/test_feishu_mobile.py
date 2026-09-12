# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import uuid
from unittest.mock import Mock, patch

import pytest
import requests

from plane.utils.feishu import CONTACT_URL, MESSAGE_URL, TOKEN_URL, FeishuClient, FeishuError

pytestmark = pytest.mark.unit
MOBILE = "+8613812345678"


def response(body, status=200):
    return Mock(status_code=status, json=Mock(return_value=body))


def lookup_response(users):
    return response({"code": 0, "data": {"user_list": users}})


def token_response():
    return response({"code": 0, "tenant_access_token": "private-test-token"})


@pytest.mark.parametrize(
    "user",
    [
        {"user_id": "ou_mobile"},
        {"user_id": "ou_mobile", "mobile": MOBILE},
        {"user_id": "ou_mobile", "mobile": "13812345678"},
        {
            "user_id": "ou_mobile",
            "mobile": MOBILE,
            "status": {"is_frozen": False, "is_resigned": False, "is_activated": True},
        },
    ],
)
def test_lookup_validates_identity_and_uses_fixed_bounded_transport(user):
    with patch("plane.utils.feishu.requests.post", side_effect=[token_response(), lookup_response([user])]) as post:
        assert FeishuClient("app", "private-secret").resolve_mobile(MOBILE) == "ou_mobile"
    assert [call.args[0] for call in post.call_args_list] == [TOKEN_URL, CONTACT_URL]
    assert post.call_args.kwargs["json"] == {"mobiles": [MOBILE], "include_resigned": False}
    for call in post.call_args_list:
        assert call.kwargs["allow_redirects"] is False
        assert call.kwargs["timeout"] == (3.05, 10)


@pytest.mark.parametrize(
    "users,reason",
    [
        ([], "phone_not_found"),
        ([{"mobile": MOBILE}], "phone_not_found"),
        ([{"user_id": "ou_other", "mobile": "+8613912345678"}], "phone_conflict"),
        ([{"user_id": "ou_first", "mobile": MOBILE}, {"user_id": "ou_second", "mobile": MOBILE}], "phone_ambiguous"),
        ([{"user_id": "on_wrong_identifier", "mobile": MOBILE}], "invalid_provider_response"),
        ([{"user_id": 123, "mobile": MOBILE}], "invalid_provider_response"),
        ([{"user_id": "ou_mobile", "status": "unknown"}], "invalid_provider_response"),
        ([{"user_id": "ou_mobile", "status": {"is_frozen": "false"}}], "invalid_provider_response"),
        (["invalid"], "invalid_provider_response"),
    ],
)
def test_lookup_rejects_missing_ambiguous_mismatched_or_invalid_contacts(users, reason):
    with patch("plane.utils.feishu.requests.post", side_effect=[token_response(), lookup_response(users)]):
        with pytest.raises(FeishuError, match=f"^{reason}$") as error:
            FeishuClient("app", "private-secret").resolve_mobile(MOBILE)
    assert MOBILE not in str(error.value)
    assert "private-secret" not in str(error.value)


@pytest.mark.parametrize(
    "flag,value",
    [
        ("is_frozen", True),
        ("is_resigned", True),
        ("is_exited", True),
        ("is_unjoin", True),
        ("is_activated", False),
    ],
)
def test_lookup_rejects_inactive_contact_status(flag, value):
    with patch(
        "plane.utils.feishu.requests.post",
        side_effect=[
            token_response(),
            lookup_response([{"user_id": "ou_mobile", "status": {flag: value}}]),
        ],
    ):
        with pytest.raises(FeishuError, match="^phone_inactive$"):
            FeishuClient("app", "private-secret").resolve_mobile(MOBILE)


@pytest.mark.parametrize(
    "mobile,reason", [("", "phone_missing"), ("13812345678", "phone_invalid"), ("invalid", "phone_invalid")]
)
def test_lookup_requires_normalized_snapshot_without_network(mobile, reason):
    with patch("plane.utils.feishu.requests.post") as post:
        with pytest.raises(FeishuError, match=f"^{reason}$"):
            FeishuClient("app", "secret").resolve_mobile(mobile)
    post.assert_not_called()


def test_lookup_network_errors_do_not_expose_phone_or_token():
    with patch(
        "plane.utils.feishu.requests.post",
        side_effect=[token_response(), requests.Timeout(MOBILE + " private-test-token")],
    ):
        with pytest.raises(FeishuError, match="^network_error$") as error:
            FeishuClient("app", "secret").resolve_mobile(MOBILE)
    assert error.value.retryable is True


def test_lookup_refreshes_expired_token_and_reuses_it_for_card():
    client = FeishuClient("app", "secret")
    with patch(
        "plane.utils.feishu.requests.post",
        side_effect=[
            token_response(),
            response({"code": 99991663}),
            token_response(),
            lookup_response([{"user_id": "ou_mobile"}]),
            response({"code": 0}),
        ],
    ) as post:
        open_id = client.resolve_mobile(MOBILE)
        client.send_card(open_id, {"elements": []}, uuid.uuid4())
    assert [call.args[0] for call in post.call_args_list] == [
        TOKEN_URL,
        CONTACT_URL,
        TOKEN_URL,
        CONTACT_URL,
        MESSAGE_URL,
    ]


def test_lookup_matches_returned_mobile_before_selecting_unique_id():
    with patch(
        "plane.utils.feishu.requests.post",
        side_effect=[
            token_response(),
            lookup_response(
                [
                    {"mobile": "+8613912345678", "user_id": "ou_other"},
                    {"mobile": MOBILE, "user_id": "ou_mobile"},
                ]
            ),
        ],
    ):
        assert FeishuClient("app", "secret").resolve_mobile(MOBILE) == "ou_mobile"


def test_provider_failure_does_not_become_not_found():
    with patch(
        "plane.utils.feishu.requests.post", side_effect=[token_response(), response({"code": 100, "msg": MOBILE})]
    ):
        with pytest.raises(FeishuError, match="^provider_rejected$"):
            FeishuClient("app", "secret").resolve_mobile(MOBILE)


def test_transport_refuses_arbitrary_lookup_hosts():
    with patch("plane.utils.feishu.requests.post") as post:
        with pytest.raises(FeishuError):
            FeishuClient("app", "secret")._post("https://example.com/contact")
    post.assert_not_called()
