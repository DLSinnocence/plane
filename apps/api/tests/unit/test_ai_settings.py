# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""Run with python3 apps/api/tests/unit/test_ai_settings.py (no services needed)."""

import importlib.util
from pathlib import Path
import unittest

# Import the pure helper without plane.__init__, which initializes Celery/Redis.
_spec = importlib.util.spec_from_file_location(
    "ai_settings", Path(__file__).resolve().parents[2] / "plane/settings/ai.py"
)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
resolve_ai_agent_url = _module.resolve_ai_agent_url


class AIAgentURLTests(unittest.TestCase):
    def test_compose_default_without_public_live_url(self):
        self.assertEqual(resolve_ai_agent_url(), "http://live:3000/live")
        self.assertEqual(resolve_ai_agent_url("  ", ""), "http://live:3000/live")

    def test_configured_live_url_fallback(self):
        self.assertEqual(
            resolve_ai_agent_url(None, "https://plane.example/live/"),
            "https://plane.example/live",
        )

    def test_internal_override_takes_precedence(self):
        self.assertEqual(
            resolve_ai_agent_url("http://127.0.0.1:3005/live", "https://plane.example/live/"),
            "http://127.0.0.1:3005/live",
        )

    def test_normalize_base_and_chat_route(self):
        for value, expected in [
            (" http://localhost:3100/ ", "http://localhost:3100/live"),
            ("http://live:3000/live///", "http://live:3000/live"),
            ("http://live:3000/live/ai/chat/", "http://live:3000/live"),
            ("https://plane.example/prefix/live/", "https://plane.example/prefix/live"),
            ("http://live:3000/collaboration/", "http://live:3000/collaboration"),
            ("http://live:3000/collaboration/ai/chat/", "http://live:3000/collaboration"),
        ]:
            with self.subTest(value=value):
                self.assertEqual(resolve_ai_agent_url(value), expected)

    def test_reject_non_http_or_non_base_urls(self):
        for value in [
            "live:3000",
            "/live",
            "file:///live",
            "http://user:pass@live/live",
            "http://live/live?x=1",
            "http://live/live#chat",
        ]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                resolve_ai_agent_url(value)


if __name__ == "__main__":
    unittest.main()
