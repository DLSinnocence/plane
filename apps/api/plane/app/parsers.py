# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from io import BytesIO

from rest_framework.exceptions import ParseError
from rest_framework.parsers import JSONParser


class AIChatJSONParser(JSONParser):
    # DRF JSON parsing reads the stream directly, bypassing Django's request.body
    # memory check. Keep an explicit bound even if instance settings allow more.
    max_body_bytes = 10 * 1024 * 1024

    def parse(self, stream, media_type=None, parser_context=None):
        body = stream.read(self.max_body_bytes + 1)
        if len(body) > self.max_body_bytes:
            raise ParseError("The AI request is too large. Attach at most 3 images of 2 MiB each.")
        return super().parse(BytesIO(body), media_type=media_type, parser_context=parser_context)
