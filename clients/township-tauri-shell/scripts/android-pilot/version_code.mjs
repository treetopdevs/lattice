#!/usr/bin/env node
// Prints the monotonic Android versionCode for the current checkout.
//
// The code is the first-parent commit count of HEAD, which increases with
// every commit that reaches main; CI exports it as TOWNSHIP_ANDROID_VERSION_CODE
// for pilot builds. Requires a full clone (fetch-depth: 0 in CI).

import { execFileSync } from "node:child_process";

const count = Number.parseInt(
  execFileSync("git", ["rev-list", "--count", "--first-parent", "HEAD"], { encoding: "utf8" }).trim(),
  10,
);
if (!Number.isInteger(count) || count < 1) {
  console.error("could not derive a version code from git history (shallow clone?)");
  process.exit(1);
}
// Offset keeps every pilot code above any historical hand-set value.
const versionCode = 1000 + count;
if (versionCode > 2_100_000_000) {
  console.error(`version code ${versionCode} exceeds the Android limit`);
  process.exit(1);
}
console.log(String(versionCode));
