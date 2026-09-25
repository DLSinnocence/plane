# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from types import SimpleNamespace

import pytest
from rest_framework.exceptions import ValidationError

from plane.utils.issue_workflow import validate_testing_state

pytestmark = pytest.mark.unit


@pytest.mark.parametrize("needs_testing", [True, False])
@pytest.mark.parametrize("is_testing", [True, False])
def test_testing_state_rule_uses_effective_flag_and_marker(needs_testing, is_testing):
    issue = SimpleNamespace(needs_testing=needs_testing, state=SimpleNamespace(is_testing=is_testing))
    if is_testing and not needs_testing:
        with pytest.raises(ValidationError):
            validate_testing_state({}, issue)
    else:
        validate_testing_state({}, issue)


def test_disabling_testing_requires_leaving_current_testing_state():
    issue = SimpleNamespace(needs_testing=True, state=SimpleNamespace(is_testing=True))
    with pytest.raises(ValidationError):
        validate_testing_state({"needs_testing": False}, issue)
    validate_testing_state({"needs_testing": False, "state": SimpleNamespace(is_testing=False)}, issue)


def test_enabling_testing_allows_entering_testing_state_in_same_request():
    issue = SimpleNamespace(needs_testing=False, state=SimpleNamespace(is_testing=False))
    validate_testing_state({"needs_testing": True, "state": SimpleNamespace(is_testing=True)}, issue)


def test_new_issues_do_not_require_testing_by_default():
    with pytest.raises(ValidationError):
        validate_testing_state({"state": SimpleNamespace(is_testing=True)})
    validate_testing_state({"state": SimpleNamespace(is_testing=False)})


def test_new_issues_can_explicitly_enable_testing():
    validate_testing_state({"needs_testing": True, "state": SimpleNamespace(is_testing=True)})
