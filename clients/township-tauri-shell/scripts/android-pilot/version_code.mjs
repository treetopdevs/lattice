#!/usr/bin/env node
// Prints an Android versionCode that cannot make an off-main QA build newer
// than the next official main build. Official builds occupy a high band;
// off-main verification builds use their own first-parent count in a low band.
// Codes are monotonic along a branch, but different branches can share a code;
// git SHA and APK SHA-256 are the exact build identity.
// Requires a full clone (fetch-depth: 0 in CI).

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OFF_MAIN_OFFSET = 1_000;
const MAIN_OFFSET = 1_000_000;

export function versionCodeFor({ firstParentCount, officialMain }) {
  if (!Number.isInteger(firstParentCount) || firstParentCount < 1) {
    throw new Error("could not derive a version code from git history (shallow clone?)");
  }
  const versionCode = (officialMain ? MAIN_OFFSET : OFF_MAIN_OFFSET) + firstParentCount;
  if (!officialMain && versionCode >= MAIN_OFFSET) {
    throw new Error(`off-main version code ${versionCode} exhausted the low band`);
  }
  if (versionCode > 2_100_000_000) {
    throw new Error(`version code ${versionCode} exceeds the Android limit`);
  }
  return versionCode;
}

function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

export function deriveVersionCode({ env = process.env, git = runGit } = {}) {
  if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
    throw new Error("cannot derive an Android version code from a shallow repository");
  }
  const forceOffMain = env.TOWNSHIP_ANDROID_VERSION_BAND === "off-main";
  const officialMain = !forceOffMain && env.GITHUB_ACTIONS === "true" && env.GITHUB_REF === "refs/heads/main";
  let mergeBase = officialMain ? "HEAD" : null;
  if (!officialMain) {
    for (const candidate of ["origin/main", "main"]) {
      try {
        mergeBase = git(["merge-base", "HEAD", candidate]);
        break;
      } catch {
        // Try the next local representation of main.
      }
    }
  }
  if (!mergeBase) {
    throw new Error("cannot derive an off-main version code without a merge-base with main");
  }
  const firstParentCount = Number.parseInt(
    git(["rev-list", "--count", "--first-parent", "HEAD"]),
    10,
  );
  return versionCodeFor({ firstParentCount, officialMain });
}

const invokedAsMain = process.argv[1]
  ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url
  : false;
if (invokedAsMain) {
  try {
    console.log(String(deriveVersionCode()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
