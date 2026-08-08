// Contract for plan 158 "Signed Android Internal Distribution":
// fail-closed external pilot keystore signing, monotonic version codes,
// pilot hardening config, and the dev-only probe lane staying out of the
// pilot artifact path.

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const shellRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(shellRoot, relative), "utf8");

const gradle = read("src-tauri/gen/android/app/build.gradle.kts");
const pkg = JSON.parse(read("package.json"));

function extractReleaseBlock(source) {
  const start = source.indexOf('getByName("release")');
  assert.notEqual(start, -1, "release build type must exist");
  let depth = 0;
  let index = source.indexOf("{", start);
  const blockStart = index;
  do {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    index += 1;
  } while (depth > 0 && index < source.length);
  return source.slice(blockStart, index);
}

test("release build type never falls back to the debug certificate", () => {
  const release = extractReleaseBlock(gradle);
  assert.doesNotMatch(
    release,
    /signingConfigs\.getByName\("debug"\)\s*$|signingConfig = signingConfigs\.getByName\("debug"\)\s*\n/,
    "release signing must not silently use the debug keystore",
  );
});

test("gradle pins the township pilot alias and fail-closed signing mode", () => {
  assert.match(gradle, /township-pilot-v1/, "pilot alias township-pilot-v1 must be pinned");
  assert.match(gradle, /TOWNSHIP_ANDROID_SIGNING/, "explicit signing mode env must gate release packaging");
  assert.match(gradle, /fail-closed/i, "fail-closed default must be documented in the refusal message");
});

test("gradle refuses cross-product aliases and seeded probe environments in pilot mode", () => {
  assert.match(gradle, /cross-product/i, "cross-product alias refusal must be explicit");
  assert.match(gradle, /VITE_TOWNSHIP_/, "pilot signing must refuse seeded VITE_TOWNSHIP_* env");
});

test("gradle supports a monotonic version code override", () => {
  assert.match(gradle, /TOWNSHIP_ANDROID_VERSION_CODE/, "version code override env must exist");
});

test("the release build script is the pilot lane", () => {
  const release = pkg.scripts["tauri:android:build:release"];
  assert.match(release, /TOWNSHIP_ANDROID_SIGNING=pilot/, "release build must request pilot signing");
  assert.match(release, /tauri\.pilot\.conf\.json/, "release build must apply the pilot hardening config");
});

test("every non-pilot android release build script is explicitly dev-smoke", () => {
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name === "tauri:android:build:release") continue;
    if (!command.includes("tauri android build")) continue;
    if (command.includes("--debug")) continue;
    assert.match(
      command,
      /TOWNSHIP_ANDROID_SIGNING=dev-smoke/,
      `${name} builds a release APK and must opt in to dev-smoke signing explicitly`,
    );
  }
});

test("pilot tauri config carries a real CSP with WSS-only non-loopback transport", async () => {
  const path = join(shellRoot, "src-tauri/tauri.pilot.conf.json");
  assert.ok(existsSync(path), "src-tauri/tauri.pilot.conf.json must exist");
  const conf = JSON.parse(readFileSync(path, "utf8"));
  const csp = conf?.app?.security?.csp;
  const { cspPolicyFailures } = await import("../scripts/android-pilot/pilot_policy.mjs");
  assert.deepEqual(cspPolicyFailures(csp), [], "pilot CSP must pass the policy check");
  assert.match(conf?.build?.beforeBuildCommand ?? "", /build:pilot/, "pilot build must use the pilot frontend build");
});

test("pilot frontend build compiles out probe modules", () => {
  assert.ok(existsSync(join(shellRoot, "vite.pilot.config.ts")), "vite.pilot.config.ts must exist");
  const viteConfig = read("vite.pilot.config.ts");
  assert.match(viteConfig, /pilot_probe_stubs/, "probe modules must be aliased to inert stubs");
  const stub = read("scripts/android-pilot/pilot_probe_stubs.ts");
  for (const exportName of [
    "createTownshipCanonicalProbeDeepLinkListener",
    "logTownshipCanonicalProbe",
    "parseTownshipCanonicalProbeDeepLink",
    "logTownshipReleaseBeamProbeFromEnv",
    "logTownshipReleaseAuthorProbeFromEnv",
    "logTownshipReleaseRootOriginationProbeFromEnv",
    "townshipReleaseRootOriginationProbeConfigFromEnv",
    "logTownshipReleaseOnboardingProbeFromEnv",
    "townshipReleaseOnboardingProbeConfigFromEnv",
    "logTownshipReleasePairingProbeFromEnv",
    "townshipReleasePairingProbeConfigFromEnv",
    "logTownshipReleaseSyncProbeFromEnv",
    "logTownshipReleaseTransportProbesFromEnv",
    "TOWNSHIP_IOS_KEY_REUSE_CONTROL_KEY_ID",
    "logTownshipIosKeyReuseProbeFromEnv",
    "townshipIosKeyReuseProbeEnabled",
    "runTownshipPackagedOnboardingFromEnv",
  ]) {
    assert.match(stub, new RegExp(`export (const|function|async function|type) ${exportName}`), `stub must export ${exportName}`);
  }
});

test("release network security config keeps cleartext loopback-only", () => {
  const xml = read("src-tauri/gen/android/app/src/main/res/xml/township_release_network_security_config.xml");
  assert.match(xml, /<base-config cleartextTrafficPermitted="false"/);
  for (const match of xml.matchAll(/<domain [^>]*>([^<]+)<\/domain>/g)) {
    assert.ok(
      ["127.0.0.1", "localhost"].includes(match[1]),
      `cleartext exception must be loopback-only, found ${match[1]}`,
    );
  }
});
