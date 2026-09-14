#!/usr/bin/env python3
# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""Refresh the bounded, offline Models.dev registry (standard library only)."""

import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

SOURCE = "https://models.dev/api.json"
MAX_SOURCE_BYTES = 16 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
DESTINATION = Path(__file__).resolve().parents[1] / "plane/utils/data/models_dev.json"


def normalize(payload):
    providers = {}
    for provider_id, provider in sorted(payload.items()):
        models = {}
        for model_id, model in sorted(provider["models"].items()):
            inputs = model.get("modalities", {}).get("input")
            vision = "image" in inputs if isinstance(inputs, list) and all(isinstance(i, str) for i in inputs) else None
            tools = model.get("tool_call")
            reasoning = model.get("reasoning")
            context = model.get("limit", {}).get("context")
            models[model_id] = [
                vision,
                tools if isinstance(tools, bool) else None,
                reasoning if isinstance(reasoning, bool) else None,
                context if type(context) is int and context > 0 else None,
                model.get("name") if isinstance(model.get("name"), str) else model_id,
            ]
        providers[provider_id] = {"api": provider.get("api"), "models": models}
    return providers


def main():
    request = Request(SOURCE, headers={"User-Agent": "Plane-model-metadata/1.0", "Accept": "application/json"})
    # No application configuration, credentials, or gateway URLs enter this request.
    with urlopen(request, timeout=30) as response:
        raw = response.read(MAX_SOURCE_BYTES + 1)
    if len(raw) > MAX_SOURCE_BYTES:
        raise ValueError("Models.dev response exceeds size limit")
    snapshot = {
        "source": SOURCE,
        "license": "MIT; see models_dev.LICENSE",
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "fields": ["vision", "tools", "reasoning", "context_window", "name"],
        "providers": normalize(json.loads(raw)),
    }
    encoded = json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    if len(encoded.encode()) > MAX_SNAPSHOT_BYTES:
        raise ValueError("Normalized registry exceeds size limit")
    DESTINATION.write_text(encoded, encoding="utf-8")
    print(f"Wrote {DESTINATION}: {len(encoded.encode()):,} bytes, {len(snapshot['providers'])} providers")


if __name__ == "__main__":
    main()
