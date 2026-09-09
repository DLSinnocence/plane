import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const source = fileURLToPath(new URL("../", import.meta.url));
const templateFiles = ["variables.env", "docker-compose.yml", ".env.example"];
const templates = Object.fromEntries(templateFiles.map((name) => [name, readFileSync(join(source, name), "utf8")]));
const secretKeys = [
  "POSTGRES_PASSWORD",
  "RABBITMQ_PASSWORD",
  "MINIO_ROOT_PASSWORD",
  "SECRET_KEY",
  "LIVE_SERVER_SECRET_KEY",
];

function prepare(t, args, dist, overrides = {}) {
  if (!dist) {
    dist = mkdtempSync(join(tmpdir(), "plane-aio-release-"));
    t.after(() => rmSync(dist, { recursive: true, force: true }));
  }
  const env = { ...process.env, DIST_DIR: dist, IMAGE_NAMESPACE: "makeplane", IMAGE_NAME: "", ...overrides };
  delete env.APP_RELEASE_VERSION;
  const output = execFileSync("bash", [join(source, "build.sh"), ...args], { env, encoding: "utf8", stdio: "pipe" });
  assert.ok(output.includes(`--build-arg IMAGE_NAMESPACE=${env.IMAGE_NAMESPACE}`));
  return dist;
}

function checkAssets(dist, version, imageName = "makeplane/plane-aio-community") {
  const release = join(dist, "release");
  assert.deepEqual(readdirSync(release).sort(), [".env", "docker-compose.yml"]);
  assert.equal(
    readFileSync(join(release, "docker-compose.yml"), "utf8"),
    templates["docker-compose.yml"]
      .replace("APP_RELEASE:-preview", `APP_RELEASE:-${version}`)
      .replace("ghcr.io/dlsinnocence/plane-aio-community", imageName)
  );
  const deploymentEnv = readFileSync(join(release, ".env"), "utf8");
  assert.equal(deploymentEnv, templates[".env.example"].replace("APP_RELEASE=preview", `APP_RELEASE=${version}`));
  const deploymentValues = parseEnv(deploymentEnv);
  assert.equal(deploymentValues.APP_RELEASE, version);
  for (const key of secretKeys) assert.equal(deploymentValues[key], "", `${key} must never be published with a value`);

  const values = parseEnv(readFileSync(join(dist, "plane.env"), "utf8"));
  for (const key of ["APP_RELEASE", "APP_RELEASE_VERSION", "APP_VERSION"]) {
    assert.equal(values[key], version, key);
  }
  assert.equal(values.DOMAIN_NAME, "localhost");
  assert.equal(values.API_BASE_URL, "http://localhost:3004");
  assert.equal(values.SITE_ADDRESS, ":80");
  for (const key of [
    "DATABASE_URL",
    "REDIS_URL",
    "AMQP_URL",
    "AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_S3_BUCKET_NAME",
  ]) {
    assert.equal(values[key], "", `${key} must be supplied at runtime`);
  }
  assert.equal(
    readFileSync(join(dist, "Caddyfile"), "utf8"),
    readFileSync(join(source, "../../../apps/proxy/Caddyfile.aio.ce"), "utf8")
  );
  for (const name of templateFiles) {
    assert.equal(readFileSync(join(source, name), "utf8"), templates[name], `source ${name} must not change`);
  }
}

for (const [version, args] of [
  ["v1.2.3", ["--release", "v1.2.3"]],
  ["v1.2.3-rc-1", ["--release=v1.2.3-rc-1"]],
  ["preview", ["--release", "preview"]],
]) {
  test(`prepare exactly two matching deployment files for ${version}`, (t) => {
    checkAssets(prepare(t, args), version);
  });
}

test("GHCR release assets point to the publisher namespace", (t) => {
  const dist = prepare(t, ["--release=v1.2.3"], undefined, { IMAGE_NAMESPACE: "ghcr.io/example-owner" });
  checkAssets(dist, "v1.2.3", "ghcr.io/example-owner/plane-aio-community");
});

test("an explicit image name is used in published deployment assets", (t) => {
  const imageName = "ghcr.io/example-owner/custom-aio";
  const dist = prepare(t, ["--release=v1.2.3", `--image-name=${imageName}`], undefined, {
    IMAGE_NAMESPACE: "ghcr.io/example-owner",
  });
  checkAssets(dist, "v1.2.3", imageName);
});

