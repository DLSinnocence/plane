import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const source = fileURLToPath(new URL("../", import.meta.url));
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (name) => readFileSync(join(source, name), "utf8");

function upgrade(t, saved = {}, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "plane-ai-startup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // An existing installation has no newly introduced keys. Its shared secret survives.
  writeFileSync(
    join(directory, "plane.env"),
    Object.entries({
      SECRET_KEY: "test-existing-django-secret",
      LIVE_SERVER_SECRET_KEY: "test-existing-live-secret",
      ...saved,
    })
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  );
  const definitions = read("start.sh").replace(/\nmain "\$@"\r?\n?$/, "\n");
  const result = spawnSync("bash", ["-e", "-c", `${definitions}\nupdate_env_file\n`], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      DOMAIN_NAME: "plane.example.test",
      DATABASE_URL: "postgresql://plane:fixture@plane-db/plane",
      REDIS_URL: "redis://plane-redis:6379/0",
      AMQP_URL: "amqp://plane:fixture@plane-mq/plane",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "fixture",
      AWS_SECRET_ACCESS_KEY: "fixture",
      AWS_S3_BUCKET_NAME: "uploads",
      ...overrides,
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return parseEnv(readFileSync(join(directory, "plane.env"), "utf8"));
}

test("AIO upgrades add internal endpoints and preserve the existing shared secret", (t) => {
  const values = upgrade(t);
  assert.equal(values.AI_AGENT_URL, "http://127.0.0.1:3005/live");
  assert.equal(values.API_BASE_URL, "http://localhost:3004");
  assert.equal(values.PLANE_MCP_COMMAND, "/opt/plane-mcp/bin/plane-mcp-server");
  assert.equal(values.LIVE_SERVER_SECRET_KEY, "test-existing-live-secret");
  assert.ok(!values.LIVE_BASE_URL);
  const supervisor = read("supervisor.conf");
  assert.match(supervisor, /\[program:live\][\s\S]*?environment=PORT=3005,/);
  assert.match(supervisor, /\[program:api\][\s\S]*?environment=PORT=3004,/);
  const defaults = parseEnv(read("variables.env"));
  for (const key of ["AI_AGENT_URL", "API_BASE_URL", "PLANE_MCP_COMMAND"]) {
    assert.equal(values[key], defaults[key], key);
  }
});

test("AIO preserves saved endpoint overrides and accepts container replacements", (t) => {
  const saved = {
    AI_AGENT_URL: "https://live.example.test/live",
    API_BASE_URL: "http://custom-api:8000",
    PLANE_MCP_COMMAND: "/custom/bin/plane-mcp-server",
  };
  const preserved = upgrade(t, saved);
  for (const [key, value] of Object.entries(saved)) assert.equal(preserved[key], value, key);
  const overrides = { AI_AGENT_URL: "http://replacement:3000/live", API_BASE_URL: "http://replacement:8000" };
  const replaced = upgrade(t, saved, overrides);
  for (const [key, value] of Object.entries(overrides)) assert.equal(replaced[key], value, key);
});

test("AIO builds isolated MCP against its Python base and checks final runtime", () => {
  const dockerfile = read("Dockerfile");
  const builder = dockerfile.match(/^FROM (\S+) AS mcp-builder$/m)?.[1];
  const runner = dockerfile.match(/^FROM (\S+) AS runner$/m)?.[1];
  assert.equal(builder, "python:3.12.12-alpine");
  assert.equal(builder, runner);
  assert.match(dockerfile, /python -m venv \/opt\/plane-mcp/);
  assert.match(dockerfile, /\/opt\/plane-mcp\/bin\/pip install --no-cache-dir plane-mcp-server==0\.3\.2/);
  assert.match(dockerfile, /COPY --from=mcp-builder \/opt\/plane-mcp \/opt\/plane-mcp/);
  assert.doesNotMatch(dockerfile, /COPY --from=live-img \/opt\/plane-mcp/);
  assert.match(dockerfile, /ENV PLANE_MCP_COMMAND="\/opt\/plane-mcp\/bin\/plane-mcp-server"/);
  const runtime = dockerfile.slice(dockerfile.indexOf(" AS runner"));
  const nodeCopy = runtime.indexOf("\nCOPY --from=node /usr/lib /usr/lib");
  const check = runtime.indexOf('RUN test -x "$PLANE_MCP_COMMAND"');
  assert.ok(check > runtime.indexOf("COPY --from=backend-img /usr/local/bin/"));
  assert.match(runtime.slice(check), /sys\.version_info\[:2\] == \(3, 12\)/);
  assert.match(runtime.slice(check), /from plane_mcp\.__main__ import main/);
  assert.doesNotMatch(runtime.slice(nodeCopy), /^RUN .*apk (add|update|upgrade|del)/m);
  for (const library of ["libstdc++", "libffi", "openssl"]) {
    assert.ok(runtime.slice(0, nodeCopy).includes(`"${library}"`), library);
  }
  assert.doesNotMatch(dockerfile, /^RUN .*\b(?:npm|npx) (?:install|exec)/m);
});

test("Compose templates use internal AI defaults and the existing service secret", () => {
  const cli = readFileSync(join(root, "deployments/cli/community/docker-compose.yml"), "utf8");
  assert.match(cli, /x-app-env: &app-env\n  AI_AGENT_URL: \$\{AI_AGENT_URL:-http:\/\/live:3000\/live\}/);
  assert.equal((cli.match(/LIVE_SERVER_SECRET_KEY: \$\{LIVE_SERVER_SECRET_KEY\}/g) || []).length, 2);
  assert.match(read("docker-compose.yml"), /AI_AGENT_URL: \$\{AI_AGENT_URL:-http:\/\/127\.0\.0\.1:3005\/live\}/);
  assert.match(
    readFileSync(join(root, "docker-compose.yml"), "utf8"),
    /AI_AGENT_URL: \$\{AI_AGENT_URL:-http:\/\/live:3000\/live\}/
  );
});
