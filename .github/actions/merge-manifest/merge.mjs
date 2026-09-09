import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

export function validateImageRef(imageRef) {
  if (!/^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(imageRef)) {
    throw new Error("Expected an untagged lowercase ghcr.io/<owner>/<image> reference");
  }
  return imageRef;
}

export function validateDigest(digest) {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`Invalid sha256 digest: ${digest}`);
  return digest;
}

export function parsePlatforms(value) {
  const platforms = value.split(",");
  if (!platforms.length || platforms.some((p) => !/^linux\/(amd64|arm64)$/.test(p))) {
    throw new Error("Expected native linux/amd64 or linux/arm64 platforms");
  }
  if (new Set(platforms).size !== platforms.length) throw new Error("Duplicate expected platforms");
  return platforms;
}

export function computeTags({
  imageRef,
  buildRelease = "false",
  buildPrerelease = "false",
  releaseVersion = "latest",
  branch = "",
}) {
  validateImageRef(imageRef);
  if (buildRelease === "true") {
    if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*)?$/.test(releaseVersion)) {
      throw new Error("Invalid release version");
    }
    return [releaseVersion, ...(buildPrerelease === "true" ? [] : ["stable"])].map((tag) => `${imageRef}:${tag}`);
  }
  const tag = branch === "master" ? "latest" : branch.replace(/[^a-zA-Z0-9.-]/g, "");
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(tag)) throw new Error("Invalid sanitized branch tag");
  return [`${imageRef}:${tag}`];
}

export function digestSources(imageRef, files, expectedPlatforms) {
  validateImageRef(imageRef);
  if (!files.length) throw new Error("No digest artifacts found");
  const digests = files.map((file) => validateDigest(`sha256:${file}`));
  if (new Set(digests).size !== digests.length) throw new Error("Duplicate digests");
  if (digests.length !== expectedPlatforms.length) throw new Error("Digest count does not match expected platforms");
  return digests.sort().map((digest) => `${imageRef}@${digest}`);
}

export function verifyPlatforms(raw, expected) {
  const manifest = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(manifest?.manifests) || !manifest.manifests.length)
    throw new Error("Expected a nonempty manifest index");
  const actual = manifest.manifests.map(({ platform }) => {
    if (!platform?.os || !platform?.architecture) throw new Error("Manifest entry has no platform");
    // arm64/v8 is the standard arm64 descriptor and matches linux/arm64.
    if (platform.variant && !(platform.architecture === "arm64" && platform.variant === "v8")) {
      throw new Error(`Unexpected platform variant: ${platform.variant}`);
    }
    return `${platform.os}/${platform.architecture}`;
  });
  if (
    new Set(actual).size !== actual.length ||
    actual.length !== expected.length ||
    expected.some((p) => !actual.includes(p))
  ) {
    throw new Error(`Platform mismatch: expected ${expected.join(",")}; got ${actual.join(",")}`);
  }
  return actual;
}

export function mergeManifest(config, files, run = (args) => execFileSync("docker", args, { encoding: "utf8" })) {
  const expected = parsePlatforms(config.expectedPlatforms);
  const tags = computeTags(config);
  const sources = digestSources(config.imageRef, files, expected);
  const args = ["buildx", "imagetools", "create", ...tags.flatMap((tag) => ["-t", tag]), ...sources];
  // Inspect the proposed index before publishing any tags, then verify every tag.
  verifyPlatforms(run([...args, "--dry-run"]), expected);
  run(args);
  for (const tag of tags) verifyPlatforms(run(["buildx", "imagetools", "inspect", "--raw", tag]), expected);
  return tags;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const files = readdirSync(join(env.RUNNER_TEMP, "digests"));
  const tags = mergeManifest(
    {
      imageRef: env.IMAGE_REF,
      buildRelease: env.BUILD_RELEASE,
      buildPrerelease: env.BUILD_PRERELEASE,
      releaseVersion: env.RELEASE_VERSION,
      branch: env.TARGET_BRANCH,
      expectedPlatforms: env.EXPECTED_PLATFORMS,
    },
    files
  );
  console.log(`Published and verified: ${tags.join(", ")}`);
}
