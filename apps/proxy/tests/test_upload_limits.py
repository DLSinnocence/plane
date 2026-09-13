"""Actual Caddy regression tests; no Docker or application dependencies.

Run: CADDY_BIN=/path/to/caddy python3 apps/proxy/tests/test_upload_limits.py
Use the version pinned in apps/proxy/Dockerfile.ce (currently 2.11.4).
Tests adapt both production Caddyfiles, retain their request matchers and limits,
then route requests to a local recording receiver on ephemeral loopback ports.
A small limit exercises the same multipart boundary without transferring 1 GiB.
The receiver does not emulate S3; signing policy is tested separately using the
real Python signing method and a recording client, without contacting storage.
"""

import ast
import http.client
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest


ROOT = Path(__file__).resolve().parents[3]
LIMIT = 1024


def available_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def multipart(size):
    boundary = "plane-upload-regression-boundary"
    fields = {
        "key": "workspace/example.zip",
        "Content-Type": "application/zip",
        "policy": "test-policy",
    }
    body = b""
    for key, value in fields.items():
        body += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'
        ).encode()
    body += (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="example.zip"\r\n'
        "Content-Type: application/zip\r\n\r\n"
    ).encode()
    body += b"x" * size
    body += f"\r\n--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


class UploadLimitTests(unittest.TestCase):
    def test_signed_policy_still_limits_file_bytes(self):
        # Execute only the real pure signing method: no Django setup or boto3.
        source = ROOT / "apps/api/plane/settings/storage.py"
        tree = ast.parse(source.read_text())
        storage = next(
            n
            for n in tree.body
            if isinstance(n, ast.ClassDef) and n.name == "S3Storage"
        )
        method = next(
            n
            for n in storage.body
            if isinstance(n, ast.FunctionDef) and n.name == "generate_presigned_post"
        )
        namespace = {"ClientError": RuntimeError}
        exec(
            compile(ast.Module(body=[method], type_ignores=[]), str(source), "exec"),
            namespace,
        )

        class RecordingStorage:
            signed_url_expiration = 3600
            aws_storage_bucket_name = "uploads"

            def generate_presigned_post(self, **kwargs):
                return kwargs

        fake = RecordingStorage()
        fake.s3_client = fake
        for size in (1, LIMIT, 1024**3):
            policy = namespace["generate_presigned_post"](
                fake, "workspace/example.zip", "application/zip", size
            )
            self.assertIn(["content-length-range", 1, size], policy["Conditions"])
            self.assertIn({"Content-Type": "application/zip"}, policy["Conditions"])

    def test_real_caddy_upload_limits(self):
        binary = os.environ.get("CADDY_BIN") or shutil.which("caddy")
        self.assertTrue(
            binary,
            "Set CADDY_BIN to the Caddy binary pinned by apps/proxy/Dockerfile.ce",
        )
        print(
            subprocess.check_output([binary, "version"], text=True).strip(), flush=True
        )
        for filename in ("Caddyfile.ce", "Caddyfile.aio.ce"):
            with self.subTest(config=filename):
                self.check_config(binary, filename)

    def check_config(self, binary, filename):
        received = []

        class Receiver(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.connection.settimeout(2)
                try:
                    data = self.rfile.read(int(self.headers["Content-Length"]))
                    received.append((self.path, len(data)))
                    self.send_response(200)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                except (OSError, ValueError):
                    pass

            def log_message(self, *_args):
                pass

        upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
        worker = threading.Thread(target=upstream.serve_forever, daemon=True)
        worker.start()
        try:
            port = available_port()
            env = dict(os.environ)
            env.update(
                FILE_SIZE_LIMIT=str(LIMIT),
                BUCKET_NAME="uploads",
                SITE_ADDRESS=f"http://127.0.0.1:{port}",
                CERT_EMAIL="",
                CERT_ACME_CA="https://acme-v02.api.letsencrypt.org/directory",
                CERT_ACME_DNS="",
            )
            adapted = subprocess.run(
                [
                    binary,
                    "adapt",
                    "--adapter",
                    "caddyfile",
                    "--config",
                    str(ROOT / "apps/proxy" / filename),
                ],
                env=env,
                text=True,
                capture_output=True,
                check=True,
            )
            config = json.loads(adapted.stdout)

            def replace_upstreams(value):
                if isinstance(value, dict):
                    if value.get("handler") in ("reverse_proxy", "file_server"):
                        # AIO's static fallback normally doesn't consume bodies.
                        # Use a receiver there too to exercise the body limiter
                        # on paths merely sharing the bucket name's prefix.
                        value.clear()
                        value.update(
                            handler="reverse_proxy",
                            upstreams=[{"dial": f"127.0.0.1:{upstream.server_port}"}],
                        )
                    for child in value.values():
                        replace_upstreams(child)
                elif isinstance(value, list):
                    for child in value:
                        replace_upstreams(child)

            replace_upstreams(config)
            config["admin"] = {"disabled": True, "config": {"persist": False}}
            for server in config["apps"]["http"]["servers"].values():
                server["automatic_https"] = {"disable": True}
            with tempfile.TemporaryDirectory(prefix="plane-proxy-test-") as directory:
                path = Path(directory) / "caddy.json"
                path.write_text(json.dumps(config))
                with (Path(directory) / "caddy.log").open("w+") as log:
                    process = subprocess.Popen(
                        [binary, "run", "--config", str(path)], stdout=log, stderr=log
                    )
                    try:
                        for _ in range(100):
                            if process.poll() is not None:
                                log.seek(0)
                                self.fail(log.read())
                            try:
                                with socket.create_connection(
                                    ("127.0.0.1", port), timeout=0.1
                                ):
                                    break
                            except OSError:
                                time.sleep(0.05)
                        else:
                            self.fail("Caddy did not start")

                        def post(route, body, content_type="application/octet-stream"):
                            connection = http.client.HTTPConnection(
                                "127.0.0.1", port, timeout=5
                            )
                            try:
                                connection.request(
                                    "POST", route, body, {"Content-Type": content_type}
                                )
                                response = connection.getresponse()
                                response.read()
                                return response.status
                            finally:
                                connection.close()

                        for size in (LIMIT - 1, LIMIT):
                            body, content_type = multipart(size)
                            self.assertGreater(len(body), LIMIT)
                            for route in (
                                "/uploads",
                                "/uploads/",
                                "/uploads/nested/object.zip",
                            ):
                                self.assertEqual(
                                    post(route, body, content_type), 200, route
                                )
                                self.assertEqual(received[-1], (route, len(body)))
                            print(
                                f"{filename}: file={size}, multipart={len(body)} forwarded intact",
                                flush=True,
                            )
                        self.assertEqual(post("/api/test", b"x" * LIMIT), 200)
                        for route in (
                            "/api/test",
                            "/uploads-other",
                            "/uploads-other/object.zip",
                        ):
                            self.assertEqual(
                                post(route, b"x" * (LIMIT + 1)), 413, route
                            )
                        print(
                            f"{filename}: API and bucket-prefix lookalikes retain HTTP 413",
                            flush=True,
                        )
                    finally:
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
        finally:
            upstream.shutdown()
            upstream.server_close()
            worker.join(timeout=5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
