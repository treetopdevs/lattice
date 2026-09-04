// Contract for plan 158 "Signed Android Internal Distribution":
// fail-closed external pilot keystore signing, monotonic version codes,
// pilot hardening config, and the dev-only probe lane staying out of the
// pilot artifact path.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse as parseYaml } from "yaml";

const shellRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(shellRoot, relative), "utf8");

const gradle = read("src-tauri/gen/android/app/build.gradle.kts");
const pkg = JSON.parse(read("package.json"));
const workflow = read("../../.github/workflows/flagship.yml");
const workflowDocument = parseYaml(workflow);
const workflowDir = join(shellRoot, "../../.github/workflows");
const workflowSources = Object.fromEntries(
  readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, readFileSync(join(workflowDir, name), "utf8")]),
);
function yamlSourcesUnder(root) {
  if (!existsSync(root)) return {};
  const entries = {};
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) {
      Object.assign(entries, yamlSourcesUnder(path));
    } else if (/\.ya?ml$/.test(name)) {
      entries[path] = readFileSync(path, "utf8");
    }
  }
  return entries;
}
const automationSources = {
  ...workflowSources,
  ...yamlSourcesUnder(join(shellRoot, "../../.github/actions")),
};
const signatureVerifier = read("scripts/android-pilot/verify_apk_signature.mjs");
const manifestEmitter = read("scripts/android-pilot/emit_build_manifest.mjs");
const custodyRunbook = read("../../docs/android_pilot_signing_custody.md");
const { pilotPinStatus, TOWNSHIP_PILOT_CERT_SHA256, TOWNSHIP_PILOT_KEY_ALIAS } = await import(
  "../scripts/android-pilot/pilot_policy.mjs"
);
const { parseApksignerCerts } = await import("../scripts/android-pilot/sdk.mjs");
const { deriveVersionCode, versionCodeFor } = await import("../scripts/android-pilot/version_code.mjs");
const { evaluateSignature, lineagePinFailures, normalizeCertPin } = await import(
  "../scripts/android-pilot/verify_apk_signature.mjs"
);

const DISTRIBUTION_JOB_IF = "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')";

function workflowJob(name) {
  const job = workflowDocument.jobs?.[name];
  assert.ok(job, `${name} workflow job must exist`);
  return job;
}

function workflowSteps(job) {
  assert.ok(Array.isArray(job.steps), "workflow job must have structural steps");
  return job.steps;
}

function workflowIfExpression(node) {
  const raw = node?.if;
  if (!raw) return null;
  return String(raw).replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "").trim();
}

function fakeGit(responses) {
  return (args) => {
    const key = args.join(" ");
    if (!(key in responses)) throw new Error(`unexpected git command: ${key}`);
    const response = responses[key];
    if (response instanceof Error) throw response;
    return response;
  };
}

function isDistributionJobGuarded(job) {
  return workflowIfExpression(job) === DISTRIBUTION_JOB_IF;
}

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
  const gradleAlias = gradle.match(/val townshipPilotAlias = "([^"]+)"/)?.[1];
  const workflowAliases = [...workflow.matchAll(/township-pilot-[A-Za-z0-9-]+/g)].map(([alias]) => alias);
  assert.ok(workflowAliases.length >= 4, "verification and distribution alias sites must be linked");
  assert.equal(gradleAlias, TOWNSHIP_PILOT_KEY_ALIAS);
  assert.match(
    gradle,
    /townshipPilotKeyAlias\s*!=\s*townshipPilotAlias/,
    "gradle must refuse every signing alias except the shared pilot declaration",
  );
  assert.deepEqual([...new Set(workflowAliases)], [TOWNSHIP_PILOT_KEY_ALIAS]);
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