test("regenerating assets replaces the version and removes obsolete deployment files", (t) => {
  const dist = prepare(t, ["--release=v1.2.3"]);
  writeFileSync(join(dist, "release", "obsolete-setup.sh"), "obsolete");
  prepare(t, ["--release=v1.2.4"], dist);
  checkAssets(dist, "v1.2.4");
});

test("deployment credentials in the build environment cannot leak into release assets", (t) => {
  const overrides = Object.fromEntries(secretKeys.map((key, index) => [key, `private-build-value-${index}`]));
  const dist = prepare(t, ["--release=v1.2.3"], undefined, overrides);
  checkAssets(dist, "v1.2.3");
});

const composeCommand = process.env.COMPOSE_BINARY ? resolve(process.env.COMPOSE_BINARY) : "docker";
const composeArgs = process.env.COMPOSE_BINARY ? [] : ["compose"];
const composeAvailable = spawnSync(composeCommand, [...composeArgs, "version"]).status === 0;

function renderCompose(release, overrides = {}) {
  return JSON.parse(
    execFileSync(composeCommand, [...composeArgs, "config", "--format", "json"], {
      cwd: release,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...overrides },
      encoding: "utf8",
    })
  );
}

test(
  "release deploys from only docker-compose.yml and a completed .env with default discovery",
  { skip: !composeAvailable && process.env.GITHUB_ACTIONS !== "true" },
  (t) => {
    const release = join(
      prepare(t, ["--release=v1.2.3"], undefined, { IMAGE_NAMESPACE: "ghcr.io/example-owner" }),
      "release"
    );
    const envPath = join(release, ".env");
    let env = readFileSync(envPath, "utf8");
    const values = Object.fromEntries(secretKeys.map((key, index) => [key, String(index + 1).repeat(64)]));
    for (const [key, value] of Object.entries(values)) env = env.replace(`${key}=\n`, `${key}=${value}\n`);
    writeFileSync(envPath, env);

    assert.deepEqual(readdirSync(release).sort(), [".env", "docker-compose.yml"]);
    const config = renderCompose(release);
    assert.deepEqual(Object.keys(config.services).sort(), [
      "minio-init",
      "plane",
      "plane-db",
      "plane-minio",
      "plane-mq",
      "plane-redis",
    ]);
    const service = config.services.plane;
    assert.equal(service.image, "ghcr.io/example-owner/plane-aio-community:v1.2.3");
    assert.equal(service.environment.SECRET_KEY, values.SECRET_KEY);
    assert.equal(service.environment.LIVE_SERVER_SECRET_KEY, values.LIVE_SERVER_SECRET_KEY);
    assert.equal(config.networks.default.driver, "bridge");
    for (const [name, entry] of Object.entries(config.services)) {
      assert.equal(entry.network_mode, undefined);
      if (name !== "plane") assert.ok(!entry.ports?.length);
    }
    assert.deepEqual(
      service.ports.map(({ published, target }) => [published, target]),
      [["8080", 80]]
    );

    const override = renderCompose(release, {
      APP_RELEASE: "v2.0.0",
      LISTEN_HTTP_PORT: "18080",
      LISTEN_HTTPS_PORT: "8443",
      WEB_URL: "https://plane.example.test:8443",
      APP_PROTOCOL: "https",
    }).services.plane;
    assert.equal(override.image, "ghcr.io/example-owner/plane-aio-community:v2.0.0");
    assert.deepEqual(
      override.ports.map(({ published, target }) => [published, target]),
      [["18080", 80]]
    );
    assert.equal(override.environment.WEB_URL, "https://plane.example.test:8443");
    assert.equal(override.environment.APP_PROTOCOL, "https");
    assert.equal(override.environment.SITE_ADDRESS, ":80");
    assert.ok(!Object.hasOwn(override.environment, "LISTEN_HTTPS_PORT"));
  }
);

test("missing release version fails before preparing assets", (t) => {
  assert.throws(
    () => prepare(t, []),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stdout.toString(), /--release=<APP_RELEASE_VERSION>/);
      return true;
    }
  );
});
