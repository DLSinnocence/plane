import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const source = fileURLToPath(new URL("../", import.meta.url));
const templateFiles = ["variables.env", "docker-compose.yml", "docker-compose.full.yml", "init-stack.sh", "README.md"];
const templates = Object.fromEntries(templateFiles.map((name) => [name, readFileSync(join(source, name), "utf8")]));

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
  assert.deepEqual(readdirSync(release).sort(), [...templateFiles].sort());
  assert.equal(
    readFileSync(join(release, "docker-compose.yml"), "utf8"),
    templates["docker-compose.yml"]
      .replace("APP_RELEASE:-stable", `APP_RELEASE:-${version}`)
      .replace("makeplane/plane-aio-community", imageName)
  );
  assert.equal(
    readFileSync(join(release, "docker-compose.full.yml"), "utf8"),
    templates["docker-compose.full.yml"]
      .replace("APP_RELEASE:-stable", `APP_RELEASE:-${version}`)
      .replace("ghcr.io/dlsinnocence/plane-aio-community", imageName)
  );
  assert.equal(readFileSync(join(release, "init-stack.sh"), "utf8"), templates["init-stack.sh"]);
  const imageEnv = readFileSync(join(dist, "plane.env"), "utf8");
  assert.equal(readFileSync(join(release, "variables.env"), "utf8"), imageEnv);
  const values = parseEnv(imageEnv);
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
    assert.equal(values[key], "", `${key} must be configured by the operator`);
  }
  assert.equal(readFileSync(join(release, "README.md"), "utf8"), templates["README.md"]);
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
  test(`prepare matching AIO image and deployment assets for ${version}`, (t) => {
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

test("regenerating assets replaces the previous release version", (t) => {
  const dist = prepare(t, ["--release=v1.2.3"]);
  prepare(t, ["--release=v1.2.4"], dist);
  checkAssets(dist, "v1.2.4");
});

const composeCommand = process.env.COMPOSE_BINARY ? resolve(process.env.COMPOSE_BINARY) : "docker";
const composeArgs = process.env.COMPOSE_BINARY ? [] : ["compose"];
const composeAvailable = spawnSync(composeCommand, [...composeArgs, "version"]).status === 0;

function renderCompose(release, overrides = {}) {
  return JSON.parse(
    execFileSync(composeCommand, [...composeArgs, "-f", "docker-compose.yml", "config", "--format", "json"], {
      cwd: release,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...overrides },
      encoding: "utf8",
    })
  );
}

test(
  "Compose runs only AIO with persistent data and supports image and port overrides",
  {
    skip: !composeAvailable && process.env.GITHUB_ACTIONS !== "true",
  },
  (t) => {
    const release = join(
      prepare(t, ["--release=v1.2.3"], undefined, { IMAGE_NAMESPACE: "ghcr.io/example-owner" }),
      "release"
    );
    const config = renderCompose(release);
    assert.deepEqual(Object.keys(config.services), ["plane"]);
    const service = config.services.plane;
    assert.equal(service.image, "ghcr.io/example-owner/plane-aio-community:v1.2.3");
    assert.equal(service.restart, "unless-stopped");
    assert.equal(service.tty, true);
    assert.equal(service.environment.DOMAIN_NAME, "localhost");
    assert.equal(service.environment.APP_RELEASE, "v1.2.3");
    assert.equal(service.environment.XDG_DATA_HOME, "/app/data");
    assert.equal(service.environment.XDG_CONFIG_HOME, "/app/data/config");
    assert.deepEqual(
      service.volumes.map(({ type, target }) => [type, target]),
      [
        ["volume", "/app/data"],
        ["volume", "/app/logs"],
      ]
    );
    assert.deepEqual(
      service.ports.map(({ published, target }) => [published, target]),
      [
        ["80", 80],
        ["443", 443],
      ]
    );

    const override = renderCompose(release, {
      APP_RELEASE: "v2.0.0",
      LISTEN_HTTP_PORT: "8080",
      LISTEN_HTTPS_PORT: "8443",
    }).services.plane;
    assert.equal(override.image, "ghcr.io/example-owner/plane-aio-community:v2.0.0");
    assert.deepEqual(
      override.ports.map(({ published, target }) => [published, target]),
      [
        ["8080", 80],
        ["8443", 443],
      ]
    );
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
