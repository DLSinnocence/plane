# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Conservative phone formatting shared by SSO and notification recipients."""

import re


def normalize_phone_number(value, country_code=None):
    """Return E.164-shaped text or an empty string, without guessing a country.

    Unprefixed mainland Chinese mobile numbers default to +86. Casdoor's
    86/+86/CN country hints are supported; other countries require an explicit
    + or 00 international prefix. This validates syntax, not phone ownership
    or whether an international number is allocated.
    """
    if not isinstance(value, str) or not re.fullmatch(r"[0-9+\s()\-]*", value):
        return ""
    number = re.sub(r"[\s()\-]", "", value)
    if number.startswith("00"):
        number = "+" + number[2:]
    if number.startswith("+"):
        return number if re.fullmatch(r"\+[1-9][0-9]{7,14}", number) else ""
    if country_code is not None and country_code != "":
        if isinstance(country_code, bool) or not isinstance(country_code, (str, int)):
            return ""
        if str(country_code).strip().upper() not in {"86", "+86", "CN"}:
            return ""
    return "+86" + number if re.fullmatch(r"1[3-9][0-9]{9}", number) else ""