test("the environment certificate copy cannot establish or rotate the pilot trust anchor", () => {
  assert.ok(
    TOWNSHIP_PILOT_CERT_SHA256 == null || /^[0-9a-f]{64}$/.test(TOWNSHIP_PILOT_CERT_SHA256),
    "the reviewed repository pin is either explicitly unprovisioned or a lowercase SHA-256",
  );
  const reviewedPin = "1".repeat(64);
  assert.equal(pilotPinStatus(reviewedPin, reviewedPin), "matched");
  assert.equal(pilotPinStatus("2".repeat(64), reviewedPin), "mismatched");
  assert.equal(pilotPinStatus(reviewedPin, null), "unprovisioned");
  assert.equal(pilotPinStatus("", ""), "unprovisioned");
  assert.equal(pilotPinStatus(reviewedPin, "not-a-fingerprint"), "unprovisioned");
  const job = workflowJob("android_pilot");
  assert.equal(job.outputs.pin_provisioned, "${{ steps.pilot_policy.outputs.provisioned }}");
  const policyStep = workflowSteps(job).find(({ name }) => name === "Read reviewed pilot certificate pin");
  assert.ok(policyStep);
  assert.doesNotMatch(JSON.stringify(policyStep), /secrets\.TOWNSHIP_PILOT_/);
  assert.match(policyStep.run, /TOWNSHIP_PILOT_CERT_SHA256 as pin/);
  assert.match(policyStep.run, /provisioned=true/);
  assert.match(policyStep.run, /provisioned=false/);
  const stepNames = workflowSteps(job).map(({ name }) => name);
  assert.ok(
    stepNames.indexOf("Set up Node") < stepNames.indexOf("Read reviewed pilot certificate pin"),
    "repository policy must execute on the pinned Node runtime",
  );
  const jobCommands = workflowSteps(job).map(({ run }) => run ?? "").join("\n");
  assert.match(jobCommands, /\$PINNED_CERT[^\n]+tr -d ':'[^\n]+tr '.*upper.*' '.*lower.*'[^\n]+\$REPO_PIN/);
  assert.match(jobCommands, /reviewed in-repo pilot certificate pin is not provisioned/i);
});

test("the signature verifier cannot silently skip when invoked through a symlink", () => {
  assert.match(signatureVerifier, /realpathSync\(resolve\(process\.argv\[1\]\)\)/);
  assert.match(signatureVerifier, /pathToFileURL/);
  assert.doesNotMatch(signatureVerifier, /import\.meta\.url\.endsWith/);
  const cert = "ab".repeat(32);
  const colonPin = cert.toUpperCase().match(/.{2}/g).join(":");
  assert.deepEqual(
    evaluateSignature(
      {
        dn: "CN=Township Pilot",
        sha256: cert,
        signerCount: 1,
        completeSignerCount: 1,
        distinctSignerCount: 1,
      },
      { expected: colonPin },
    ),
    [],
  );
});

