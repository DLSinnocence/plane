# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import os
import shutil
import subprocess

import pytest

from plane.db.models import GiteaCommit, GiteaCommitLink, GiteaIntegration, Issue, Project
from plane.utils.gitea import encrypt

pytestmark = [pytest.mark.contract, pytest.mark.django_db(transaction=True)]


def test_generated_shell_hooks_push_to_real_django_api_without_python(
    workspace, session_client, live_server, settings, tmp_path
):
    """No transport mocks: real Git -> generated sh/curl -> Django -> PostgreSQL."""
    settings.APP_BASE_URL = live_server.url
    token = "integration-test-hook-token"
    GiteaIntegration.objects.create(workspace=workspace, enabled=True, secret=encrypt(token))
    project = Project.objects.create(workspace=workspace, name="Shell hooks", identifier="HOOK")
    issue = Issue.objects.create(project=project, name="Accept shell push")
    generated = session_client.post(f"/api/workspaces/{workspace.slug}/integrations/gitea/hooks/", {}, format="json")
    assert generated.status_code == 200
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    for name in (
        "sh",
        "git",
        "curl",
        "timeout",
        "date",
        "mktemp",
        "rm",
        "sort",
        "grep",
        "sed",
        "wc",
        "head",
        "tail",
        "tr",
        "cat",
    ):
        executable = shutil.which(name)
        assert executable, f"Real {name} is required for this integration test"
        (runtime / name).symlink_to(executable)
    assert not (runtime / "python3").exists() and not (runtime / "jq").exists()
    env = {
        **os.environ,
        "PATH": str(runtime),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
        "GITEA_ROOT_URL": "https://git.example/gitea/",
        "GITEA_REPO_USER_NAME": "Witch-Farm",
        "GITEA_REPO_NAME": "witch-farm",
    }
    env.pop("PLANE_GITEA_REPOSITORY_URL", None)
    local, remote = tmp_path / "local", tmp_path / "remote.git"

    def git(path, *args, check=True, stdin=None):
        return subprocess.run(
            [str(runtime / "git"), "-C", str(path), *args],
            env=env,
            input=stdin,
            text=True,
            capture_output=True,
            timeout=30,
            check=check,
        )

    for path, bare in ((local, False), (remote, True)):
        path.mkdir()
        git(path, "init", *(["--bare"] if bare else []), "--initial-branch=main")
    git(local, "config", "user.name", "测试作者")
    git(local, "config", "user.email", "test@example.invalid")
    tree = git(local, "mktree", stdin="").stdout.strip()
    initial = git(local, "commit-tree", tree, "-m", "Existing legacy history").stdout.strip()
    git(local, "push", str(remote), initial + ":refs/heads/main")
    for hook in generated.data.values():
        path = remote / "hooks" / hook["filename"]
        path.write_text(hook["content"], encoding="utf-8")
        path.chmod(0o700)
    title = f"HOOK-{issue.sequence_id} fix: 中文引用和引号 \" '"
    sha = git(local, "commit-tree", tree, "-p", initial, "-m", title).stdout.strip()
    accepted = git(local, "push", str(remote), sha + ":refs/heads/main", check=False)
    assert accepted.returncode == 0, accepted.stderr
    assert "Verified" in accepted.stderr and "Reported" in accepted.stderr
    assert token not in accepted.stdout + accepted.stderr
    stored = GiteaCommit.objects.get(sha=sha)
    assert stored.message == title + "\n"
    assert stored.author_name == "测试作者"
    assert stored.url == "https://git.example/gitea/Witch-Farm/witch-farm/commit/" + sha
    assert stored.repository_name == "Witch-Farm/witch-farm"
    assert GiteaCommitLink.objects.get(commit=stored).issue_id == issue.id
    invalid = git(local, "commit-tree", tree, "-p", sha, "-m", "HOOK-999999 nonexistent work item").stdout.strip()
    rejected = git(local, "push", str(remote), invalid + ":refs/heads/main", check=False)
    assert rejected.returncode != 0
    assert "Work item does not exist" in rejected.stderr
    assert token not in rejected.stdout + rejected.stderr
    assert git(remote, "rev-parse", "main").stdout.strip() == sha
    assert GiteaCommit.objects.count() == 1
