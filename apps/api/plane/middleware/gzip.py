# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.middleware.gzip import GZipMiddleware as DjangoGZipMiddleware


class GZipMiddleware(DjangoGZipMiddleware):
    """Preserve responses that explicitly opt out of transformation."""

    def process_response(self, request, response):
        # Django 5.2 compresses async chunks as separate gzip members (#36656).
        # Browsers may decode only the first one: the AI stream's blank heartbeat.
        # Honor the response's opt-out without consuming or buffering its iterator.
        directives = response.get("Cache-Control", "").split(",")
        if any(directive.strip().lower() == "no-transform" for directive in directives):
            return response
        return super().process_response(request, response)