test("apksigner parsing preserves every signer and refuses co-signing or implicit rotation", () => {
  const single = parseApksignerCerts([
    "Signer #1 certificate DN: CN=Township Pilot, O=Treetop Devs",
    `Signer #1 certificate SHA-256 digest: ${"ab".repeat(32)}`,
  ].join("\n"));
  assert.equal(single.signerCount, 1);
  assert.equal(single.completeSignerCount, 1);
  assert.equal(single.distinctSignerCount, 1);
  assert.equal(single.sha256, "ab".repeat(32));

  const multiple = parseApksignerCerts([
    "Signer #1 certificate DN: CN=Township Pilot",
    `Signer #1 certificate SHA-256 digest: ${"ab".repeat(32)}`,
    "Signer #2 certificate DN: CN=Unexpected Co-Signer",
    `Signer #2 certificate SHA-256 digest: ${"cd".repeat(32)}`,
  ].join("\n"));
  assert.equal(multiple.signerCount, 2);
  assert.equal(multiple.distinctSignerCount, 2);
  assert.equal(multiple.sha256, null, "multi-signer output must not collapse to Signer #1");
  assert.match(
    evaluateSignature(multiple, { expected: "ab".repeat(32) }).join(" "),
    /exactly one distinct signer/,
  );

  const sdkRanged = parseApksignerCerts([
    "Signer (minSdkVersion=24, maxSdkVersion=32) certificate DN: CN=Old Pilot",
    `Signer (minSdkVersion=24, maxSdkVersion=32) certificate SHA-256 digest: ${"12".repeat(32)}`,
    "Signer (minSdkVersion=33, maxSdkVersion=2147483647) certificate DN: CN=New Pilot",
    `Signer (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: ${"34".repeat(32)}`,
  ].join("\n"));
  assert.equal(sdkRanged.signerCount, 2);
  assert.equal(sdkRanged.distinctSignerCount, 2);
  assert.equal(sdkRanged.sha256, null, "rotation needs an explicit reviewed policy");

  const oneCertAcrossRanges = parseApksignerCerts([
    "Signer (minSdkVersion=24, maxSdkVersion=32) certificate DN: CN=Township Pilot",
    `Signer (minSdkVersion=24, maxSdkVersion=32) certificate SHA-256 digest: ${"56".repeat(32)}`,
    "Signer (minSdkVersion=33, maxSdkVersion=2147483647) certificate DN: CN=Township Pilot",
    `Signer (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: ${"56".repeat(32)}`,
  ].join("\n"));
  assert.equal(oneCertAcrossRanges.signerCount, 2);
  assert.equal(oneCertAcrossRanges.completeSignerCount, 2);
  assert.equal(oneCertAcrossRanges.distinctSignerCount, 1);
  assert.equal(oneCertAcrossRanges.sha256, "56".repeat(32));
  assert.deepEqual(
    evaluateSignature(oneCertAcrossRanges, {
      expected: "56".repeat(32),
    }),
    [],
  );
  assert.equal(normalizeCertPin(" : : "), null);
  assert.match(evaluateSignature(single, { expected: " : : " }).join(" "), /no pilot certificate pin/);
  assert.doesNotMatch(signatureVerifier, /allow-unpinned|allowUnpinned/);
  const reviewed = "56".repeat(32);
  assert.deepEqual(lineagePinFailures("pilot", reviewed, reviewed), []);
  assert.match(lineagePinFailures("pilot", "78".repeat(32), reviewed).join(" "), /differs/);
  assert.match(lineagePinFailures("pilot", reviewed, null).join(" "), /not provisioned/);
  assert.deepEqual(lineagePinFailures("ephemeral-ci-throwaway", reviewed, null), []);
});

