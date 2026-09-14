from types import SimpleNamespace
from unittest.mock import patch

import pytest
from django.http import HttpResponse
from django.test import RequestFactory

from plane.app.views.gitea import ReportInput, ValidationInput
from plane.middleware.logger import APITokenLogMiddleware, RequestLoggerMiddleware
from plane.utils.gitea import GiteaError, decrypt, encrypt, integration_data, normalize_url, validate_commits

pytestmark = pytest.mark.unit
SHA = "a" * 40


@pytest.mark.parametrize(
    "url",
    [
        "https://user:secret@git.example",
        "https://@git.example",
        "https://git.example\\@other",
        "file:///tmp/git",
        "javascript:alert(1)",
        "//git.example/a",
        "https://git.example:99999",
        " https://git.example",
        "https://git.example/\nabc",
        "https://git.example/\x7fabc",
        "https://git.example/\u202eabc",
        "https://git%40example/a",
        "http://",
    ],
)
def test_unsafe_url_rejected(url):
    with pytest.raises(GiteaError, match="invalid_url"):
        normalize_url(url)


def test_url_normalization_is_local_and_keeps_reported_path():
    with patch("socket.getaddrinfo", side_effect=AssertionError("No network")):
        assert (
            normalize_url("HTTP://Gitea.internal:80/git/commit/a?q=1#diff")
            == "http://gitea.internal/git/commit/a?q=1#diff"
        )
        assert normalize_url("http://[::1]:3000/git/a") == "http://[::1]:3000/git/a"
        assert normalize_url("https://git.local/研发/commit/a") == "https://git.local/%E7%A0%94%E5%8F%91/commit/a"
    with pytest.raises(GiteaError):
        normalize_url("https://git.local/" + "中" * 300)


@pytest.mark.parametrize(
    "path",
    [
        "/api/workspaces/team/integrations/gitea/",
        "/api/workspaces/team/integrations/gitea/hooks/",
        "/api/workspaces/team/integrations/gitea/rotate-token/",
        "/api/integrations/gitea/team/commits/",
        "/api/integrations/gitea/team/validate/",
        "/api/integrations/gitea/team/work-items/P-1/",
    ],
)
def test_gitea_logs_omit_request_and_response(path):
    request = RequestFactory().post(
        path, data="malformed secret", content_type="application/json", HTTP_X_API_KEY="key"
    )
    response = HttpResponse("hook with bearer secret")
    assert not RequestLoggerMiddleware(lambda request: response)._should_log_route(request)
    with patch("plane.middleware.logger.process_logs.delay") as log:
        middleware = APITokenLogMiddleware(lambda request: response)
        assert middleware(request) is response
        middleware.process_request(request, response, b"token secret")
    log.assert_not_called()


@pytest.mark.parametrize("prefix", ["1_研发+X", "TEAM-SUB", "ABC"])
@pytest.mark.parametrize("separator", [" ", "\t", " \t "])
def test_full_workspace_identifier(prefix, separator):
    workspace = SimpleNamespace(slug="team")
    issue = SimpleNamespace(archived_at=None, state=SimpleNamespace(group="started", name="开发中", deleted_at=None))
    with (
        patch("plane.utils.gitea.issue_for_identifier", return_value=issue) as lookup,
        patch("plane.utils.gitea.issue_data", return_value={"id": "item"}),
    ):
        result = validate_commits(workspace, [{"sha": "A" * 40, "message": f"{prefix}-3{separator}works\nbody"}])
        assert result["valid"]
        lookup.assert_called_once_with(workspace, f"{prefix}-3")


@pytest.mark.parametrize(
    "group,name,allowed",
    [
        ("started", "开发中", True),
        ("started", "开发完成/待验收", True),
        ("started", "Custom active stage", True),
        ("backlog", "待规划", False),
        ("unstarted", "待开始", False),
        ("completed", "已完成", False),
        ("cancelled", "已拒绝", False),
        ("triage", "待处理", False),
    ],
)
def test_commit_state_eligibility_uses_group_and_reports_actual_state(group, name, allowed):
    issue = SimpleNamespace(archived_at=None, state=SimpleNamespace(group=group, name=name, deleted_at=None))
    with (
        patch("plane.utils.gitea.issue_for_identifier", return_value=issue),
        patch("plane.utils.gitea.issue_data", return_value={"id": "item"}),
    ):
        result = validate_commits(object(), [{"sha": SHA, "message": "PROJ-3 implement change"}])
    assert result["valid"] is allowed
    row = result["results"][0]
    if allowed:
        assert row["error"] is None
    else:
        assert row["error"]["code"] == "work_item_not_in_progress"
        assert name in row["error"]["message"] and "PROJ-3" in row["error"]["message"]


@pytest.mark.parametrize("blocked", ["archived", "missing_state", "deleted_state"])
def test_inactive_work_item_cannot_pass_even_with_started_state(blocked):
    issue = SimpleNamespace(archived_at=None, state=SimpleNamespace(group="started", name="开发中", deleted_at=None))
    if blocked == "archived":
        issue.archived_at = object()
    elif blocked == "missing_state":
        issue.state = None
    else:
        issue.state.deleted_at = object()
    with (
        patch("plane.utils.gitea.issue_for_identifier", return_value=issue),
        patch("plane.utils.gitea.issue_data", return_value={"id": "item"}),
    ):
        result = validate_commits(object(), [{"sha": SHA, "message": "PROJ-3 implement change"}])
    assert result["valid"] is False
    assert result["results"][0]["error"]["code"] == "work_item_not_in_progress"


