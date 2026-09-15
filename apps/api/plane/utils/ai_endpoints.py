# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""Resolve validated user model URLs without probing or rewriting saved settings."""

from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

ModelProtocol = Literal["openai-completions", "openai-responses", "anthropic-messages"]


@dataclass(frozen=True)
class ModelEndpoint:
    protocol: ModelProtocol
    base_url: str
    models_url: str


def resolve_model_endpoint(provider: str, base_url: str) -> ModelEndpoint:
    """Keep in sync with Live's endpoint resolver: explicit endpoints select the wire protocol.

    Bare OpenAI origins default to /v1. Explicit OpenAI endpoints, including
    unversioned ones, and custom prefixes remain authoritative. Anthropic's SDK
    adds /v1/messages itself, so its SDK base must not end in another /v1.
    """
    parsed = urlsplit(base_url.strip().rstrip("/"))
    path = parsed.path
    protocol: ModelProtocol = "anthropic-messages" if provider == "anthropic" else "openai-completions"
    explicit_endpoint = False
    for suffix, selected in (
        ("/chat/completions", "openai-completions"),
        ("/responses", "openai-responses"),
        ("/messages", "anthropic-messages"),
    ):
        if path.endswith(suffix):
            path = path[: -len(suffix)]
            protocol = selected
            explicit_endpoint = True
            break
    if not explicit_endpoint and path.endswith("/models"):
        path = path[: -len("/models")]
        explicit_endpoint = True

    if protocol == "anthropic-messages":
        if path.endswith("/v1"):
            path = path[: -len("/v1")]
        models_suffix = "/v1/models"
    else:
        if not path and not explicit_endpoint:
            path = "/v1"
        models_suffix = "/models"

    base = urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))
    return ModelEndpoint(protocol=protocol, base_url=base, models_url=base + models_suffix)
