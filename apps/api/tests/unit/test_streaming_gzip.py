# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""Run with python3 apps/api/tests/unit/test_streaming_gzip.py (Django only; no services)."""

import asyncio
import gzip
import importlib.util
from pathlib import Path
import unittest
import zlib

from django.conf import settings
from django.http import HttpResponse, StreamingHttpResponse
from django.test import RequestFactory

# Avoid plane.__init__, which initializes Celery/Redis, for standalone runs.
_spec = importlib.util.spec_from_file_location(
    "streaming_gzip", Path(__file__).resolve().parents[2] / "plane/middleware/gzip.py"
)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
GZipMiddleware = _module.GZipMiddleware


class StreamingGZipTests(unittest.TestCase):
    def setUp(self):
        self.request = RequestFactory().post(
            "/api/workspaces/team/agent/chat/", HTTP_ACCEPT_ENCODING="gzip, deflate, br"
        )

    def process(self, response):
        return GZipMiddleware(lambda request: response)(self.request)

    def test_async_chat_delivers_text_and_done_after_initial_heartbeat(self):
        chunks = [
            b"\n",
            '{"type":"text","text":"你好"}\n'.encode(),
            b'\n{"type":"done","reason":"complete"}\n',
        ]

        async def stream():
            for chunk in chunks:
                yield chunk

        response = self.process(
            StreamingHttpResponse(
                stream(),
                content_type="application/x-ndjson",
                headers={"Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"},
            )
        )

        async def collect():
            return b"".join([chunk async for chunk in response.streaming_content])

        body = asyncio.run(collect())
        if response.get("Content-Encoding") == "gzip":
            # Browsers may decode only the first gzip member. gzip.decompress()
            # accepts concatenated members and would hide Django #36656 here.
            body = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(body)
        self.assertEqual(body, b"".join(chunks))
        self.assertTrue(response.is_async)
        self.assertNotIn("Content-Encoding", response)
        self.assertNotIn("Content-Length", response)
        self.assertEqual(response["X-Accel-Buffering"], "no")

    def test_async_stream_is_not_consumed_or_buffered_before_first_chunk(self):
        consumed = []

        async def stream():
            consumed.append("heartbeat")
            yield b"\n"
            consumed.append("done")
            yield b'{"type":"done"}\n'

        response = self.process(StreamingHttpResponse(stream(), headers={"Cache-Control": "no-store, no-transform"}))
        self.assertEqual(consumed, [])

        async def read():
            iterator = response.streaming_content
            self.assertEqual(await iterator.__anext__(), b"\n")
            self.assertEqual(consumed, ["heartbeat"])
            self.assertEqual(await iterator.__anext__(), b'{"type":"done"}\n')
            with self.assertRaises(StopAsyncIteration):
                await iterator.__anext__()

        asyncio.run(read())

    def test_no_transform_preserves_sync_stream_and_error_events(self):
        chunks = [
            b"\n",
            b'{"type":"error","code":"ai_model_error","message":"Model unavailable"}\n',
            b'{"type":"done","reason":"error"}\n',
        ]
        response = self.process(
            StreamingHttpResponse(iter(chunks), headers={"Cache-Control": "no-store, no-transform"})
        )
        self.assertNotIn("Content-Encoding", response)
        self.assertEqual(list(response.streaming_content), chunks)

    def test_no_transform_directive_is_case_insensitive_and_whitespace_tolerant(self):
        for cache_control in ["no-transform", "private, No-Transform", "no-store,  NO-TRANSFORM  , max-age=0"]:
            with self.subTest(cache_control=cache_control):
                response = self.process(HttpResponse(b"a" * 1000, headers={"Cache-Control": cache_control}))
                self.assertNotIn("Content-Encoding", response)
                self.assertEqual(response.content, b"a" * 1000)

    def test_normal_responses_keep_gzip_and_do_not_match_partial_directives(self):
        for cache_control in ["", "private, max-age=0", "x-no-transform", 'custom="no-transform"']:
            with self.subTest(cache_control=cache_control):
                response = self.process(HttpResponse(b"a" * 1000, headers={"Cache-Control": cache_control}))
                self.assertEqual(response["Content-Encoding"], "gzip")
                self.assertEqual(gzip.decompress(response.content), b"a" * 1000)
                self.assertIn("Accept-Encoding", response["Vary"])

    def test_existing_content_encoding_is_preserved(self):
        response = HttpResponse(b"encoded-body", headers={"Cache-Control": "no-transform", "Content-Encoding": "br"})
        self.assertIs(self.process(response), response)
        self.assertEqual(response["Content-Encoding"], "br")
        self.assertEqual(response.content, b"encoded-body")


if __name__ == "__main__":
    if not settings.configured:
        settings.configure(DEFAULT_CHARSET="utf-8")
    unittest.main()
