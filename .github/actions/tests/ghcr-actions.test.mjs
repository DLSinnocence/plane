import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeTags,
  digestSources,
  mergeManifest,
  parsePlatforms,
  validateDigest,
  validateImageRef,
  verifyPlatforms,
} from "../merge-manifest/merge.mjs";
import { exportDigest, validateBuildInputs } from "../build-push/validate.mjs";

const imageRef = "ghcr.io/dlsinnocence/plane-frontend";
const files = ["a".repeat(64), "b".repeat(64)];
const expected = ["linux/amd64", "linux/arm64"];
const raw = (platforms = expected) =>
  JSON.stringify({
    manifests: platforms.map((p) => {
      const [os, architecture] = p.split("/");
      return { platform: { os, architecture } };
    }),
  });
const config = { imageRef, branch: "preview", expectedPlatforms: expected.join(",") };

test("branch tag policy preserves master special case and sanitization", () => {
  for (const [branch, tag] of [
    ["master", "latest"],
    ["main", "main"],
    ["preview", "preview"],
    ["canary", "canary"],
    ["feat/PAI_123-test", "featPAI123-test"],
  ]) {
    assert.deepEqual(computeTags({ imageRef, branch }), [`${imageRef}:${tag}`]);
  }
  assert.deepEqual(computeTags({ imageRef, branch: "preview", buildPrerelease: "true" }), [`${imageRef}:preview`]);
});

test("formal releases retain v and add stable, never latest", () => {
  assert.deepEqual(computeTags({ imageRef, buildRelease: "true", releaseVersion: "v1.2.3" }), [
    `${imageRef}:v1.2.3`,
    `${imageRef}:stable`,
  ]);
  assert.deepEqual(
    computeTags({ imageRef, buildRelease: "true", buildPrerelease: "true", releaseVersion: "v1.2.3-alpha-1" }),
    [`${imageRef}:v1.2.3-alpha-1`]
  );
});

test("invalid versions, branches and repositories are rejected", () => {
  for (const releaseVersion of ["1.2.3", "v1.2", "v1.2.3+build", "v1.2.3-", "v1.2.3;echo bad"]) {
    assert.throws(() => computeTags({ imageRef, buildRelease: "true", releaseVersion }));
  }
  for (const branch of ["", "/_", "-bad", "x".repeat(129)]) assert.throws(() => computeTags({ imageRef, branch }));
  for (const ref of [
    "makeplane/plane",
    "ghcr.io/DLSinnocence/plane",
    `${imageRef}:tag`,
    `${imageRef}@sha256:abc`,
    `${imageRef},push=false`,
  ])
    assert.throws(() => validateImageRef(ref));
});

test("platform declarations require unique native Linux architectures", () => {
  assert.deepEqual(parsePlatforms("linux/amd64"), ["linux/amd64"]);
  for (const value of ["", "linux/amd64,linux/amd64", "windows/amd64", "linux/arm/v7", "linux/amd64,"])
    assert.throws(() => parsePlatforms(value));
});

test("digest sources reject empty, malformed, duplicate and incomplete inputs", () => {
  assert.equal(validateDigest(`sha256:${files[0]}`), `sha256:${files[0]}`);
  for (const digest of ["", "sha512:" + files[0], "sha256:../bad", "sha256:" + "A".repeat(64)])
    assert.throws(() => validateDigest(digest));
  for (const names of [[], [files[0]], [files[0], files[0]], [files[0], "not-a-digest"], [...files, "c".repeat(64)]]) {
    assert.throws(() => digestSources(imageRef, names, expected));
  }
  assert.deepEqual(
    digestSources(imageRef, [...files].reverse(), expected),
    files.map((f) => `${imageRef}@sha256:${f}`)
  );
});

test("raw verification requires an exact, nonduplicate platform set", () => {
  assert.deepEqual(verifyPlatforms(raw(), expected), expected);
  for (const value of [
    "bad json",
    "{}",
    raw([]),
    raw(["linux/amd64"]),
    raw(["linux/amd64", "linux/amd64"]),
    raw([...expected, "linux/s390x"]),
    raw(["windows/amd64", "linux/arm64"]),
    JSON.stringify({ manifests: [{}] }),
  ]) {
    assert.throws(() => verifyPlatforms(value, expected));
  }
  const index = JSON.parse(raw());
  index.manifests[1].platform.variant = "v8";
  verifyPlatforms(index, expected);
  index.manifests[1].platform.variant = "v9";
  assert.throws(() => verifyPlatforms(index, expected));
});

