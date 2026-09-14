"""Real HTTP contract for the shell multipart transport and legacy JSON coexistence."""

import hashlib
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from plane.db.models import GiteaCommit, GiteaCommitLink, GiteaIntegration, Issue, Project, State, Workspace
from plane.utils.gitea import encrypt

pytestmark = [pytest.mark.contract, pytest.mark.django_db]
TOKEN = "shell-workspace-secret"
META = {"gitea_root_url": "https://GIT.example:443/gitea/", "gitea_owner": "team", "gitea_repo": "repo"}


@pytest.fixture(autouse=True)
def configuration(settings):
    settings.APP_BASE_URL = "https://plane.example"
    cache.clear()


@pytest.fixture
def integration(workspace):
    return GiteaIntegration.objects.create(workspace=workspace, enabled=True, secret=encrypt(TOKEN))


@pytest.fixture
def bearer():
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {TOKEN}")
    return client


@pytest.fixture
def items(workspace):
    result = []
    for prefix in ("研发", "TEAM-SUB"):
        project = Project.objects.create(workspace=workspace, identifier=prefix, name=prefix)
        state = State.objects.create(workspace=workspace, project=project, name="开发中", group="started")
        result.append(Issue.objects.create(workspace=workspace, project=project, state=state, name="Work"))
    return result


def key(item):
    return f"{item.project.identifier}-{item.sequence_id}"


def raw_commit(message, zone="+0800", extra=b"", algorithm="sha1"):
    if isinstance(message, str):
        message = message.encode("utf-8")
    raw = (
        b"tree "
        + b"a" * (40 if algorithm == "sha1" else 64)
        + b"\n"
        + "author 开发者 <private@example.com> 1767225600 ".encode()
        + zone.encode()
        + b"\n"
        + b"committer Committer <committer@example.com> 1767225600 +0000\n"
        + extra
        + b"\n"
        + message
    )
    return object_upload(raw, algorithm)


