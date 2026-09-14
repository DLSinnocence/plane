# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""Bounded shell hook transport; repository URLs are display data only."""

import hashlib
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, unquote, urlsplit

from django.core.exceptions import RequestDataTooBig, TooManyFieldsSent, TooManyFilesSent
from django.http import HttpResponse
from django.http.multipartparser import MultiPartParser as DjangoMultiPartParser, MultiPartParserError
from rest_framework.exceptions import ParseError, ValidationError
from rest_framework.parsers import DataAndFiles, MultiPartParser

from plane.utils.gitea import GiteaError, SHA_PATTERN, normalize_url


MAX_RAW = 131072
MAX_BATCH = 512 * 1024
METADATA_FIELDS = {"repository_url", "gitea_root_url", "gitea_owner", "gitea_repo"}


class StrictCommitMultipartParser(DjangoMultiPartParser):
    @staticmethod
    def sanitize_file_name(file_name):
        # Django normally strips path prefixes; reject them before information is lost.
        if not re.fullmatch(SHA_PATTERN, file_name):
            raise MultiPartParserError("Invalid commit filename.")
        return file_name


class HookMultipartParser(MultiPartParser):
    def parse(self, stream, media_type=None, parser_context=None):
        context = parser_context or {}
        request = context["request"]
        meta = request.META.copy()
        meta["CONTENT_TYPE"] = media_type
        try:
            parser = StrictCommitMultipartParser(
                meta, stream, request.upload_handlers, context.get("encoding", "utf-8")
            )
            data, files = parser.parse()
        except (MultiPartParserError, RequestDataTooBig, TooManyFieldsSent, TooManyFilesSent):
            raise ParseError("Invalid multipart hook payload, limits or commit filename.") from None
        return DataAndFiles(data, files)


def invalid(reason):
    raise ValidationError(reason)


def segment(value):
    if (
        not value
        or value in {".", ".."}
        or "/" in value
        or "\\" in value
        or any(c.isspace() or unicodedata.category(c).startswith("C") for c in value)
    ):
        invalid("Invalid repository owner or name.")
    return value


def repository_metadata(fields):
    def checked(value):
        if "?" in value or "#" in value:
            invalid("Repository URL must not contain a query or fragment.")
        try:
            result = normalize_url(value).rstrip("/")
            # Encoded unsafe characters must not hide in display path segments.
            for part in urlsplit(result).path.split("/"):
                if part:
                    segment(unquote(part, errors="strict"))
            return result
        except (GiteaError, UnicodeError):
            invalid("Invalid repository URL.")

    # Supplied metadata is checked even when an explicit override wins.
    root = fields.get("gitea_root_url", "")
    owner = fields.get("gitea_owner", "")
    repo = fields.get("gitea_repo", "")
    if root:
        root = checked(root)
    if owner:
        segment(owner)
    if repo:
        segment(repo)
    explicit = fields.get("repository_url", "")
    if explicit:
        url = checked(explicit)
        parts = urlsplit(url).path.strip("/").split("/")
        if len(parts) < 2 or any(not part for part in parts):
            invalid("Repository URL must include owner and repository path segments.")
        name = "/".join(segment(unquote(part, errors="strict")) for part in parts[-2:])
    else:
        if not root or not owner or not repo:
            invalid("Missing Gitea repository root, owner or name.")
        url = checked(root + "/" + quote(owner, safe="") + "/" + quote(repo, safe=""))
        name = owner + "/" + repo
    return url, name


