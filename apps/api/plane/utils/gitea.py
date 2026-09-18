# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""Workspace-scoped validation. Reported URLs are display data, never network targets."""

import re
import unicodedata
from urllib.parse import quote, urlsplit, urlunsplit

from plane.db.models import Issue
from plane.db.models.state import StateGroup
from plane.utils import feishu

SHA_PATTERN = r"(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})"


class GiteaError(Exception):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


def encrypt(secret):
    try:
        return feishu.encrypt_secret(secret)
    except feishu.FeishuError:
        raise GiteaError("secret_encryption_failed") from None


def decrypt(secret):
    try:
        return feishu.decrypt_secret(secret)
    except feishu.FeishuError:
        raise GiteaError("secret_decryption_failed") from None


def app_url():
    try:
        return feishu.configured_app_url()
    except feishu.FeishuError:
        raise GiteaError("invalid_application_url") from None


def normalize_url(value):
    """Accept absolute HTTP(S), including internal hosts, without resolving or fetching."""
    try:
        if not isinstance(value, str) or not value or len(value) > 2048:
            raise ValueError
        if any(c.isspace() or unicodedata.category(c).startswith("C") for c in value) or "\\" in value:
            raise ValueError
        parsed = urlsplit(value)
        if (
            parsed.scheme.lower() not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or "%" in parsed.netloc
        ):
            raise ValueError
        port = parsed.port
        host = parsed.hostname.encode("idna").decode("ascii").lower()
        if not re.fullmatch(r"[a-z0-9._:-]+", host):
            raise ValueError
        if ":" in host:
            host = f"[{host}]"
        if port is not None and (parsed.scheme.lower(), port) not in {("http", 80), ("https", 443)}:
            host += f":{port}"
        normalized = quote(
            urlunsplit((parsed.scheme.lower(), host, parsed.path or "/", parsed.query, parsed.fragment)),
            safe=":/?#[]@!$&'()*+,;=%-._~",
        )
        if len(normalized) > 2048:
            raise ValueError
        return normalized
    except (ValueError, TypeError, UnicodeError):
        raise GiteaError("invalid_url") from None


def endpoint_url(workspace, suffix):
    return f"{app_url()}/api/integrations/gitea/{quote(workspace.slug, safe='')}/{suffix}/"


def integration_data(workspace, integration):
    return {
        "enabled": bool(integration and integration.enabled),
        "has_secret": bool(integration and integration.secret),
        "validation_url": endpoint_url(workspace, "validate"),
        "commits_url": endpoint_url(workspace, "commits"),
        "lookup_url": endpoint_url(workspace, "work-items/{identifier}"),
        "issue_url_template": f"{app_url()}/{quote(workspace.slug, safe='')}/browse/{{identifier}}/",
    }


def issue_data(workspace, issue):
    identifier = f"{issue.project.identifier}-{issue.sequence_id}"
    return {
        "id": str(issue.id),
        "identifier": identifier,
        "name": issue.name,
        "url": f"{app_url()}/{quote(workspace.slug, safe='')}/browse/{quote(identifier, safe='')}/",
        "project_id": str(issue.project_id),
    }


def issue_for_identifier(workspace, identifier):
    if not isinstance(identifier, str) or "-" not in identifier:
        return None
    prefix, sequence = identifier.rsplit("-", 1)
    if not prefix or not re.fullmatch(r"[1-9][0-9]{0,18}", sequence) or int(sequence) > 9223372036854775807:
        return None
    return (
        Issue.objects.select_related("project", "state")
        .filter(
            project__identifier=prefix,
            project__workspace=workspace,
            project__deleted_at__isnull=True,
            workspace=workspace,
            sequence_id=int(sequence),
            is_draft=False,
            deleted_at__isnull=True,
        )
        .first()
    )


def validate_commits(workspace, commits):
    results = []
    for commit in commits:
        first_line = commit["message"].split("\n", 1)[0].rstrip("\r")
        if first_line.startswith("[deploy]"):
            results.append(
                {
                    "sha": commit["sha"].lower(),
                    "valid": True,
                    "identifier": None,
                    "work_item": None,
                    "error": None,
                }
            )
            continue
        match = re.fullmatch(r"([^\s]+-[1-9][0-9]{0,18})[ \t]+\S.*", first_line)
        identifier = match.group(1) if match else None
        issue = issue_for_identifier(workspace, identifier) if identifier else None
        error = None
        if not match:
            error = {
                "code": "invalid_prefix",
                "message": "Commit first line must start with a work item key and a description.",
            }
        elif issue is None:
            error = {"code": "work_item_not_found", "message": "Work item does not exist in this workspace."}
        elif (
            issue.archived_at is not None
            or issue.state is None
            or issue.state.deleted_at is not None
            or issue.state.group != StateGroup.STARTED
        ):
            current_state = issue.state.name if issue.state is not None else "no state"
            if issue.archived_at is not None:
                current_state += " (archived)"
            elif issue.state is not None and issue.state.deleted_at is not None:
                current_state += " (removed state)"
            error = {
                "code": "work_item_not_in_progress",
                "message": (
                    f'Work item {identifier} is in state "{current_state}". '
                    "Only in-progress work items (development or awaiting acceptance) allow commits."
                ),
            }
        results.append(
            {
                "sha": commit["sha"].lower(),
                "valid": error is None,
                "identifier": identifier,
                "work_item": issue_data(workspace, issue) if issue else None,
                "error": error,
            }
        )
    return {"valid": all(row["valid"] for row in results), "results": results}
