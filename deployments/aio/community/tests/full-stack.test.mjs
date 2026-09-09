import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const source = fileURLToPath(new URL("../", import.meta.url));
const secretKeys = [
  "POSTGRES_PASSWORD",
  "RABBITMQ_PASSWORD",
  "MINIO_ROOT_PASSWORD",
  "SECRET_KEY",
  "LIVE_SERVER_SECRET_KEY",
];
const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
const composeCommand = process.env.COMPOSE_BINARY ? resolve(process.env.COMPOSE_BINARY) : "docker";
const composeArgs = process.env.COMPOSE_BINARY ? [] : ["compose"];
const composeAvailable = spawnSync(composeCommand, [...composeArgs, "version"], { env: cleanEnv }).status === 0;
const composeOptions = { skip: !composeAvailable && process.env.GITHUB_ACTIONS !== "true" };

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "plane-full-stack-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function run(command, args, cwd, overrides = {}) {
  return spawnSync(command, args, {
    cwd,
    env: { ...cleanEnv, ...overrides },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function succeeded(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function initialize(directory) {
  const result = run("bash", [join(source, "init-stack.sh")], directory);
  succeeded(result);
  return { values: parseEnv(readFileSync(join(directory, ".env"), "utf8")), result };
}

function deployment(t) {
  const directory = temporaryDirectory(t);
  copyFileSync(join(source, "docker-compose.full.yml"), join(directory, "docker-compose.full.yml"));
  const { values } = initialize(directory);
  assert.deepEqual(readdirSync(directory).sort(), [".env", "docker-compose.full.yml"]);
  return { directory, values };
}

function render(directory, overrides = {}) {
  assert.ok(composeAvailable, "Docker Compose is required in CI (or set COMPOSE_BINARY)");
  return JSON.parse(
    succeeded(
      run(
        composeCommand,
        [...composeArgs, "-f", "docker-compose.full.yml", "config", "--format", "json"],
        directory,
        overrides
      )
    )
  );
}

test("initializer creates private, distinct secrets and deployment defaults without leaking credentials", (t) => {
  const directory = temporaryDirectory(t);
  const { values, result } = initialize(directory);
  assert.equal(statSync(join(directory, ".env")).mode & 0o777, 0o600);
  assert.equal(new Set(secretKeys.map((key) => values[key])).size, 5);
  for (const key of secretKeys) {
    assert.match(values[key], /^[a-f0-9]{64}$/, key);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(values[key]), `${key} leaked to output`);
  }
  const defaults = {
    DOMAIN_NAME: "localhost",
    WEB_URL: "http://localhost",
    APP_PROTOCOL: "http",
    SITE_ADDRESS: ":80",
    LISTEN_HTTP_PORT: "80",
    LISTEN_HTTPS_PORT: "443",
    MINIO_ENDPOINT_SSL: "0",
    FILE_SIZE_LIMIT: "5242880",
    GUNICORN_WORKERS: "1",
  };
  for (const [key, value] of Object.entries(defaults)) assert.equal(values[key], value, key);
});

test("initializer refuses overwrite without changing existing bytes or leaking credentials", (t) => {
  const directory = temporaryDirectory(t);
  const { values } = initialize(directory);
  const before = readFileSync(join(directory, ".env"));
  const result = run("bash", [join(source, "init-stack.sh")], directory);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to overwrite/);
  assert.deepEqual(readFileSync(join(directory, ".env")), before);
  for (const key of secretKeys) assert.ok(!`${result.stdout}${result.stderr}`.includes(values[key]));
});

test("independent installations receive different secrets", (t) => {
  const first = initialize(temporaryDirectory(t)).values;
  const second = initialize(temporaryDirectory(t)).values;
  assert.equal(new Set([...secretKeys.map((key) => first[key]), ...secretKeys.map((key) => second[key])]).size, 10);
});

test(
  "full Compose renders from only generated .env with bridge isolation and persistent services",
  composeOptions,
  (t) => {
    const { directory, values } = deployment(t);
    const config = render(directory);
    const services = config.services;
    assert.deepEqual(Object.keys(services).sort(), [
      "minio-init",
      "plane",
      "plane-db",
      "plane-minio",
      "plane-mq",
      "plane-redis",
    ]);
    assert.equal(config.networks.default.driver, "bridge");
    assert.equal(services.plane.image, "ghcr.io/dlsinnocence/plane-aio-community:stable");
    assert.match(services["plane-db"].image, /^postgres:/);
    assert.match(services["plane-redis"].image, /^valkey\/valkey:/);
    assert.match(services["plane-mq"].image, /^rabbitmq:/);
    assert.match(services["plane-minio"].image, /^minio\/minio:/);
    assert.match(services["minio-init"].image, /^minio\/mc:/);
    for (const [name, service] of Object.entries(services)) {
      assert.equal(service.network_mode, undefined, name);
      assert.equal(service.pid, undefined, name);
      assert.ok(!service.privileged, name);
      assert.deepEqual(Object.keys(service.networks), ["default"], name);
      assert.doesNotMatch(JSON.stringify(service), /docker\.sock|containerd\.sock|\/run\/podman/);
      if (name !== "plane") assert.ok(!service.ports?.length, `${name} must not publish ports`);
    }
    assert.deepEqual(
      services.plane.ports.map(({ published, target }) => [published, target]),
      [
        ["80", 80],
        ["443", 443],
      ]
    );
    const state = {
      plane: { "/app/data": "plane_data", "/app/logs": "plane_logs" },
      "plane-db": { "/var/lib/postgresql/data": "pgdata" },
      "plane-redis": { "/data": "redisdata" },
      "plane-mq": { "/var/lib/rabbitmq": "rabbitmq_data" },
      "plane-minio": { "/data": "uploads" },
    };
    for (const [name, mounts] of Object.entries(state)) {
      for (const [target, volume] of Object.entries(mounts)) {
        const mount = services[name].volumes.find((item) => item.target === target);
        assert.equal(mount?.type, "volume", `${name}:${target}`);
        assert.equal(mount.source, volume);
        assert.ok(Object.hasOwn(config.volumes, volume));
      }
    }
    assert.deepEqual(services["plane-redis"].command, ["valkey-server", "--appendonly", "yes"]);
    const env = services.plane.environment;
    const database = services["plane-db"].environment;
    const rabbit = services["plane-mq"].environment;
    const minio = services["plane-minio"].environment;
    assert.equal(
      env.DATABASE_URL,
      `postgresql://${database.POSTGRES_USER}:${database.POSTGRES_PASSWORD}@plane-db:5432/${database.POSTGRES_DB}`
    );
    assert.equal(
      env.AMQP_URL,
      `amqp://${rabbit.RABBITMQ_DEFAULT_USER}:${rabbit.RABBITMQ_DEFAULT_PASS}@plane-mq:5672/${rabbit.RABBITMQ_DEFAULT_VHOST}`
    );
    assert.equal(database.POSTGRES_PASSWORD, values.POSTGRES_PASSWORD);
    assert.equal(rabbit.RABBITMQ_DEFAULT_PASS, values.RABBITMQ_PASSWORD);
    assert.equal(env.REDIS_URL, "redis://plane-redis:6379/0");
    assert.equal(env.AWS_S3_ENDPOINT_URL, "http://plane-minio:9000");
    assert.equal(env.MINIO_ENDPOINT, "plane-minio:9000");
    assert.equal(env.AWS_ACCESS_KEY_ID, minio.MINIO_ROOT_USER);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, minio.MINIO_ROOT_PASSWORD);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, values.MINIO_ROOT_PASSWORD);
    assert.deepEqual(services["minio-init"].environment, minio);
    assert.equal(env.AWS_S3_BUCKET_NAME, "uploads");
    assert.equal(env.AWS_REGION, "us-east-1");
    assert.equal(env.USE_MINIO, "1");
    assert.equal(env.SECRET_KEY, values.SECRET_KEY);
    assert.equal(env.LIVE_SERVER_SECRET_KEY, values.LIVE_SERVER_SECRET_KEY);
    for (const name of ["plane-db", "plane-redis", "plane-mq"]) {
      assert.equal(services.plane.depends_on[name].condition, "service_healthy");
      assert.ok(services[name].healthcheck.test.length > 1);
      assert.ok(!services[name].healthcheck.disable);
    }
    assert.equal(services.plane.depends_on["minio-init"].condition, "service_completed_successfully");
    const init = services["minio-init"];
    assert.equal(init.depends_on["plane-minio"].condition, "service_started");
    assert.equal(init.restart, "no");
    assert.deepEqual(init.entrypoint, ["/bin/sh", "-ec"]);
    const command = init.command.join(" ");
    assert.match(command, /mc alias set storage http:\/\/plane-minio:9000/);
    assert.match(command, /mc ready storage/);
    assert.match(command, /mc mb --ignore-existing storage\/uploads/);
    assert.match(command, /mc anonymous set none storage\/uploads/);
    assert.match(command, /exit 1/);
  }
);