def object_upload(raw, algorithm="sha1", filename=None):
    sha = hashlib.new(algorithm, b"commit " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
    return SimpleUploadedFile(filename or sha, raw, content_type="application/octet-stream")


def post(client, integration, uploads, report=False, fields=None):
    data = {**(META if report else {}), **(fields or {}), "commits": uploads}
    suffix = "commits" if report else "validate"
    return client.post(f"/api/integrations/gitea/{integration.workspace.slug}/{suffix}/", data, format="multipart")


def error(response):
    assert response.status_code == 400
    assert response["Content-Type"] == "text/plain; charset=utf-8"
    lines = response.content.decode().splitlines()
    assert lines[0] == "PLANE-HOOK-ERROR"
    assert 1 <= len(lines[1:]) <= 10
    assert all(len(line) <= 500 and all(c.isprintable() for c in line) for line in lines[1:])
    assert TOKEN not in response.content.decode()


@pytest.mark.parametrize("algorithm", ["sha1", "sha256"])
def test_validate_unicode_exact_trailing_newline_and_order(bearer, integration, items, algorithm):
    messages = [f"{key(item)} 修复 🚀\n\n正文\n\n" for item in items]
    uploads = [raw_commit(message, algorithm=algorithm) for message in messages]
    shas = [upload.name for upload in uploads]
    from plane.app.views.gitea import validate_commits

    with patch("plane.app.views.gitea.validate_commits", wraps=validate_commits) as validate:
        response = post(bearer, integration, uploads)
    assert response.status_code == 200
    assert response.content.decode() == "PLANE-HOOK-OK\n" + "\n".join(shas) + "\nPLANE-HOOK-END\n"
    assert [c["message"] for c in validate.call_args.args[1]] == messages
    assert response["Cache-Control"] == "no-store"
    assert not GiteaCommit.objects.exists()


@pytest.mark.parametrize("zone,offset", [("+0800", 480), ("-0530", -330)])
def test_report_metadata_subpath_signature_replay_and_unique_links(bearer, integration, items, zone, offset):
    messages = [f"{key(items[0])} 修复 {index}\n\n正文\n" for index in range(2)]
    signature = (
        b"gpgsig -----BEGIN PGP SIGNATURE-----\n author not an author\n signature\n -----END PGP SIGNATURE-----\n"
    )

    def uploads():
        return [raw_commit(message, zone=zone, extra=signature) for message in messages]

    shas = [upload.name for upload in uploads()]
    identifier = key(items[0]).replace("研发", "%E7%A0%94%E5%8F%91")
    for _ in range(2):
        with patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
            response = post(bearer, integration, uploads(), report=True)
        assert response.status_code == 200
        assert response.content.decode().splitlines() == [
            "PLANE-HOOK-OK",
            *shas,
            "PLANE-HOOK-END",
            f"https://plane.example/{integration.workspace.slug}/browse/{identifier}/",
        ]
    assert GiteaCommit.objects.count() == GiteaCommitLink.objects.count() == 2
    for stored in GiteaCommit.objects.all():
        assert stored.author_name == "开发者"
        expected = datetime.fromtimestamp(1767225600, timezone(timedelta(minutes=offset)))
        assert stored.committed_at == expected
        assert stored.repository_name == "team/repo"
        assert stored.url == f"https://git.example/gitea/team/repo/commit/{stored.sha}"
        assert stored.message in messages


def test_override_repository_url_and_decoded_name(bearer, integration, items):
    response = post(
        bearer,
        integration,
        [raw_commit(f"{key(items[0])} work")],
        report=True,
        fields={"repository_url": "https://GIT.example:443/sub/%E5%9B%A2%E9%98%9F/repo/"},
    )
    assert response.status_code == 200
    stored = GiteaCommit.objects.get()
    assert stored.repository_name == "团队/repo"
    assert stored.url.startswith("https://git.example/sub/%E5%9B%A2%E9%98%9F/repo/commit/")


@pytest.mark.parametrize(
    "case",
    [
        "empty",
        "duplicate",
        "mismatch",
        "filename",
        "encoding",
        "raw",
        "message",
        "headers",
        "author",
        "too_many",
        "total",
        "unknown",
        "text",
        "scope",
    ],
)
def test_bad_payloads_fail_closed(bearer, integration, items, case):
    message = f"{key(items[0])} work"
    uploads = [raw_commit(message)]
    fields = {}
    if case == "empty":
        uploads = []
    elif case == "duplicate":
        uploads.append(raw_commit(message))
    elif case == "mismatch":
        uploads = [object_upload(b"wrong raw object", filename="a" * 40)]
    elif case == "filename":
        uploads = [object_upload(b"raw", filename="invalid")]
    elif case == "encoding":
        uploads = [raw_commit(message.encode() + b"\xff")]
    elif case == "raw":
        uploads = [raw_commit(message, extra=b"x" * 131072)]
    elif case == "message":
        uploads = [raw_commit(message + "界" * 22000)]
    elif case == "headers":
        uploads = [object_upload(b"no separator")]
    elif case == "author":
        uploads = [raw_commit(message, zone="+2460")]
    elif case == "too_many":
        uploads = [raw_commit(message + str(index)) for index in range(101)]
    elif case == "total":
        uploads = [raw_commit(message + str(index), extra=b"gpgsig " + b"x" * 110000 + b"\n") for index in range(5)]
    elif case == "unknown":
        fields = {"secret": "must never echo this"}
    elif case == "text":
        uploads = ["text commit"]
    elif case == "scope":
        fields = {"gitea_owner": "team"}
    response = post(bearer, integration, uploads, fields=fields)
    error(response)
    assert "must never echo this" not in response.content.decode()
    assert not GiteaCommit.objects.exists()


@pytest.mark.parametrize(
    "field,value",
    [
        ("repository_url", "https://user:password@git.example/team/repo"),
        ("repository_url", "https://git.example/team/repo?token=private"),
        ("repository_url", "https://git.example/team/repo#fragment"),
        ("repository_url", "https://git.example/team\\repo"),
        ("repository_url", "https://git.example/team/re po"),
        ("repository_url", "https://git.example/team/%0aevil"),
        ("repository_url", "https://git.example/team/%2frepo"),
        ("repository_url", "https://git.example/team/.."),
        ("repository_url", "https://git.example/repo"),
        ("gitea_root_url", "https://name:secret@git.example/sub"),
        ("gitea_root_url", "https://git.example/sub?query"),
        ("gitea_root_url", "https://git.example/sub#fragment"),
        ("gitea_root_url", "https://git.example/su\nb"),
        ("gitea_owner", "../other"),
        ("gitea_owner", ".."),
        ("gitea_owner", ""),
        ("gitea_repo", ""),
        ("gitea_repo", "a\\b"),
        ("gitea_repo", "a\tb"),
        ("gitea_repo", "a b"),
        ("gitea_owner", ["one", "two"]),
    ],
)
def test_malicious_repository_metadata_rejected(bearer, integration, items, field, value):
    error(post(bearer, integration, [raw_commit(f"{key(items[0])} work")], report=True, fields={field: value}))
    assert not GiteaCommit.objects.exists()


def test_cross_workspace_rejected_and_failed_batch_atomic(bearer, integration, items, create_user):
    other = Workspace.objects.create(name="Other", slug="shell-other", owner=create_user)
    project = Project.objects.create(workspace=other, name="Other", identifier="FOREIGN")
    foreign = Issue.objects.create(workspace=other, project=project, name="Foreign")
    for report in (False, True):
        error(
            post(
                bearer,
                integration,
                [raw_commit(f"{key(items[0])} valid"), raw_commit(f"{key(foreign)} invalid")],
                report=report,
            )
        )
        assert not GiteaCommit.objects.exists() and not GiteaCommitLink.objects.exists()
    response = post(bearer, integration, [raw_commit(f"{key(item)} valid") for item in items], report=True)
    assert response.status_code == 200
    assert GiteaCommit.objects.count() == 2


@pytest.mark.parametrize("field,value", [("sha", "f" * 40), ("message", "existing different message")])
def test_legacy_stored_conflict_is_atomic(bearer, integration, items, field, value):
    message = f"{key(items[0])} work"
    upload = raw_commit(message)
    stored = GiteaCommit.objects.create(
        workspace=integration.workspace,
        sha=upload.name,
        message=message,
        title=message,
        url=f"https://git.example/gitea/team/repo/commit/{upload.name}",
    )
    GiteaCommit.objects.filter(pk=stored.pk).update(**{field: value})
    response = post(bearer, integration, [raw_commit(f"{key(items[1])} new"), upload], report=True)
    error(response)
    assert "different SHA or message" in response.content.decode()
    assert GiteaCommit.objects.count() == 1 and not GiteaCommitLink.objects.exists()


def test_auth_disabled_and_throttles_keep_safe_json(bearer, integration, items):
    bearer.credentials(HTTP_AUTHORIZATION="Bearer wrong")
    response = post(bearer, integration, [raw_commit(f"{key(items[0])} work")])
    assert response.status_code == 401 and response["Content-Type"].startswith("application/json")
    bearer.credentials(HTTP_AUTHORIZATION=f"Bearer {TOKEN}")
    with (
        patch("plane.app.views.gitea.GiteaThrottle.allow_request", return_value=False),
        patch("plane.app.views.gitea.GiteaThrottle.wait", return_value=60),
    ):
        response = post(bearer, integration, [raw_commit(f"{key(items[0])} work")])
    assert response.status_code == 429 and response["Content-Type"].startswith("application/json")
    integration.enabled = False
    integration.save()
    response = post(bearer, integration, [raw_commit(f"{key(items[0])} work")])
    assert response.status_code == 401 and response["Content-Type"].startswith("application/json")


def test_maximum_commit_count_and_message_bytes_are_accepted(bearer, integration, items):
    title = f"{key(items[0])} work"
    uploads = [raw_commit(title + str(index)) for index in range(100)]
    shas = [upload.name for upload in uploads]
    response = post(bearer, integration, uploads)
    assert response.status_code == 200
    assert response.content.decode().splitlines() == ["PLANE-HOOK-OK", *shas, "PLANE-HOOK-END"]
    message = title + "\n" + "x" * (65536 - len((title + "\n").encode()))
    assert post(bearer, integration, [raw_commit(message)]).status_code == 200


def test_legacy_json_validation_stays_json_and_keeps_status(bearer, integration, items):
    url = f"/api/integrations/gitea/{integration.workspace.slug}/validate/"
    for message, valid in [(f"{key(items[0])} work", True), ("invalid", False)]:
        response = bearer.post(url, {"commits": [{"sha": "a" * 40, "message": message}]}, format="json")
        assert response.status_code == 200
        assert response.json()["valid"] is valid


@pytest.mark.parametrize("filename_prefix", ["../", "path/", "path\\\\", " "])
def test_original_filename_must_be_sha_before_django_normalization(bearer, integration, items, filename_prefix):
    from django.test.client import BOUNDARY, MULTIPART_CONTENT, encode_multipart

    upload = raw_commit(f"{key(items[0])} work")
    body = encode_multipart(BOUNDARY, {"commits": [upload]})
    body = body.replace(
        ('filename="' + upload.name + '"').encode(),
        ('filename="' + filename_prefix + upload.name + '"').encode(),
    )
    response = bearer.post(
        f"/api/integrations/gitea/{integration.workspace.slug}/validate/", body, content_type=MULTIPART_CONTENT
    )
    error(response)


def test_files_cannot_masquerade_as_metadata_or_unknown_fields(bearer, integration, items):
    for field in ("gitea_owner", "unknown"):
        response = post(
            bearer,
            integration,
            [raw_commit(f"{key(items[0])} work")],
            report=True,
            fields={field: raw_commit("secret raw text")},
        )
        error(response)
        assert "secret raw text" not in response.content.decode()
