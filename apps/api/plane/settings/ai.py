# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""Internal endpoint configuration for the embedded AI agent."""

from urllib.parse import urlsplit, urlunsplit


def resolve_ai_agent_url(override=None, live_url=None):
    """Return a Live base URL; callers append the AI route themselves."""
    value = (override or "").strip() or (live_url or "").strip() or "http://live:3000/live"
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("AI_AGENT_URL must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("AI_AGENT_URL must not contain credentials, a query, or a fragment")
    path = parsed.path.rstrip("/")
    if path.endswith("/ai/chat"):
        path = path[: -len("/ai/chat")].rstrip("/")
    if not path:
        path = "/live"
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))