test("full Compose preserves public HTTPS origin, nondefault ports and runtime overrides", composeOptions, (t) => {
  const { directory } = deployment(t);
  const overrides = {
    APP_RELEASE: "v1.2.3",
    DOMAIN_NAME: "plane.example.test",
    APP_PROTOCOL: "https",
    WEB_URL: "https://plane.example.test:8443",
    SITE_ADDRESS: ":80",
    MINIO_ENDPOINT_SSL: "1",
    LISTEN_HTTP_PORT: "8080",
    LISTEN_HTTPS_PORT: "8443",
    GUNICORN_WORKERS: "2",
    FILE_SIZE_LIMIT: "10485760",
  };
  const plane = render(directory, overrides).services.plane;
  assert.equal(plane.image, "ghcr.io/dlsinnocence/plane-aio-community:v1.2.3");
  for (const key of [
    "DOMAIN_NAME",
    "APP_PROTOCOL",
    "WEB_URL",
    "SITE_ADDRESS",
    "MINIO_ENDPOINT_SSL",
    "GUNICORN_WORKERS",
    "FILE_SIZE_LIMIT",
  ]) {
    assert.equal(plane.environment[key], overrides[key], key);
  }
  assert.equal(plane.environment.CORS_ALLOWED_ORIGINS, overrides.WEB_URL);
  assert.deepEqual(
    plane.ports.map(({ published, target }) => [published, target]),
    [
      ["8080", 80],
      ["8443", 443],
    ]
  );
});