test("manifest lineage is allowlisted before pilot-specific checks", () => {
  assert.match(manifestEmitter, /\["pilot", "dev-smoke", "ephemeral-ci-throwaway"\]\.includes\(args\.lineage\)/);
  assert.match(manifestEmitter, /throw new Error\(`unknown lineage/);
});

test("direct pilot-secret references exist only inside the protected distribution job", () => {
  const job = workflowJob("android_pilot");
  const jobGuarded = isDistributionJobGuarded(job);
  const secretJobs = Object.entries(workflowDocument.jobs).filter(([, candidate]) =>
    /secrets\.TOWNSHIP_PILOT_/.test(JSON.stringify(candidate)),
  ).map(([name]) => name);
  const secretWorkflowFiles = Object.entries(automationSources)
    .filter(([, source]) => /secrets\.TOWNSHIP_PILOT_/.test(source))
    .map(([name]) => name);
  assert.deepEqual(new Set(secretWorkflowFiles), new Set(["flagship.yml"]));
  for (const [name, source] of Object.entries(automationSources)) {
    assert.doesNotMatch(source, /toJSON\(\s*secrets\s*\)/i, `${name} must not serialize all secrets`);
    assert.doesNotMatch(source, /^\s*secrets:\s*inherit\s*$/im, `${name} must not inherit all secrets`);
  }
  assert.deepEqual(secretJobs, ["android_pilot"]);
  assert.equal(job.environment, "android-pilot");
  assert.deepEqual(job.needs, ["verify", "unit", "packaged_macos", "android_pilot_verify"]);
  assert.deepEqual(job.permissions, { contents: "read" });
  const secretSteps = workflowSteps(job).filter((step) =>
    /secrets\.TOWNSHIP_PILOT_/.test(JSON.stringify(step)),
  );
  assert.deepEqual(
    secretSteps.map(({ name }) => name).sort(),
    [
      "Build signed release APK (pilot path)",
      "Detect pilot signing secrets",
      "Materialize signing key",
    ],
    "the scanner must find every expected pilot-secret consumer",
  );

  assert.equal(jobGuarded, true, "the only secret-bearing job must be distribution-guarded");
  for (const step of secretSteps) {
    const { name } = step;
    if (name === "Detect pilot signing secrets") {
      assert.equal(workflowIfExpression(step), null);
    } else {
      assert.equal(
        workflowIfExpression(step),
        "steps.pilot.outputs.present == 'true'",
        `${name} must not run when pilot inputs are absent`,
      );
    }
  }
});

test("feature-branch version codes can never become distributable before their lower merge code", () => {
  // The historical branch push would have produced 1057 while its eventual
  // merge produced 1055 under a single band. Official main now occupies a
  // disjoint high band, while off-main builds use a branch-monotonic low band.
  const job = workflowJob("android_pilot");
  const upload = workflowSteps(job).find(({ name }) => name === "Upload pilot artifact and manifest");
  assert.ok(upload, "pilot artifact upload step must exist");
  assert.equal(
    isDistributionJobGuarded(job),
    true,
    "the distribution job must accept only main pushes and explicit main-branch dispatches",
  );
  assert.ok(versionCodeFor({ firstParentCount: 55, officialMain: true }) > 999_999);
  assert.ok(
    versionCodeFor({ firstParentCount: 55, officialMain: true }) >
      versionCodeFor({ firstParentCount: 57, officialMain: false }),
  );
  assert.ok(
    versionCodeFor({ firstParentCount: 58, officialMain: false }) >
      versionCodeFor({ firstParentCount: 57, officialMain: false }),
    "successive QA commits remain upgradeable without adb downgrade flags",
  );
  const mainByRef = deriveVersionCode({
    env: { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main" },
    git: fakeGit({
      "rev-parse --is-shallow-repository": "false",
      "rev-list --count --first-parent HEAD": "55",
    }),
  });
  const localMain = deriveVersionCode({
    env: {},
    git: fakeGit({
      "rev-parse --is-shallow-repository": "false",
      "merge-base HEAD origin/main": "base-sha",
      "rev-list --count --first-parent HEAD": "57",
    }),
  });
  const pullRequest = deriveVersionCode({
    env: { GITHUB_REF: "refs/pull/42/merge" },
    git: fakeGit({
      "rev-parse --is-shallow-repository": "false",
      "merge-base HEAD origin/main": "base-sha",
      "rev-list --count --first-parent HEAD": "57",
    }),
  });
  assert.equal(mainByRef, 1_000_055);
  assert.ok(localMain < 1_000_000, "a local main checkout never receives the official band");
  assert.equal(localMain, 1_057);
  assert.equal(pullRequest, localMain);
  const ephemeralOnMain = deriveVersionCode({
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_REF: "refs/heads/main",
      TOWNSHIP_ANDROID_VERSION_BAND: "off-main",
    },
    git: fakeGit({
      "rev-parse --is-shallow-repository": "false",
      "merge-base HEAD origin/main": "base-sha",
      "rev-list --count --first-parent HEAD": "55",
    }),
  });
  assert.equal(ephemeralOnMain, 1_055, "throwaway verification artifacts stay in the low band");
  assert.throws(
    () =>
      deriveVersionCode({
        env: {},
        git: fakeGit({ "rev-parse --is-shallow-repository": "true" }),
      }),
    /shallow repository/,
  );
  assert.throws(
    () =>
      deriveVersionCode({
        env: { GITHUB_REF: "refs/pull/42/merge" },
        git: fakeGit({
          "rev-parse --is-shallow-repository": "false",
          "merge-base HEAD origin/main": new Error("missing"),
          "merge-base HEAD main": new Error("missing"),
        }),
      }),
    /without a merge-base with main/,
  );
  assert.throws(
    () => versionCodeFor({ firstParentCount: 999_000, officialMain: false }),
    /exhausted the low band/,
  );
  assert.throws(
    () => versionCodeFor({ firstParentCount: 2_100_000_000, officialMain: true }),
    /exceeds the Android limit/,
  );
});

test("main pushes and explicit release dispatches fail when distribution does not produce an artifact", () => {
  assert.ok(workflowDocument.on.workflow_dispatch.inputs.require_android_pilot);
  const job = workflowJob("android_pilot");
  const commands = workflowSteps(job).map(({ run }) => run ?? "").join("\n");
  assert.match(commands, /Pilot distribution was required but signing secrets are absent/);
  assert.match(commands, /::warning::Pilot signing secrets absent/);
  const guard = workflowJob("android_pilot_required");
  assert.equal(
    workflowIfExpression(guard),
    "always() && ((github.event_name == 'push' && github.ref == 'refs/heads/main') || inputs.require_android_pilot)",
  );
  assert.equal(guard.needs, "android_pilot");
  assert.equal(guard.env, undefined);
  const requireStep = workflowSteps(guard).find(({ name }) => name === "Require successful distribution");
  assert.equal(requireStep.env.DISTRIBUTION_RESULT, "${{ needs.android_pilot.result }}");
  assert.equal(requireStep.env.DISTRIBUTED, "${{ needs.android_pilot.outputs.distributed }}");
  assert.equal(requireStep.env.PIN_PROVISIONED, "${{ needs.android_pilot.outputs.pin_provisioned }}");
  assert.equal(requireStep.env.REQUIRE_PILOT, "${{ inputs.require_android_pilot || false }}");
  assert.match(requireStep.run, /PIN_PROVISIONED.*!=.*true/);
  assert.match(requireStep.run, /DISTRIBUTION_RESULT.*!=.*success/);
  assert.match(requireStep.run, /DISTRIBUTED.*!=.*true/);
});

test("the pilot contract installs dependencies without registry audit before executing", () => {
  const job = workflowJob("android_pilot_contract");
  const steps = workflowSteps(job);
  const install = steps.findIndex(({ name }) => name === "Install Android pilot contract dependencies");
  const contract = steps.findIndex(({ name }) => name === "Android pilot + harness contracts");
  assert.ok(install >= 0 && install < contract);
  assert.equal(
    steps[install].run,
    "npm --prefix clients/township-tauri-shell ci --no-audit --no-fund",
  );
  assert.equal(job["timeout-minutes"], 15);
  const setup = steps.find(({ name }) => name === "Set up Node");
  assert.equal(setup.with.cache, "npm");
  assert.equal(setup.with["cache-dependency-path"], "clients/township-tauri-shell/package-lock.json");
});

test("secret-free Android verification remains runnable on pull requests", () => {
  const job = workflowJob("android_pilot_verify");
  assert.equal(job.environment, undefined);
  assert.equal(job.if, undefined);
  assert.equal(job.needs, "android_pilot_contract");
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.doesNotMatch(JSON.stringify(job), /secrets\.TOWNSHIP_PILOT_/);
  const evidenceUpload = workflowSteps(job).find(
    ({ name }) => name === "Upload verification evidence (no distribution artifact)",
  );
  assert.ok(evidenceUpload);
  assert.doesNotMatch(JSON.stringify(evidenceUpload), /\.apk(?:\\n|\s|$)/i);
  assert.equal(evidenceUpload.with.path, "output/android-pilot-verification/");
  assert.equal(
    workflowSteps(job).some(({ uses }) => String(uses ?? "").startsWith("actions/cache@")),
    false,
    "verification must not restore a stale Android target tree",
  );
  const ephemeralBuild = workflowSteps(job).find(
    ({ name }) => name === "Build signed release APK (ephemeral verification path)",
  );
  assert.equal(ephemeralBuild.env.TOWNSHIP_ANDROID_VERSION_BAND, "off-main");
  const ephemeralKey = workflowSteps(job).find(
    ({ name }) => name === "Materialize ephemeral verification key",
  );
  assert.match(ephemeralKey.run, /umask 077/);
  assert.doesNotMatch(ephemeralKey.run, /chmod 600/);
});

test("distribution provenance and refusal gates precede artifact upload", () => {
  const job = workflowJob("android_pilot");
  const steps = workflowSteps(job);
  assert.equal(steps.some(({ uses }) => String(uses ?? "").startsWith("actions/cache@")), false);
  const upload = steps.findIndex(({ name }) => name === "Upload pilot artifact and manifest");
  assert.notEqual(upload, -1);
  for (const required of [
    'verify_apk_signature.mjs --apk "$APK"',
    'scan_pilot_artifact.mjs --apk "$APK"',
    'emit_build_manifest.mjs --apk "$APK"',
    "--lineage pilot",
    'cp "$APK" ../../output/android-pilot/app-universal-release.apk',
    "Prove pilot build remains fail-closed without signing inputs",
    'grep -q "TOWNSHIP_PILOT_KEYSTORE_PATH is not set"',
    'grep -q "release signing is fail-closed"',
  ]) {
    const index = steps.findIndex((step) => `${step.name ?? ""}\n${step.run ?? ""}`.includes(required));
    assert.ok(index >= 0 && index < upload, `${required} must run before upload`);
  }
  assert.match(steps.map(({ run }) => run ?? "").join("\n"), /--expected-cert-sha256 "\$PINNED_CERT"/);
  assert.doesNotMatch(JSON.stringify(job), /--allow-unpinned/);
  const uploadStep = steps[upload];
  assert.ok(uploadStep);
  assert.equal(uploadStep.with.path, "output/android-pilot/");
  assert.doesNotMatch(JSON.stringify(uploadStep), /src-tauri\/.*\.apk/);
  const materialize = steps.find(({ name }) => name === "Materialize signing key");
  assert.match(materialize.run, /umask 077/);
  const pilotVerification = steps.find(({ name }) => name === "Verify, scan, and manifest pilot artifact");
  assert.match(pilotVerification.run, /verify_apk_signature\.mjs[^]*--lineage pilot/);
  const pilotRefusal = steps.find(
    ({ name }) => name === "Prove pilot build remains fail-closed without signing inputs",
  );
  assert.match(pilotRefusal.run, /RUNNER_TEMP/);
  assert.doesNotMatch(pilotRefusal.run, /> pilot-refusal\.log/);

  const verify = workflowJob("android_pilot_verify");
  const verifySteps = workflowSteps(verify);
  const verifyUpload = verifySteps.findIndex(({ name }) => name === "Upload verification evidence (no distribution artifact)");
  for (const required of [
    "Build signed release APK (ephemeral verification path)",
    'verify_apk_signature.mjs --apk "$APK"',
    "--lineage ephemeral-ci-throwaway",
    "Prove fail-closed refusal without signing inputs",
    'grep -q "TOWNSHIP_PILOT_KEYSTORE_PATH is not set"',
    'grep -q "release signing is fail-closed"',
  ]) {
    const index = verifySteps.findIndex((step) => `${step.name ?? ""}\n${step.run ?? ""}`.includes(required));
    assert.ok(index >= 0 && index < verifyUpload, `${required} must precede verification upload`);
  }
  const ephemeralVerification = verifySteps.find(
    ({ name }) => name === "Verify ephemeral signing certificate",
  );
  assert.match(
    ephemeralVerification.run,
    /verify_apk_signature\.mjs[^]*--lineage ephemeral-ci-throwaway/,
  );
  const ephemeralRefusal = verifySteps.find(
    ({ name }) => name === "Prove fail-closed refusal without signing inputs",
  );
  assert.match(ephemeralRefusal.run, /RUNNER_TEMP/);
  assert.doesNotMatch(ephemeralRefusal.run, /> pilot-refusal\.log/);
});

test("flagship serializes runs per ref without canceling an in-flight distribution", () => {
  assert.deepEqual(workflowDocument.concurrency, {
    group: "flagship-${{ github.ref }}",
    "cancel-in-progress": false,
  });
  assert.deepEqual(workflowDocument.on.push.branches, ["main"]);
});

test("runbook requires server-side environment protection as the pilot-secret boundary", () => {
  assert.match(custodyRunbook, /MUST[^\n]*deployment branch rule[^\n]*main/i);
  assert.match(custodyRunbook, /plain\s+repository secrets are prohibited/i);
  assert.doesNotMatch(custodyRunbook, /repo secrets are the fallback/i);
  assert.match(custodyRunbook, /pilot-lineage keystore is never committed, never generated on CI/i);
  assert.match(custodyRunbook, /ephemeral-ci-throwaway/);
  for (const pinnedPath of ["docs/android_pilot_*", "docs/android_pilot_*/**", "plans/15[89]-*"]) {
    for (const event of ["push", "pull_request"]) {
      const paths = workflowDocument.on[event].paths;
      assert.ok(paths.indexOf(pinnedPath) > paths.indexOf("!**/*.md"), `${pinnedPath} must be re-included last for ${event}`);
      assert.ok(!paths.includes(`!${pinnedPath}`));
    }
  }
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