test("merge dry-runs before publishing and inspects each release tag as raw JSON", () => {
  const calls = [];
  const tags = mergeManifest({ ...config, buildRelease: "true", releaseVersion: "v1.2.3" }, files, (args) => {
    calls.push(args);
    return raw();
  });
  const create = [
    "buildx",
    "imagetools",
    "create",
    "-t",
    `${imageRef}:v1.2.3`,
    "-t",
    `${imageRef}:stable`,
    ...files.map((f) => `${imageRef}@sha256:${f}`),
  ];
  assert.deepEqual(calls, [
    [...create, "--dry-run"],
    create,
    ...tags.map((tag) => ["buildx", "imagetools", "inspect", "--raw", tag]),
  ]);
});

test("invalid artifacts prevent all Docker commands", () => {
  let calls = 0;
  assert.throws(() =>
    mergeManifest(config, [files[0]], () => {
      calls++;
      return raw();
    })
  );
  assert.equal(calls, 0);
});

test("incomplete proposed index prevents publication", () => {
  const calls = [];
  assert.throws(() =>
    mergeManifest(config, files, (args) => {
      calls.push(args);
      return raw(["linux/amd64"]);
    })
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at(-1), "--dry-run");
});

test("post-publication mismatch and Docker failures propagate", () => {
  let calls = 0;
  assert.throws(() => mergeManifest(config, files, () => (++calls === 3 ? raw(["linux/amd64"]) : raw())));
  assert.equal(calls, 3);
  assert.throws(
    () =>
      mergeManifest(config, files, () => {
        throw new Error("registry unavailable");
      }),
    /registry unavailable/
  );
});

test("single architecture uses the same verified merge contract", () => {
  const tags = mergeManifest({ ...config, expectedPlatforms: "linux/amd64" }, [files[0]], () => raw(["linux/amd64"]));
  assert.deepEqual(tags, [`${imageRef}:preview`]);
});

test("native build validation requires matching cache suffix and paired assets", () => {
  const env = {
    IMAGE_REF: imageRef,
    PLATFORM: "linux/amd64",
    CACHE_SUFFIX: "-amd64",
    ARTIFACT_NAME: "digest-web-amd64",
    ASSETS: "",
    ASSETS_DIR: "",
  };
  validateBuildInputs(env);
  validateBuildInputs({ ...env, ASSETS: "aio-assets-dist", ASSETS_DIR: "./dist" });
  for (const changes of [
    { PLATFORM: expected.join(",") },
    { CACHE_SUFFIX: "-arm64" },
    { ARTIFACT_NAME: "" },
    { ASSETS: "assets" },
    { ASSETS_DIR: "./dist" },
  ])
    assert.throws(() => validateBuildInputs({ ...env, ...changes }));
});

test("digest export writes only a valid sha256 basename", () => {
  const directory = mkdtempSync(join(tmpdir(), "plane-digest-test-"));
  try {
    assert.throws(() => exportDigest("sha256:../escape", directory));
    assert.deepEqual(readdirSync(directory), []);
    exportDigest(`sha256:${files[0]}`, directory);
    assert.deepEqual(readdirSync(join(directory, "digests")), [files[0]]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("action wiring retains native digest, GHCR and artifact contracts", () => {
  const build = readFileSync(new URL("../build-push/action.yml", import.meta.url), "utf8");
  const merge = readFileSync(new URL("../merge-manifest/action.yml", import.meta.url), "utf8");
  for (const action of [build, merge]) {
    assert.match(action, /registry: ghcr\.io/);
    assert.match(action, /password: \$\{\{ github\.token \}\}/);
    assert.match(action, /driver: docker-container/);
    assert.doesNotMatch(action, /actions\/checkout|dockerhub|private-registry|cloud/);
  }
  assert.match(build, /push-by-digest=true,name-canonical=true,push=true/);
  assert.match(build, /provenance: false/);
  assert.match(build, /push: false/);
  assert.match(build, /org\.opencontainers\.image\.source=/);
  assert.match(build, /org\.opencontainers\.image\.revision=/);
  assert.match(build, /retention-days: 1/);
  assert.match(build, /if-no-files-found: error/);
  assert.match(build, /buildcache\$\{\{ inputs\.cache-scope-suffix \}\},mode=max/);
  assert.match(merge, /merge-multiple: true/);
});
