import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../../workflows/build-branch.yml", import.meta.url), "utf8");
const setupStep = workflow.match(
  /      - id: set_env_variables\n[\s\S]*?        run: \|\n([\s\S]*?)(?=      - id: checkout_files)/
);
assert.ok(setupStep, "the workflow must expose its setup script");
const setupScript = setupStep[1].replace(/^ {10}/gm, "");

function setup(
  t,
  {
    event = "workflow_dispatch",
    branch = "preview",
    aio = "false",
    buildType = "Build",
    prerelease = "false",
    arm64 = "false",
  } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), "plane-branch-setup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "output");
  const values = {
    TARGET_BRANCH: branch,
    ARM64_BUILD: arm64,
    BUILD_TYPE: buildType,
    RELEASE_VERSION: prerelease === "true" ? "v1.2.3-rc-1" : "v1.2.3",
    IS_PRERELEASE: prerelease,
    AIO_BUILD: aio,
  };
  // Execute the real workflow shell step, substituting only its input values.
  const script = setupScript.replace(/\$\{\{\s*env\.(\w+)\s*\}\}/g, (_, key) => {
    assert.ok(Object.hasOwn(values, key), `unhandled workflow input ${key}`);
    return values[key];
  });
  assert.doesNotMatch(script, /\$\{\{/);
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      GITHUB_EVENT_NAME: event,
      GITHUB_REPOSITORY_OWNER: "DLSinnocence",
      GITHUB_OUTPUT: output,
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return Object.fromEntries(
    readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

for (const branch of ["preview", "canary"]) {
  test(`${branch} push enables AIO without workflow-dispatch inputs`, (t) => {
    const output = setup(t, { event: "push", branch, aio: "", buildType: "", prerelease: "", arm64: "" });
    assert.equal(output.AIO_BUILD, "true");
    assert.equal(output.BUILD_RELEASE, "false");
    assert.equal(output.TARGET_BRANCH, branch);
    assert.equal(output.EXPECTED_PLATFORMS, "linux/amd64");
    assert.equal(output.IMAGE_NAMESPACE, "ghcr.io/dlsinnocence");
  });
}

for (const aio of ["false", "true"]) {
  test(`manual Build respects aio_build=${aio}`, (t) => {
    const output = setup(t, { aio });
    assert.equal(output.AIO_BUILD, aio);
    assert.equal(output.BUILD_RELEASE, "false");
  });
}

test("manual ARM64 AIO builds retain both native architectures", (t) => {
  const output = setup(t, { aio: "true", arm64: "true" });
  assert.equal(output.AIO_BUILD, "true");
  assert.equal(output.EXPECTED_PLATFORMS, "linux/amd64,linux/arm64");
});

for (const prerelease of ["false", "true"]) {
  test(`Release always enables AIO (prerelease=${prerelease})`, (t) => {
    const output = setup(t, { buildType: "Release", aio: "false", prerelease });
    assert.equal(output.AIO_BUILD, "true");
    assert.equal(output.BUILD_RELEASE, "true");
    assert.equal(output.BUILD_PRERELEASE, prerelease);
    assert.equal(output.RELEASE_VERSION, prerelease === "true" ? "v1.2.3-rc-1" : "v1.2.3");
  });
}
