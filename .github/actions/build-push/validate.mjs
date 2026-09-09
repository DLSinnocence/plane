import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parsePlatforms, validateDigest, validateImageRef } from "../merge-manifest/merge.mjs";

export function validateBuildInputs(env) {
  validateImageRef(env.IMAGE_REF);
  const platforms = parsePlatforms(env.PLATFORM);
  if (platforms.length !== 1) throw new Error("Build exactly one native platform per job");
  if (env.CACHE_SUFFIX !== `-${platforms[0].split("/")[1]}`)
    throw new Error("Cache suffix must match native architecture");
  if (!env.ARTIFACT_NAME?.trim()) throw new Error("A unique digest artifact name is required");
  if (Boolean(env.ASSETS) !== Boolean(env.ASSETS_DIR))
    throw new Error("Additional asset name and directory must be supplied together");
}

export function exportDigest(digest, runnerTemp) {
  validateDigest(digest);
  const directory = join(runnerTemp, "digests");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, digest.slice("sha256:".length)), "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "export") exportDigest(process.env.DIGEST, process.env.RUNNER_TEMP);
  else validateBuildInputs(process.env);
}