test("full Compose rejects missing required configuration", composeOptions, (t) => {
  assert.ok(composeAvailable, "Docker Compose is required in CI (or set COMPOSE_BINARY)");
  const { directory, values } = deployment(t);
  for (const key of secretKeys) {
    const incomplete = { ...values };
    delete incomplete[key];
    writeFileSync(
      join(directory, ".env"),
      Object.entries(incomplete)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n")
    );
    const result = run(
      composeCommand,
      [...composeArgs, "-f", "docker-compose.full.yml", "config", "--format", "json"],
      directory
    );
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, `${key} must be required`);
    assert.ok(result.stderr.includes(key), `failure must identify ${key}`);
  }
});

function updateStartup(t, overrides = {}) {
  const directory = temporaryDirectory(t);
  copyFileSync(join(source, "variables.env"), join(directory, "plane.env"));
  const startup = readFileSync(join(source, "start.sh"), "utf8");
  assert.match(startup, /\nmain "\$@"\r?\n?$/);
  const definitions = startup.replace(/\nmain "\$@"\r?\n?$/, "\n");
  const env = {
    DOMAIN_NAME: "plane.example.test",
    DATABASE_URL: "postgresql://plane:test-db@plane-db:5432/plane",
    REDIS_URL: "redis://plane-redis:6379/0",
    AMQP_URL: "amqp://plane:test-mq@plane-mq:5672/plane",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "plane-storage",
    AWS_SECRET_ACCESS_KEY: "test-minio-secret",
    AWS_S3_BUCKET_NAME: "uploads",
    SECRET_KEY: "a".repeat(64),
    LIVE_SERVER_SECRET_KEY: "b".repeat(64),
    ...overrides,
  };
  succeeded(run("bash", ["-e", "-c", `${definitions}\nupdate_env_file\n`], directory, env));
  return { values: parseEnv(readFileSync(join(directory, "plane.env"), "utf8")), env };
}

test("startup persists full-stack storage, public origin and worker settings", (t) => {
  const { values, env } = updateStartup(t, {
    USE_MINIO: "1",
    MINIO_ENDPOINT_SSL: "1",
    AWS_S3_ENDPOINT_URL: "http://plane-minio:9000",
    APP_PROTOCOL: "https",
    WEB_URL: "https://plane.example.test:8443",
    CORS_ALLOWED_ORIGINS: "https://plane.example.test:8443,https://other.example.test",
    GUNICORN_WORKERS: "2",
  });
  for (const key of Object.keys(env)) assert.equal(values[key], env[key], key);
  assert.equal(values.BUCKET_NAME, "uploads");
});

test("startup retains external-storage defaults and derives absent public URLs", (t) => {
  const { values } = updateStartup(t);
  assert.equal(values.USE_MINIO, "0");
  assert.equal(values.MINIO_ENDPOINT_SSL, "0");
  assert.equal(values.APP_PROTOCOL, "http");
  assert.equal(values.WEB_URL, "http://plane.example.test");
  assert.equal(values.CORS_ALLOWED_ORIGINS, "http://plane.example.test,https://plane.example.test");
  assert.equal(values.AWS_S3_ENDPOINT_URL, "https://s3.us-east-1.amazonaws.com");
  assert.equal(values.GUNICORN_WORKERS, "1");
  assert.equal(values.SITE_ADDRESS, ":80");
});

test("Caddy forwards bucket root and objects without stripping paths or replacing signed Host", () => {
  const caddy = readFileSync(join(source, "../../../apps/proxy/Caddyfile.aio.ce"), "utf8");
  const matcher = caddy.match(/@(\w+)\s+path\s+\/\{\$BUCKET_NAME\}\s+\/\{\$BUCKET_NAME\}\/\*/);
  assert.ok(matcher, "bucket root and object paths must share a matcher");
  assert.match(
    caddy,
    new RegExp(`handle\\s+@${matcher[1]}\\s*\\{\\s*reverse_proxy\\s+\\{\\$MINIO_ENDPOINT:plane-minio:9000\\}\\s*\\}`)
  );
  assert.doesNotMatch(caddy, new RegExp(`handle_path\\s+@${matcher[1]}\\b`));
  assert.doesNotMatch(caddy, /header_up\s+Host\b/i);
  assert.ok(caddy.indexOf(`handle @${matcher[1]}`) < caddy.indexOf("handle_path /*"));
});