@pytest.mark.parametrize("message", ["ABC-0 fix", "ABC-01 fix", "ABC-1", "ABC-1\nfix", "x ABC-1 fix", "ABC-1\vfix"])
def test_bad_first_line_does_not_lookup(message):
    with patch("plane.utils.gitea.issue_for_identifier") as lookup:
        result = validate_commits(object(), [{"sha": SHA, "message": message}])
        assert not result["valid"] and result["results"][0]["error"]["code"] == "invalid_prefix"
        lookup.assert_not_called()


@pytest.mark.parametrize(
    "commits",
    [
        [],
        [{"sha": SHA, "message": "x"}] * 101,
        [{"sha": "", "message": "x"}],
        [{"sha": SHA, "message": "x"}, {"sha": SHA.upper(), "message": "y"}],
        [{"sha": SHA, "message": "中" * 21846}],
        [{"sha": SHA, "message": "x" * 65537}],
    ],
)
def test_batch_format_limits(commits):
    assert not ValidationInput(data={"commits": commits}).is_valid()


def test_report_requires_url_and_validates_date_and_unknown_fields():
    value = {"sha": SHA, "message": "ABC-1 fix"}
    assert not ReportInput(data={"commits": [value]}).is_valid()
    value["url"] = "http://git.local/commit/a"
    assert ReportInput(data={"commits": [value]}).is_valid()
    for field, invalid in [("committed_at", "yesterday"), ("url", "javascript:alert(1)"), ("repository_id", "x")]:
        assert not ReportInput(data={"commits": [{**value, field: invalid}]}).is_valid()


@pytest.mark.parametrize("suffix", ["?tab=code", "#readme", "?tab=code#readme", "?", "#"])
def test_hook_repository_query_and_fragment_return_400(suffix):
    from rest_framework.test import APIRequestFactory, force_authenticate
    from plane.app.views.gitea import GiteaHookEndpoint

    request = APIRequestFactory().post(
        "/api/workspaces/team/integrations/gitea/hooks/",
        {"repository_url": "https://git.local/team/repo" + suffix},
        format="json",
    )
    force_authenticate(request, user=SimpleNamespace(is_authenticated=True))
    with (
        patch.object(GiteaHookEndpoint, "workspace", return_value=SimpleNamespace(slug="team")),
        patch("plane.utils.gitea_hook.generate_hooks") as generate,
    ):
        response = GiteaHookEndpoint.as_view()(request, slug="team")
    assert response.status_code == 400 and "repository_url" in response.data
    assert response["Cache-Control"] == "no-store"
    generate.assert_not_called()


def test_commit_report_url_still_allows_query_and_fragment():
    from plane.app.views.gitea import HookInput

    assert HookInput(data={"repository_url": "http://git.local/team/repo"}).is_valid()
    url = "http://git.local/team/repo/commit/a?view=diff#L10"
    data = ReportInput(data={"commits": [{"sha": SHA, "message": "ABC-1 fix", "url": url}]})
    assert data.is_valid(), data.errors
    assert data.validated_data["commits"][0]["url"] == url


def test_secret_roundtrip_and_public_contract(settings):
    settings.APP_BASE_URL = "https://plane.example/base"
    encrypted = encrypt("workspace-secret")
    assert encrypted != "workspace-secret" and decrypt(encrypted) == "workspace-secret"
    config = integration_data(SimpleNamespace(slug="team"), SimpleNamespace(enabled=True, secret=encrypted))
    assert set(config) == {"enabled", "has_secret", "validation_url", "commits_url", "lookup_url", "issue_url_template"}
    assert config["lookup_url"] == "https://plane.example/base/api/integrations/gitea/team/work-items/{identifier}/"
    assert config["issue_url_template"] == "https://plane.example/base/team/browse/{identifier}/"
    assert "workspace-secret" not in str(config) and encrypted not in str(config)


@pytest.mark.parametrize("token", ["", "Bearer wrong", "Token correct", "Bearer 中文", "Bearer correct"])
def test_bearer_authentication_scopes_and_checks_secret(token):
    from rest_framework.exceptions import AuthenticationFailed
    from plane.app.views.gitea import WorkspaceBearerAuthentication

    request = SimpleNamespace(parser_context={"kwargs": {"slug": "team"}}, headers={"Authorization": token})
    integration = SimpleNamespace(secret=encrypt("correct"), workspace_id="workspace")
    with patch("plane.app.views.gitea.GiteaIntegration.objects.select_related") as manager:
        manager.return_value.filter.return_value.first.return_value = integration
        auth = WorkspaceBearerAuthentication()
        if token == "Bearer correct":
            assert auth.authenticate(request) is None
            assert request.gitea_integration is integration
        else:
            with pytest.raises(AuthenticationFailed):
                auth.authenticate(request)
        manager.return_value.filter.assert_called_once_with(
            workspace__slug="team",
            workspace__deleted_at__isnull=True,
            enabled=True,
        )


def test_routes_use_workspace_slug_and_never_repository_uuid():
    from django.urls import resolve
    from plane.app.views.gitea import GiteaCommitsEndpoint, GiteaIntegrationEndpoint, GiteaHookEndpoint

    for path, endpoint in [
        ("/api/workspaces/team/integrations/gitea/", GiteaIntegrationEndpoint),
        ("/api/workspaces/team/integrations/gitea/hooks/", GiteaHookEndpoint),
        ("/api/integrations/gitea/team/commits/", GiteaCommitsEndpoint),
    ]:
        route = resolve(path)
        assert route.func.view_class is endpoint and route.kwargs == {"slug": "team"}