def parse_commit(upload, report):
    sha = upload.name
    if not re.fullmatch(SHA_PATTERN, sha):
        invalid("Commit filename must be a full 40 or 64 hexadecimal SHA.")
    sha = sha.lower()
    raw = upload.read(MAX_RAW + 1)
    if len(raw) > MAX_RAW:
        invalid("Raw commit exceeds 128 KiB.")
    digest = hashlib.sha1 if len(sha) == 40 else hashlib.sha256
    if digest(b"commit " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest() != sha:
        invalid("Commit object hash does not match its filename.")
    headers, separator, message = raw.partition(b"\n\n")
    if not separator or not headers or b"\0" in headers:
        invalid("Invalid raw Git commit headers.")
    header_lines = headers.split(b"\n")
    sha_bytes = rb"[0-9a-fA-F]{" + str(len(sha)).encode("ascii") + rb"}"
    if not re.fullmatch(rb"tree " + sha_bytes, header_lines[0]):
        invalid("Invalid Git commit tree header.")
    previous = False
    for line in header_lines:
        if line.startswith(b" "):
            if not previous:
                invalid("Invalid Git commit header continuation.")
            continue
        if not re.fullmatch(rb"[a-zA-Z0-9-]+ [^\0\r\n]*", line):
            invalid("Invalid raw Git commit header.")
        if line.startswith(b"parent ") and not re.fullmatch(rb"parent " + sha_bytes, line):
            invalid("Invalid Git commit parent header.")
        previous = True
    if sum(line.startswith(b"tree ") for line in header_lines) != 1:
        invalid("Commit must contain exactly one tree header.")
    if sum(line.startswith(b"committer ") for line in header_lines) != 1:
        invalid("Commit must contain exactly one committer header.")
    if len(message) > 65536:
        invalid("Commit message exceeds 64 KiB.")
    try:
        text = message.decode("utf-8", errors="strict")
    except UnicodeError:
        invalid("Commit message must be valid UTF-8.")
    if "\0" in text:
        invalid("Commit message contains a null character.")
    result = {"sha": sha, "message": text}
    # Continuation lines (including signed commit headers) are never author fields.
    authors = [line[7:] for line in headers.split(b"\n") if line.startswith(b"author ")]
    if len(authors) != 1:
        invalid("Commit must contain exactly one author header.")
    match = re.fullmatch(rb"([^<>\r\n]*) <[^<>\r\n]*> (-?[0-9]+) ([+-])([0-9]{2})([0-9]{2})", authors[0])
    if not match:
        invalid("Invalid Git commit author header.")
    try:
        name = match[1].decode("utf-8", errors="strict")
        hours, minutes = int(match[4]), int(match[5])
        if hours > 23 or minutes > 59:
            raise ValueError
        offset = timedelta(hours=hours, minutes=minutes) * (-1 if match[3] == b"-" else 1)
        date = datetime.fromtimestamp(int(match[2]), timezone(offset)).isoformat()
    except (UnicodeError, ValueError, OverflowError, OSError):
        invalid("Invalid Git commit author or timestamp.")
    if report:
        result.update(author_name=name, committed_at=date)
    return result, len(raw)


def multipart_commits(request, report=False):
    fields, files = request.data, request.FILES
    allowed = METADATA_FIELDS if report else set()
    if set(fields) - allowed - {"commits"} or set(files) - {"commits"}:
        invalid("Unknown multipart fields.")
    if any(len(fields.getlist(key)) != 1 or key in files for key in allowed if key in fields):
        invalid("Repository metadata fields must be single text values.")
    uploads = files.getlist("commits")
    if len(fields.getlist("commits")) != len(uploads):
        invalid("Commits must be uploaded files.")
    if not 1 <= len(uploads) <= 100:
        invalid("A batch must contain between 1 and 100 commit files.")
    metadata = repository_metadata(fields) if report else None
    commits, seen, total = [], set(), 0
    for upload in uploads:
        commit, size = parse_commit(upload, report)
        total += size
        if total > MAX_BATCH:
            invalid("Raw commit batch exceeds 512 KiB.")
        if commit["sha"] in seen:
            invalid("Duplicate SHAs are not allowed in a batch.")
        seen.add(commit["sha"])
        if report:
            url, name = metadata
            commit.update(url=url + "/commit/" + commit["sha"], repository_name=name)
        commits.append(commit)
    return {"commits": commits}


def shell_error(details):
    def messages(value):
        if isinstance(value, dict):
            for child in value.values():
                yield from messages(child)
        elif isinstance(value, (list, tuple)):
            for child in value:
                yield from messages(child)
        else:
            yield str(value)

    lines = []
    for message in messages(details):
        safe = "".join(c for c in message if c.isprintable())[:500]
        if safe:
            lines.append(safe)
        if len(lines) == 10:
            break
    return HttpResponse(
        "PLANE-HOOK-ERROR\n" + "\n".join(lines or ["Invalid hook request."]) + "\n",
        status=400,
        content_type="text/plain; charset=utf-8",
    )


def shell_result(result, commits, report=False):
    if result.get("valid") is not True:
        reasons = [
            row["sha"][:12] + ": " + row["error"]["message"] for row in result.get("results", []) if row.get("error")
        ]
        return shell_error(reasons)
    lines = ["PLANE-HOOK-OK", *(commit["sha"] for commit in commits), "PLANE-HOOK-END"]
    if report:
        lines.extend(dict.fromkeys(row["work_item"]["url"] for row in result["results"] if row.get("work_item")))
    return HttpResponse("\n".join(lines) + "\n", content_type="text/plain; charset=utf-8")
