# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from plane.authentication.provider.oauth.meowalive import MeowAliveOAuthProvider
from plane.utils.phone import normalize_phone_number

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    "value,country,expected",
    [
        ("13800138000", None, "+8613800138000"),
        ("138 0013-8000", "CN", "+8613800138000"),
        ("13800138000", "86", "+8613800138000"),
        ("13800138000", 86, "+8613800138000"),
        ("13800138000", "+86", "+8613800138000"),
        ("+1 (415) 555-2671", None, "+14155552671"),
        ("0044 20 7946 0958", None, "+442079460958"),
        ("+442079460958", "GB", "+442079460958"),
        ("+12345678", None, "+12345678"),
        ("+123456789012345", None, "+123456789012345"),
        ("+1234567890123456", None, ""),
        ("+1234567", None, ""),
        ("+012345678", None, ""),
        ("13800138000", "US", ""),
        ("13800138000", True, ""),
        ("13800138000", {}, ""),
        ("4155552671", None, ""),
        ("12800138000", "CN", ""),
        ("13800138000 ext 1", None, ""),
        ("13800138000#1", None, ""),
        ("13800138000.1", None, ""),
        ("tel:+8613800138000", None, ""),
        ("+86+13800138000", None, ""),
        ("１３８００１３８０００", None, ""),
        (13800138000, None, ""),
        (None, None, ""),
        ({}, None, ""),
        ("", None, ""),
    ],
)
def test_normalize_phone_number(value, country, expected):
    assert normalize_phone_number(value, country) == expected


@pytest.mark.parametrize(
    "profile,expected",
    [
        ({"phone_number": "+1 (415) 555-2671"}, "+14155552671"),
        ({"phone": "13800138000", "phoneCountryCode": "CN"}, "+8613800138000"),
        ({"phone_number": "13800138000", "phone_number_verified": True}, "+8613800138000"),
        ({"phone": "13800138000", "phoneVerified": True}, "+8613800138000"),
        ({"phone_number": "13800138000", "phone_number_verified": False}, ""),
        ({"phone": "13800138000", "phoneVerified": False}, ""),
        ({"phone": "13800138000", "phoneVerified": "false"}, ""),
        ({"phone_number": "13800138000", "phoneVerified": False}, ""),
        ({"phone_number": "", "phone": "13800138000"}, ""),
        ({"phone_number": None, "phone": "13800138000"}, ""),
        ({"phone_number": "malformed"}, ""),
        ({}, ""),
    ],
)
@pytest.mark.parametrize("existing_mobile", ["", "+8613900139000"])
def test_mobile_is_persisted_on_each_login_without_profile_sync(rf, profile, expected, existing_mobile):
    provider = MeowAliveOAuthProvider.__new__(MeowAliveOAuthProvider)
    provider.profile = profile
    provider.request = rf.get("/")
    provider.check_sync_enabled = MagicMock(return_value=False)
    user = SimpleNamespace(is_active=True, mobile_number=existing_mobile)
    persisted = []
    user.save = lambda: persisted.append(user.mobile_number)

    assert provider.save_user_data(user) is user
    assert persisted == [expected]
    provider.check_sync_enabled.assert_not_called()

    provider.profile = {}
    provider.save_user_data(user)
    assert persisted == [expected, ""]
