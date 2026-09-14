# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import hashlib
import importlib.util
import os
from email import policy
from email.parser import BytesParser
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Load the standalone generator without importing Plane's Celery application.
_spec = importlib.util.spec_from_file_location(
    "plane_gitea_hook", Path(__file__).resolve().parents[3] / "utils" / "gitea_hook.py"
)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
generate_pre_receive_hook = _module.generate_pre_receive_hook
generate_hooks = _module.generate_hooks


class GiteaGeneratedHookTests(unittest.TestCase):
    """Exercise the generated hook through real Git receive-pack transactions."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="plane-gitea-hook-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.local = self.root / "local"
        self.remote = self.root / "remote.git"
        self.requests = []
        self.mock_errors = []
        self.addCleanup(lambda: self.assertEqual(self.mock_errors, []))
        self.mode = "valid"
        self.token = "workspace-secret-never-log-this"
        self.report_mode = None
        self.env = {
            **{key: value for key, value in os.environ.items() if not key.startswith(("GITEA_", "PLANE_GITEA_"))},
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
        }
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                raw_body = self.rfile.read(int(self.headers["Content-Length"]))
                content_type = self.headers["Content-Type"]
                try:
                    body = fixture.parse_multipart(content_type, raw_body)
                except (AssertionError, ValueError) as error:
                    fixture.mock_errors.append(str(error))
                    self.send_response(400)
                    self.end_headers()
                    return
                fixture.requests.append((self.path, self.headers.get("Authorization"), body))
                mode = fixture.report_mode if self.path == "/commits/" and fixture.report_mode else fixture.mode
                if mode == "second_batch_error":
                    mode = (
                        "http_error" if sum(request[0] == "/commits/" for request in fixture.requests) > 1 else "valid"
                    )
                if mode == "redirect":
                    self.send_response(302)
                    self.send_header("Location", fixture.url + "redirect-target")
                    self.end_headers()
                    return
                status = 200
                response_type = "text/plain; charset=utf-8"
                shas = [commit["sha"] for commit in body["commits"]]
                if mode == "incomplete":
                    shas = shas[:-1]
                if mode == "wrong_sha":
                    shas[0] = "a" * 40
                if mode == "reversed_shas":
                    shas.reverse()
                lines = ["PLANE-HOOK-OK", *shas, "PLANE-HOOK-END"]
                if mode == "wrong_end":
                    lines[-1] = "NOT-PLANE-HOOK-END"
                if mode == "reject":
                    status = 400
                    lines = ["PLANE-HOOK-ERROR", "Work item does not exist"]
                elif mode == "invalid_repository":
                    status = 400
                    lines = ["PLANE-HOOK-ERROR", "Invalid repository URL configuration"]
                elif mode == "http_error":
                    status = 401
                    # Even an untrusted response echoing the secret must not leak it.
                    lines = [fixture.token]
                elif mode == "html":
                    response_type = "text/html"
                    lines = ["<!doctype html><html>Sign in</html>"]
                elif self.path == "/commits/" and mode == "valid":
                    lines.extend(
                        "https://plane.example/workspace/browse/" + commit["message"].split()[0] + "/"
                        for commit in body["commits"]
                    )
                encoded = ("\n".join(lines) + "\n").encode()
                self.send_response(status)
                self.send_header("Content-Type", response_type)
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)
        self.url = "http://127.0.0.1:%s/validate/" % self.server.server_port
        for path, bare in ((self.local, False), (self.remote, True)):
            path.mkdir()
            self.git(path, "init", *(["--bare"] if bare else []), "--initial-branch=main")
        self.git(self.local, "config", "user.name", "Hook test")
        self.git(self.local, "config", "user.email", "test@example.invalid")
        self.tree = self.git(self.local, "mktree", stdin="").stdout.strip()
        self.legacy = self.commit("old history without ticket")
        self.push(self.legacy, "refs/heads/main", allowed=True)
        self.hook = self.remote / "hooks" / "pre-receive"
        self.hook.write_text(generate_pre_receive_hook(self.url, self.token))
        self.hook.chmod(0o700)

    def parse_multipart(self, content_type, raw_body):
        message = BytesParser(policy=policy.default).parsebytes(
            b"Content-Type: " + content_type.encode("ascii") + b"\r\nMIME-Version: 1.0\r\n\r\n" + raw_body
        )
        self.assertEqual(message.get_content_type(), "multipart/form-data")
        self.assertTrue(message.is_multipart())
        self.assertFalse(message.defects)
        body = {"commits": []}
        for part in message.iter_parts():
            self.assertEqual(part.get_content_disposition(), "form-data")
            name = part.get_param("name", header="content-disposition")
            payload = part.get_payload(decode=True)
            if name == "commits":
                sha = part.get_filename()
                self.assertRegex(sha, r"^[0-9a-f]{40}$")
                self.assertEqual(
                    hashlib.sha1(b"commit " + str(len(payload)).encode() + b"\0" + payload).hexdigest(), sha
                )
                headers, separator, raw_message = payload.partition(b"\n\n")
                self.assertEqual(separator, b"\n\n")
                author = next(line[7:] for line in headers.split(b"\n") if line.startswith(b"author "))
                body["commits"].append(
                    {
                        "sha": sha,
                        "message": raw_message.decode("utf-8"),
                        "author_name": author.rsplit(b" <", 1)[0].decode("utf-8"),
                        "raw": payload,
                    }
                )
            else:
                self.assertIn(name, {"repository_url", "gitea_root_url", "gitea_owner", "gitea_repo"})
                self.assertNotIn(name, body)
                self.assertIsNone(part.get_filename())
                body[name] = payload.decode("utf-8")
        self.assertTrue(body["commits"])
        return body

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def git(self, path, *args, stdin=None, check=True):
        return subprocess.run(
            ["git", "-C", str(path), *args],
            input=stdin,
            capture_output=True,
            text=True,
            env=self.env,
            check=check,
            timeout=20,
        )

    def commit(self, message, *parents):
        args = ["commit-tree", self.tree, "-m", message]
        for parent in parents:
            args.extend(["-p", parent])
        return self.git(self.local, *args).stdout.strip()

    def push(self, oid, ref, *, allowed):
        result = self.git(self.local, "push", str(self.remote), "%s:%s" % (oid, ref), check=False)
        self.assertEqual(result.returncode == 0, allowed, result.stderr)
        self.assertNotIn(self.token, result.stderr)
        self.assertNotIn(self.token, result.stdout)
        return result

    def test_new_commits_use_scoped_api_and_preserve_history(self):
        oid = self.commit("PROJ-12 修复草稿", self.legacy)
        self.push(oid, "refs/heads/main", allowed=True)
        self.assertEqual(len(self.requests), 1)
        path, authorization, body = self.requests[0]
        self.assertEqual(path, "/validate/")
        self.assertEqual(authorization, "Bearer " + self.token)
        self.assertEqual([item["sha"] for item in body["commits"]], [oid])
        self.assertTrue(body["commits"][0]["message"].startswith("PROJ-12 修复草稿"))

    def test_server_is_authoritative_even_for_a_well_formed_identifier(self):
        self.mode = "reject"
        oid = self.commit("PROJ-99999 unknown work item", self.legacy)
        result = self.push(oid, "refs/heads/main", allowed=False)
        self.assertIn("Work item does not exist", result.stderr)
        self.assertEqual(self.git(self.remote, "rev-parse", "refs/heads/main").stdout.strip(), self.legacy)

    def test_all_commits_are_checked_in_a_new_branch(self):
        first = self.commit("arbitrary title for API to reject", self.legacy)
        second = self.commit("PROJ-12 valid tip", first)
        self.mode = "reject"
        self.push(second, "refs/heads/new", allowed=False)
        self.assertEqual({item["sha"] for item in self.requests[0][2]["commits"]}, {first, second})

    def test_force_push_reports_new_history_without_rechecking_existing_commits(self):
        self.install_post_hook()
        original = self.commit("PROJ-12 original branch", self.legacy)
        self.push(original, "refs/heads/main", allowed=True)
        self.requests.clear()
        first = self.commit("OTHER-7 replacement branch", self.legacy)
        second = self.commit("PROJ-13 replacement tip", first)
        result = self.git(self.local, "push", "--force", str(self.remote), second + ":refs/heads/main", check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(self.token, result.stdout + result.stderr)
        self.assertEqual([path for path, _, _ in self.requests], ["/validate/", "/commits/"])
        for _, _, body in self.requests:
            self.assertEqual({item["sha"] for item in body["commits"]}, {first, second})

    def test_tags_cannot_bypass_api_validation(self):
        oid = self.commit("PROJ-999 unknown", self.legacy)
        self.git(self.local, "tag", "-a", "release", oid, "-m", "Release")
        annotated = self.git(self.local, "rev-parse", "refs/tags/release").stdout.strip()
        self.mode = "reject"
        self.push(annotated, "refs/tags/release", allowed=False)
        self.push(oid, "refs/tags/lightweight", allowed=False)
        self.assertEqual(len(self.requests), 2)
        self.assertTrue(all(request[2]["commits"][0]["sha"] == oid for request in self.requests))

    def test_deletions_and_noncommit_tags_do_not_call_api(self):
        self.push(self.tree, "refs/tags/tree", allowed=True)
        self.push(self.legacy, "refs/heads/removable", allowed=True)
        self.push("", "refs/heads/removable", allowed=True)
        self.assertEqual(self.requests, [])

    def test_multiple_refs_validate_each_new_commit_once(self):
        first = self.commit("PROJ-12 shared", self.legacy)
        second = self.commit("PROJ-13 tip", first)
        self.git(self.local, "push", str(self.remote), first + ":refs/heads/a", second + ":refs/heads/b")
        self.assertEqual(len(self.requests), 1)
        self.assertEqual({item["sha"] for item in self.requests[0][2]["commits"]}, {first, second})

    def test_commit_batches_have_at_most_one_hundred_items(self):
        tip = self.legacy
        for number in range(101):
            tip = self.commit("PROJ-%s change" % (number + 1), tip)
        self.push(tip, "refs/heads/batch", allowed=True)
        self.assertEqual([len(request[2]["commits"]) for request in self.requests], [100, 1])

    def test_commit_batches_respect_raw_object_byte_budget(self):
        self.install_post_hook()
        tip = self.legacy
        for number in range(10):
            tip = self.commit("PROJ-%s " % (number + 1) + "x" * 60000, tip)
        self.push(tip, "refs/heads/main", allowed=True)
        for endpoint in ("/validate/", "/commits/"):
            batches = [body["commits"] for path, _, body in self.requests if path == endpoint]
            self.assertGreater(len(batches), 1)
            self.assertEqual(sum(len(batch) for batch in batches), 10)
            self.assertEqual(len({item["sha"] for batch in batches for item in batch}), 10)
            self.assertTrue(all(sum(len(item["raw"]) for item in batch) <= 512 * 1024 for batch in batches))

    def test_bad_api_responses_fail_closed(self):
        oid = self.commit("PROJ-12 change", self.legacy)
        for mode in ("http_error", "html", "incomplete", "wrong_sha", "wrong_end"):
            with self.subTest(mode=mode):
                self.mode = mode
                self.requests.clear()
                self.push(oid, "refs/heads/" + mode, allowed=False)
                self.assertEqual([request[0] for request in self.requests], ["/validate/"])

    def test_reordered_acknowledgements_fail_closed(self):
        first = self.commit("PROJ-12 first", self.legacy)
        second = self.commit("PROJ-13 second", first)
        self.mode = "reversed_shas"
        self.push(second, "refs/heads/main", allowed=False)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual({item["sha"] for item in self.requests[0][2]["commits"]}, {first, second})

    def test_redirects_do_not_receive_repository_secret(self):
        self.mode = "redirect"
        self.push(self.commit("PROJ-12 change", self.legacy), "refs/heads/main", allowed=False)
        self.assertEqual([request[0] for request in self.requests], ["/validate/"])

    def test_unavailable_api_rejects_push(self):
        self.server.shutdown()
        self.server.server_close()
        self.push(self.commit("PROJ-12 change", self.legacy), "refs/heads/main", allowed=False)

    def test_oversized_message_is_rejected_without_network_call(self):
        oid = self.commit("PROJ-12 " + "x" * 65536, self.legacy)
        self.push(oid, "refs/heads/main", allowed=False)
        self.assertEqual(self.requests, [])

    def test_rendered_values_are_valid_shell_and_cannot_inject_commands(self):
        marker = self.root / "injected"
        payload = "'\"; touch " + str(marker) + "; # $(touch " + str(marker) + ") `touch " + str(marker) + "`"
        content = generate_hooks(
            self.url,
            self.url.replace("validate", "commits"),
            self.token + payload,
            "https://git.example/team/code'quoted",
        )
        for hook in content.values():
            self.assertTrue(hook["content"].startswith("#!/bin/sh\n"))
            syntax = subprocess.run(["sh", "-n"], input=hook["content"], capture_output=True, text=True, timeout=10)
            self.assertEqual(syntax.returncode, 0, syntax.stderr)
            target = self.remote / "hooks" / hook["filename"]
            target.write_text(hook["content"])
            target.chmod(0o700)
        oid = self.commit("PROJ-12 quoted token", self.legacy)
        result = self.push(oid, "refs/heads/main", allowed=True)
        self.assertFalse(marker.exists())
        self.assertEqual([auth for _, auth, _ in self.requests], ["Bearer " + self.token + payload] * 2)
        self.assertNotIn(payload, result.stdout + result.stderr)
        self.assertEqual(self.requests[-1][2]["repository_url"], "https://git.example/team/code'quoted")

    def test_invalid_endpoints_and_control_characters_are_rejected(self):
        for endpoint in (
            "file:///etc/passwd",
            "https://user:pass@example.com/api",
            "https://example.com/?token=secret",
            "https://example.com/#fragment",
            "https://example.com/\\path",
            "https://example.com/\npath",
        ):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                generate_pre_receive_hook(endpoint, self.token)
        with self.assertRaises(ValueError):
            generate_pre_receive_hook(self.url, "token\nAuthorization: bad")

    def install_post_hook(self, repository_url="https://git.example/team/shared-code"):
        hooks = generate_hooks(self.url, self.url.replace("validate", "commits"), self.token, repository_url)
        self.post_hook = self.remote / "hooks" / "post-receive"
        self.post_hook.write_text(hooks["post_receive"]["content"])
        self.post_hook.chmod(0o700)
        return self.post_hook

    def gitea_environment(self, root="https://git.example/", owner="team", name="shared-code"):
        self.env.update(GITEA_ROOT_URL=root, GITEA_REPO_USER_NAME=owner, GITEA_REPO_NAME=name)

    def test_automatic_bundle_is_reused_in_two_repositories(self):
        hooks = generate_hooks(self.url, self.url.replace("validate", "commits"), self.token)
        original = self.remote
        other = self.root / "other.git"
        other.mkdir()
        self.git(other, "init", "--bare", "--initial-branch=main")
        self.git(self.local, "push", str(other), self.legacy + ":refs/heads/main")
        oid = self.commit("PROJ-12 shared workspace", self.legacy)
        for remote, root, owner, name in (
            (original, "https://git.example/", "team", "first"),
            (other, "https://another.example/gitea/", "组织", "code'quoted"),
        ):
            self.remote = remote
            for hook in hooks.values():
                target = remote / "hooks" / hook["filename"]
                target.write_text(hook["content"])
                target.chmod(0o700)
            self.gitea_environment(root, owner, name)
            self.push(oid, "refs/heads/main", allowed=True)
        reports = [body for path, _, body in self.requests if path == "/commits/"]
        self.assertEqual(
            [
                (body["repository_url"], body["gitea_root_url"], body["gitea_owner"], body["gitea_repo"])
                for body in reports
            ],
            [
                ("", "https://git.example/", "team", "first"),
                ("", "https://another.example/gitea/", "组织", "code'quoted"),
            ],
        )
        self.assertEqual([body["commits"][0]["sha"] for body in reports], [oid, oid])
        self.assertEqual([path for path, _, _ in self.requests], ["/validate/", "/commits/"] * 2)
        self.assertTrue(all(auth == "Bearer " + self.token for _, auth, _ in self.requests))

    def test_automatic_report_ignores_deletions_without_environment(self):
        self.install_post_hook("")
        self.push(self.legacy, "refs/heads/removable", allowed=True)
        self.push("", "refs/heads/removable", allowed=True)
        self.push(self.tree, "refs/tags/tree", allowed=True)
        self.assertEqual(self.requests, [])

    def test_automatic_report_rejects_missing_or_invalid_environment(self):
        self.install_post_hook("")
        cases = [
            ("GITEA_ROOT_URL", ""),
            ("GITEA_REPO_USER_NAME", ""),
            ("GITEA_REPO_NAME", ""),
            ("GITEA_ROOT_URL", "javascript:alert(1)"),
            ("GITEA_ROOT_URL", "https://user:" + self.token + "@git.example/"),
            ("GITEA_ROOT_URL", "https://git.example/?"),
            ("GITEA_ROOT_URL", "https://git.example/#"),
            ("GITEA_ROOT_URL", "https://git.example/\n"),
            ("GITEA_ROOT_URL", "https://git.example/\x7f"),
            ("GITEA_ROOT_URL", "https://git.example/\\path"),
            ("GITEA_ROOT_URL", "https://git.example:invalid/"),
            ("GITEA_ROOT_URL", "https://[broken/"),
            ("GITEA_REPO_USER_NAME", "../team"),
            ("GITEA_REPO_USER_NAME", "."),
            ("GITEA_REPO_NAME", ".."),
            ("GITEA_REPO_NAME", "bad\\name"),
            ("GITEA_REPO_NAME", "bad\nname"),
        ]
        tip = self.legacy
        self.report_mode = "invalid_repository"
        for key, value in cases:
            with self.subTest(key=key, value=value):
                self.gitea_environment()
                self.env[key] = value
                self.requests.clear()
                tip = self.commit("PROJ-12 case " + str(cases.index((key, value))), tip)
                result = self.push(tip, "refs/heads/main", allowed=True)
                self.assertIn("[Plane: REPORT FAILED]", result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                expected_paths = [["/validate/"]] if not value else [["/validate/"], ["/validate/", "/commits/"]]
                self.assertIn([path for path, _, _ in self.requests], expected_paths)
                self.assertTrue(all(auth == "Bearer " + self.token for _, auth, _ in self.requests))
                self.assertEqual(self.git(self.remote, "rev-parse", "main").stdout.strip(), tip)

    def test_automatic_report_supports_explicit_environment_override(self):
        self.install_post_hook("")
        self.env["PLANE_GITEA_REPOSITORY_URL"] = "https://override.example/git/team/repo"
        oid = self.commit("PROJ-12 explicit override", self.legacy)
        self.push(oid, "refs/heads/main", allowed=True)
        self.assertEqual(self.requests[-1][2]["repository_url"], "https://override.example/git/team/repo")
        self.env["PLANE_GITEA_REPOSITORY_URL"] = "https://user:" + self.token + "@override.example/"
        self.report_mode = "invalid_repository"
        self.requests.clear()
        result = self.push(self.commit("PROJ-12 unsafe override", oid), "refs/heads/main", allowed=True)
        self.assertIn("[Plane: REPORT FAILED]", result.stderr)
        self.assertIn([path for path, _, _ in self.requests], [["/validate/"], ["/validate/", "/commits/"]])

    def test_automatic_retry_restores_url_without_gitea_environment(self):
        self.install_post_hook("")
        # Quote-bearing public paths must survive copying the shell retry command.
        self.gitea_environment("https://git.example/gitea'quoted/", "team", "repo")
        self.report_mode = "http_error"
        oid = self.commit("PROJ-12 accepted automatic report", self.legacy)
        result = self.push(oid, "refs/heads/main", allowed=True)
        marker = "Retry in this bare repository after fixing the error: "
        retry = next(line.split(marker, 1)[1] for line in result.stderr.splitlines() if marker in line)
        command = shlex.split(retry)
        self.assertEqual(command[0], "env")
        self.assertEqual(
            command[1:4],
            ["GITEA_ROOT_URL=https://git.example/gitea'quoted/", "GITEA_REPO_USER_NAME=team", "GITEA_REPO_NAME=repo"],
        )
        self.assertEqual(command[4:], ["sh", str(self.post_hook), "--commits", oid])
        self.assertNotIn(self.token, retry)
        self.env = {key: value for key, value in self.env.items() if not key.startswith("GITEA_")}
        self.report_mode = "valid"
        replay = subprocess.run(command, cwd=self.remote, env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(replay.returncode, 0, replay.stderr)
        self.assertIn("Reported", replay.stdout)
        self.assertNotIn(self.token, replay.stdout + replay.stderr)
        self.assertEqual(self.requests[-1][2], self.requests[-2][2])
        self.assertEqual(self.requests[-1][2]["gitea_root_url"], "https://git.example/gitea'quoted/")

    def test_one_repository_reports_work_items_from_multiple_projects(self):
        self.install_post_hook()
        first = self.commit("PROJ-12 shared change", self.legacy)
        second = self.commit("OTHER-7 another project\n\nDetails", first)
        result = self.push(second, "refs/heads/main", allowed=True)
        self.assertEqual([request[0] for request in self.requests], ["/validate/", "/commits/"])
        validated = {item["sha"]: item["message"] for item in self.requests[0][2]["commits"]}
        reported = self.requests[1][2]["commits"]
        self.assertEqual({item["sha"] for item in reported}, {first, second})
        for item in reported:
            self.assertEqual(item["message"], validated[item["sha"]])
            self.assertEqual(item["author_name"], "Hook test")
            expected_raw = subprocess.run(
                ["git", "-C", str(self.local), "cat-file", "commit", item["sha"]],
                capture_output=True,
                env=self.env,
                check=True,
                timeout=10,
            ).stdout
            self.assertEqual(item["raw"], expected_raw)
            self.assertNotIn("project_id", item)
            self.assertNotIn("repository_id", item)
        self.assertEqual(self.requests[1][2]["repository_url"], "https://git.example/team/shared-code")
        self.assertEqual(
            set(self.requests[1][2]), {"commits", "repository_url", "gitea_root_url", "gitea_owner", "gitea_repo"}
        )
        self.assertIn("/browse/PROJ-12/", result.stderr)
        self.assertIn("/browse/OTHER-7/", result.stderr)

    def test_post_hook_new_branch_excludes_existing_history(self):
        self.install_post_hook()
        oid = self.commit("OTHER-7 new branch work", self.legacy)
        self.push(oid, "refs/heads/new-branch", allowed=True)
        report = self.requests[-1][2]["commits"]
        self.assertEqual([item["sha"] for item in report], [oid])

    def test_rejected_push_never_calls_link_reporting_api(self):
        self.install_post_hook()
        self.mode = "reject"
        self.push(self.commit("PROJ-999 missing", self.legacy), "refs/heads/main", allowed=False)
        self.assertEqual([request[0] for request in self.requests], ["/validate/"])

    def test_reporting_failure_preserves_push_and_supports_exact_sha_retry(self):
        self.install_post_hook()
        self.report_mode = "http_error"
        oid = self.commit("PROJ-12 accepted work", self.legacy)
        result = self.push(oid, "refs/heads/main", allowed=True)
        self.assertEqual(self.git(self.remote, "rev-parse", "refs/heads/main").stdout.strip(), oid)
        self.assertIn("Push was accepted", result.stderr)
        self.assertIn("--commits " + oid, result.stderr)
        marker = "Retry in this bare repository after fixing the error: "
        retry = next(line.split(marker, 1)[1] for line in result.stderr.splitlines() if marker in line)
        command = shlex.split(retry)
        self.assertEqual(
            command,
            [
                "env",
                "PLANE_GITEA_REPOSITORY_URL=https://git.example/team/shared-code",
                "sh",
                str(self.post_hook),
                "--commits",
                oid,
            ],
        )
        self.assertNotIn(self.token, retry)
        self.report_mode = "valid"
        replay = subprocess.run(
            command,
            cwd=self.remote,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=20,
        )
        self.assertEqual(replay.returncode, 0, replay.stderr)
        self.assertIn("Reported", replay.stdout)
        self.assertNotIn(self.token, replay.stdout + replay.stderr)
        self.assertEqual(self.requests[-1][2]["commits"][0]["sha"], oid)

    def test_report_retry_contains_only_the_failed_remaining_batch(self):
        self.install_post_hook()
        self.report_mode = "second_batch_error"
        first = self.commit("PROJ-1 first", self.legacy)
        tip = first
        for number in range(2, 102):
            tip = self.commit("OTHER-%s later" % number, tip)
        result = self.push(tip, "refs/heads/main", allowed=True)
        reports = [request[2]["commits"] for request in self.requests if request[0] == "/commits/"]
        self.assertEqual([len(batch) for batch in reports], [100, 1])
        self.assertEqual(reports[-1][0]["sha"], first)
        retry = next(line for line in result.stderr.splitlines() if "Retry in this bare repository" in line)
        self.assertTrue(retry.rstrip().endswith("--commits " + first), repr(retry))
        self.assertNotIn(tip, retry)

    def test_repository_url_only_changes_reported_links(self):
        self.install_post_hook("https://other-git.example/another/repository")
        oid = self.commit("PROJ-12 same work item", self.legacy)
        self.push(oid, "refs/heads/main", allowed=True)
        self.assertEqual(self.requests[-1][2]["repository_url"], "https://other-git.example/another/repository")
        self.assertTrue(all(request[1] == "Bearer " + self.token for request in self.requests))
        self.assertTrue(all(request[0] in {"/validate/", "/commits/"} for request in self.requests))

    def test_dynamic_repository_url_is_never_an_http_destination(self):
        repository_url = self.url.replace("/validate/", "/repository-must-not-be-requested")
        self.install_post_hook("")
        self.env["PLANE_GITEA_REPOSITORY_URL"] = repository_url
        oid = self.commit("PROJ-12 fixed API destination", self.legacy)
        self.push(oid, "refs/heads/main", allowed=True)
        self.assertEqual([path for path, _, _ in self.requests], ["/validate/", "/commits/"])
        self.assertEqual(self.requests[-1][2]["repository_url"], repository_url)

    def test_post_hook_multi_ref_push_deduplicates_reports(self):
        self.install_post_hook()
        first = self.commit("PROJ-12 shared commit", self.legacy)
        second = self.commit("OTHER-7 second commit", first)
        self.git(self.local, "push", str(self.remote), first + ":refs/heads/one", second + ":refs/heads/two")
        self.assertEqual([request[0] for request in self.requests], ["/validate/", "/commits/"])
        self.assertEqual({item["sha"] for item in self.requests[-1][2]["commits"]}, {first, second})

    def restricted_path(self, *, without=()):
        directory = self.root / ("restricted-path-" + "-".join(without))
        directory.mkdir()
        commands = (
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
        )
        for command in commands:
            if command in without:
                continue
            source = shutil.which(command)
            if source is None:
                source = next(
                    (
                        str(Path(prefix) / command)
                        for prefix in ("/usr/bin", "/bin", "/usr/local/bin")
                        if os.access(Path(prefix) / command, os.X_OK)
                    ),
                    None,
                )
            self.assertIsNotNone(source, "Required integration-test tool is unavailable: " + command)
            (directory / command).symlink_to(source)
        self.env["PATH"] = str(directory)
        return directory

    def test_both_hooks_push_without_python_or_jq_on_path(self):
        self.install_post_hook("")
        self.gitea_environment()
        first = self.commit("PROJ-12 raw subject\n\nMessage body with 'quotes' and 中文\n", self.legacy)
        second = self.commit("OTHER-7 second commit", first)
        directory = self.restricted_path()
        for command in ("python", "python3", "jq"):
            self.assertIsNone(shutil.which(command, path=str(directory)))
        result = self.push(second, "refs/heads/main", allowed=True)
        self.assertEqual([path for path, _, _ in self.requests], ["/validate/", "/commits/"])
        for _, _, body in self.requests:
            self.assertEqual({item["sha"] for item in body["commits"]}, {first, second})
        self.assertIn("/browse/PROJ-12/", result.stderr)
        self.assertIn("/browse/OTHER-7/", result.stderr)

    def test_missing_curl_clearly_rejects_push_without_leaking_token(self):
        oid = self.commit("PROJ-12 missing curl", self.legacy)
        self.restricted_path(without=("curl",))
        result = self.push(oid, "refs/heads/main", allowed=False)
        self.assertIn("curl", result.stderr.lower())
        self.assertEqual(self.requests, [])
        self.assertEqual(self.git(self.remote, "rev-parse", "main").stdout.strip(), self.legacy)

    def test_report_malformed_success_preserves_push_but_reports_failure(self):
        self.install_post_hook()
        tip = self.legacy
        for mode in ("html", "incomplete", "wrong_sha", "wrong_end"):
            with self.subTest(mode=mode):
                self.report_mode = mode
                tip = self.commit("PROJ-12 " + mode, tip)
                result = self.push(tip, "refs/heads/main", allowed=True)
                self.assertIn("[Plane: REPORT FAILED]", result.stderr)
                self.assertIn("--commits " + tip, result.stderr)
                self.assertEqual(self.git(self.remote, "rev-parse", "main").stdout.strip(), tip)

    @unittest.skipUnless(os.environ.get("PLANE_TEST_BUSYBOX"), "Set PLANE_TEST_BUSYBOX for Alpine-style tool testing")
    def test_busybox_shell_and_applets_work_without_python_or_jq(self):
        busybox = Path(os.environ["PLANE_TEST_BUSYBOX"]).resolve()
        runtime = self.root / "busybox-runtime"
        runtime.mkdir()
        for name in (
            "sh",
            "env",
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
            (runtime / name).symlink_to(busybox)
        for name in ("git", "curl"):
            executable = shutil.which(name)
            self.assertIsNotNone(executable)
            (runtime / name).symlink_to(executable)
        self.env["PATH"] = str(runtime)
        self.gitea_environment("https://git.example/gitea'quoted/", "team", "repo")
        for hook in generate_hooks(self.url, self.url.replace("validate", "commits"), self.token).values():
            target = self.remote / "hooks" / hook["filename"]
            target.write_text(hook["content"].replace("#!/bin/sh\n", "#!" + str(busybox) + " sh\n", 1))
            target.chmod(0o700)
        first = self.commit("PROJ-12 BusyBox push", self.legacy)
        self.push(first, "refs/heads/main", allowed=True)
        self.assertEqual([path for path, _, _ in self.requests], ["/validate/", "/commits/"])
        self.requests.clear()
        self.report_mode = "http_error"
        second = self.commit("PROJ-12 retry with BusyBox", first)
        result = self.push(second, "refs/heads/main", allowed=True)
        retry = next(
            line.split("Retry in this bare repository after fixing the error: ", 1)[1]
            for line in result.stderr.splitlines()
            if "Retry in this bare repository" in line
        )
        self.report_mode = "valid"
        replay = subprocess.run(
            shlex.split(retry), cwd=self.remote, env=self.env, capture_output=True, text=True, timeout=20
        )
        self.assertEqual(replay.returncode, 0, replay.stderr)
        self.assertIn("Reported", replay.stdout)
        self.assertNotIn(self.token, replay.stdout + replay.stderr)

    def test_unsafe_report_repository_url_is_rejected(self):
        for url in ("javascript:alert(1)", "https://user:pass@git.example/repo", "https://git.example/repo#fragment"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                generate_hooks(self.url, self.url.replace("validate", "commits"), self.token, url)


if __name__ == "__main__":
    unittest.main()
