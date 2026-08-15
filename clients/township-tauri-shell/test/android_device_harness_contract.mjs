// Contract for the non-destructive Device A harness baseline (plan 158
// "Physical Device Acceptance Harness", Wave A1 slice): ANDROID_SERIAL
// selection, adb-reverse fail-closed release policy, signer-mismatch stop
// with operator approval, redacted evidence, and a bundle keyed by
// git SHA + APK hash. The harness never uninstalls, never clears app data,
// and never deletes an adb reverse mapping it did not create.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const {
  classifyNetworkClass,
  decideInstallAction,
  evidenceKey,
  installOutcome,
  parseReverseList,
  redactEvidenceText,
  redactSerial,
  runDeviceAHarness,
} = await import("../harness/device_a_lib.mjs");
const { createDeviceDeps, harnessOptions, parseArgs } = await import("../harness/android_device_a.mjs");
const { pilotPinStatus, TOWNSHIP_PACKAGE_ID } = await import("../scripts/android-pilot/pilot_policy.mjs");

const SERIAL = "1A2B3C4D5E6F";
const PILOT_CERT = "f05d98afdda542d84e20e3bc451a22f12d63ed52d53032ddef2538137435fbab";
const DEBUG_CERT = "5c5ee033b521ff3977d95df8f9d866377e3d364f8cdb4dbe84527d5fd670c342";

function absentProcessError() {
  const error = new Error("pidof exited 1");
  error.stdout = Buffer.from("");
  error.stderr = Buffer.from("");
  error.status = 1;
  return error;
}

test("CLI requires an explicit release pin, ignores ambient pin state, and wires cleanup deps", () => {
  const explicit = parseArgs([
    "--apk",
    "/tmp/pilot.apk",
    "--expected-pilot-cert-sha256",
    PILOT_CERT,
  ]);
  assert.equal(
    harnessOptions(explicit, {
      ANDROID_SERIAL: SERIAL,
      TOWNSHIP_PILOT_CERT_SHA256: DEBUG_CERT,
    }).expectedPilotCertSha256,
    PILOT_CERT,
  );

  const dev = parseArgs(["--apk", "/tmp/dev.apk", "--mode", "dev", "--allow-dev-mode"]);
  assert.deepEqual(
    harnessOptions(dev, {
      ANDROID_SERIAL: SERIAL,
      TOWNSHIP_PILOT_CERT_SHA256: PILOT_CERT,
    }),
    {
      serial: SERIAL,
      apkPath: "/tmp/dev.apk",
      mode: "dev",
      outDir: "output/device-a",
      expectedPilotCertSha256: undefined,
      allowDevMode: true,
    },
  );
  assert.equal(
    harnessOptions(parseArgs(["--apk", "/tmp/pilot.apk"]), {
      ANDROID_SERIAL: SERIAL,
      TOWNSHIP_PILOT_CERT_SHA256: DEBUG_CERT,
    }).expectedPilotCertSha256,
    undefined,
    "ambient certificate variables must never become a release trust anchor",
  );
  assert.throws(() => harnessOptions(explicit, {}), /ANDROID_SERIAL is required/);
  assert.throws(
    () => harnessOptions(parseArgs(["--apk", "/tmp/dev.apk", "--mode", "dev"]), { ANDROID_SERIAL: SERIAL }),
    /explicit --allow-dev-mode opt-out/,
  );
  assert.throws(
    () => harnessOptions(parseArgs(["--apk", "/tmp/bad.apk", "--mode", "relesae"]), { ANDROID_SERIAL: SERIAL }),
    /unknown mode relesae/,
  );

  const executions = [];
  const removals = [];
  const deps = createDeviceDeps(SERIAL, {
    adbPath: () => "/sdk/adb",
    execFileSync: (file, args, options) => {
      executions.push({ file, args, options });
      return Buffer.from("");
    },
    randomUUID: () => "fixed-uuid",
    tmpdir: () => "/private/tmp",
    rmSync: (path, options) => removals.push({ path, options }),
  });
  assert.equal(
    deps.temporaryFile("installed-base.apk"),
    "/private/tmp/township-device-a-fixed-uuid-installed-base.apk",
  );
  deps.removeFile("/private/tmp/stale.apk");
  assert.deepEqual(removals, [{ path: "/private/tmp/stale.apk", options: { force: true } }]);
  deps.adb(["get-state"]);
  assert.deepEqual(executions[0], {
    file: "/sdk/adb",
    args: ["-s", SERIAL, "get-state"],
    options: {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  });

  const cliPath = fileURLToPath(new URL("../harness/android_device_a.mjs", import.meta.url));
  for (const mode of ["dev", "relesae"]) {
    const invocation = spawnSync(process.execPath, [cliPath, "--apk", "/tmp/x.apk", "--mode", mode], {
      encoding: "utf8",
      env: { ...process.env, ANDROID_SERIAL: SERIAL },
    });
    assert.equal(invocation.status, 2);
    assert.doesNotMatch(invocation.stderr, /\n\s+at /, "usage errors must not print a stack trace");
  }
  const missingApk = spawnSync(
    process.execPath,
    [cliPath, "--apk", "/definitely/missing/township.apk", "--mode", "dev", "--allow-dev-mode"],
    { encoding: "utf8", env: { ...process.env, ANDROID_SERIAL: SERIAL } },
  );
  assert.equal(missingApk.status, 4, "infrastructure faults need a distinct exit code");
  assert.match(missingApk.stderr, /Harness infrastructure error:/);
  assert.doesNotMatch(missingApk.stderr, /\n\s+at /);
  const symlinkDir = mkdtempSync(join(tmpdir(), "township-device-a-cli-"));
  const symlinkPath = join(symlinkDir, "device-a.mjs");
  try {
    symlinkSync(cliPath, symlinkPath);
    const invocation = spawnSync(
      process.execPath,
      [symlinkPath, "--apk", "/tmp/x.apk", "--mode", "relesae"],
      { encoding: "utf8", env: { ...process.env, ANDROID_SERIAL: SERIAL } },
    );
    assert.equal(invocation.status, 2, "a symlinked CLI path must still execute main");
    assert.match(invocation.stderr, /unknown mode relesae/);
  } finally {
    rmSync(symlinkDir, { recursive: true, force: true });
  }
});

function releaseOptions(overrides = {}) {
  return {
    serial: SERIAL,
    apkPath: "/tmp/x.apk",
    mode: "release",
    outDir: "/tmp/out",
    expectedPilotCertSha256: PILOT_CERT,
    repositoryPin: PILOT_CERT,
    ...overrides,
  };
}

function fakeDeps({
  reverseLines = [],
  installedCert = null,
  artifactCert = { dn: "CN=Township Pilot", sha256: PILOT_CERT },
  artifactCertError = null,
  installedCertError = null,
  installedSignerResult = undefined,
  postInstallCertError = null,
  postInstallArtifactCert = artifactCert,
  postInstallBytes = Buffer.from("apk-bytes"),
  artifactPackageId = TOWNSHIP_PACKAGE_ID,
  cleanupError = null,
  initialPackagePathError = null,
  initialPackagePathOutput = null,
  postInstallPathError = null,
  postInstallPullError = null,
  extraResponses = {},
  postStopPidError = absentProcessError(),
} = {}) {
  const calls = [];
  const writes = [];
  const removed = [];
  const logs = [];
  let forceStopped = false;
  let packageInstalled = installedCert != null;
  let installCompleted = false;
  const adb = (args) => {
    calls.push(args.join(" "));
    const key = args.join(" ");
    if (key.startsWith("shell pm path") && !installCompleted && initialPackagePathError) {
      throw initialPackagePathError;
    }
    if (key.startsWith("shell pm path") && !installCompleted && initialPackagePathOutput != null) {
      return initialPackagePathOutput;
    }
    if (key in extraResponses) {
      if (extraResponses[key] instanceof Error) throw extraResponses[key];
      if (key.startsWith("install") && /^Success\s*$/m.test(extraResponses[key])) {
        packageInstalled = true;
        installCompleted = true;
      }
      return extraResponses[key];
    }
    if (key === "get-state") return "device\n";
    if (key === "reverse --list") return `${reverseLines.join("\n")}\n`;
    if (key.startsWith("shell getprop ro.product.model")) return "Pixel 6 Pro\n";
    if (key.startsWith("shell getprop ro.build.version.release")) return "16\n";
    if (key.startsWith("shell getprop ro.build.version.sdk")) return "36\n";
    if (key.startsWith("shell getprop ro.product.cpu.abi")) return "arm64-v8a\n";
    if (key.startsWith("shell pm path")) {
      if (installCompleted && postInstallPathError) throw postInstallPathError;
      if (packageInstalled) return "package:/data/app/base.apk\n";
      throw absentProcessError();
    }
    if (key.startsWith("pull ")) {
      if (installCompleted && postInstallPullError) throw postInstallPullError;
      return "1 file pulled\n";
    }
    if (key.startsWith("install")) {
      packageInstalled = true;
      installCompleted = true;
      return "Success\n";
    }
    if (key.startsWith("shell am start")) {
      return "Status: ok\nActivity: dev.treetop.lattice.township/.MainActivity\nTotalTime: 412\n";
    }
    if (key.startsWith("shell am force-stop")) {
      forceStopped = true;
      return "";
    }
    if (key.startsWith("shell pidof")) {
      if (forceStopped) throw postStopPidError;
      return "4321\n";
    }
    if (key.startsWith("logcat")) return `serial ${SERIAL} saw township://pair?cap=QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w\n`;
    if (key.startsWith("shell dumpsys connectivity")) return "Active default network: 100\n  NetworkAgentInfo [WIFI () - 100]\n";
    if (key.startsWith("exec-out screencap")) return Buffer.from("PNGFAKE");
    return "";
  };
  return {
    calls,
    writes,
    removed,
    logs,
    adb,
    apksignerCerts: (path) => {
      if (path.endsWith("post-install-base.apk")) {
        if (postInstallCertError) throw postInstallCertError;
        return postInstallArtifactCert;
      }
      if (path.endsWith("installed-base.apk")) {
        if (!installCompleted && installedCertError) throw installedCertError;
        if (!installCompleted && installedSignerResult !== undefined) return installedSignerResult;
        return installCompleted
          ? postInstallArtifactCert
          : { dn: "C=US, O=Android, CN=Android Debug", sha256: installedCert };
      }
      if (artifactCertError) throw artifactCertError;
      return artifactCert;
    },
    apkPackageId: () => artifactPackageId,
    readFileBytes: (path) =>
      path.endsWith("post-install-base.apk") ? postInstallBytes : Buffer.from("apk-bytes"),
    writeFile: (path, data) => {
      calls.push(`WRITE ${path} ${data.length}`);
      writes.push({ path, data });
    },
    mkdir: () => {},
    temporaryFile: (name) => `/tmp/device-a-${name}`,
    removeFile: (path) => {
      if (cleanupError) throw cleanupError;
      removed.push(path);
    },
    gitSha: () => "0123456789abcdef0123456789abcdef01234567",
    now: () => new Date("2026-08-10T12:34:56.789Z"),
    evidenceRunId: () => "run-0001",
    sleep: async () => {},
    log: (line) => logs.push(line),
  };
}

test("redaction removes serials, base64 blobs, and pairing payloads", () => {
  const text = [
    `device ${SERIAL} attached`,
    "township://pair?cap=QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w",
    "seed: c2VjcmV0LXNlZWQtbWF0ZXJpYWwtc2VjcmV0LXNlZWQtbWF0ZXJpYWw=",
    "private_key=short",
    "PrivateKey=short",
    "privatekey=short",
    "ordinary log line stays",
  ].join("\n");
  const redacted = redactEvidenceText(text, { serial: SERIAL });
  assert.ok(!redacted.includes(SERIAL), "full serial must never appear");
  assert.ok(!redacted.includes("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w"), "QR/pairing payload must be redacted");
  assert.ok(!redacted.includes("c2VjcmV0"), "key-material-shaped base64 must be redacted");
  assert.ok(!redacted.includes("private_key=short"));
  assert.ok(!redacted.includes("PrivateKey=short"));
  assert.ok(!redacted.includes("privatekey=short"));
  assert.match(redacted, /ordinary log line stays/);
});

test("redacted serial is stable and non-reversible-looking", () => {
  const a = redactSerial(SERIAL);
  assert.equal(a, redactSerial(SERIAL));
  assert.ok(!a.includes(SERIAL));
  assert.match(a, /^serial-[0-9a-f]{8}$/);
});

test("evidence bundle is immutable and keyed by git sha, apk hash, capture time, and run id", () => {
  assert.equal(
    evidenceKey(
      "0123456789abcdef0123456789abcdef01234567",
      "ff3909bef21cf7883e8609ff52611d88",
      "2026-08-10T12:34:56.789Z",
      "run-0001",
    ),
    "0123456789ab-ff3909bef21c-20260810123456789-run-0001",
  );
});

test("network classification distinguishes wifi and cellular", () => {
  assert.equal(classifyNetworkClass("NetworkAgentInfo [WIFI () - 100]"), "wifi");
  assert.equal(classifyNetworkClass("NetworkAgentInfo [MOBILE (LTE) - 101]"), "cellular");
  assert.equal(classifyNetworkClass(""), "unknown");
});

test("signer decision: mismatch stops and demands operator approval", () => {
  const stop = decideInstallAction({
    packagePresent: true,
    installedCertSha256: "5c5ee033b521ff3977d95df8f9d866377e3d364f8cdb4dbe84527d5fd670c342",
    artifactCertSha256: "f05d98afdda542d84e20e3bc451a22f12d63ed52d53032ddef2538137435fbab",
  });
  assert.equal(stop.action, "stop-signer-mismatch");
  assert.equal(stop.requiresOperatorApproval, true);
  assert.equal(
    decideInstallAction({ packagePresent: false, installedCertSha256: null, artifactCertSha256: "x" }).action,
    "clean-install",
  );
  assert.equal(
    decideInstallAction({ packagePresent: true, installedCertSha256: "x", artifactCertSha256: "x" }).action,
    "upgrade-install",
  );
});

test("release run fails when any adb reverse mapping exists and never removes it", async () => {
  const deps = fakeDeps({ reverseLines: ["UsbFfs tcp:43185 tcp:43185"] });
  const result = await runDeviceAHarness(releaseOptions(), deps);
  assert.equal(result.ok, false);
  assert.equal(result.failure, "adb-reverse-present");
  assert.ok(!deps.calls.some((call) => call.includes("reverse --remove")), "must never delete a mapping it did not create");
  assert.ok(!deps.calls.some((call) => call.includes("uninstall") || call.includes("pm clear")));
});

test("unread reverse state is never reported as zero and dev query failure uses the observation name", async () => {
  const reverseError = new Error("reverse query unavailable");
  reverseError.stderr = Buffer.from("device offline");
  const releaseDeps = fakeDeps({ extraResponses: { "reverse --list": reverseError } });
  const release = await runDeviceAHarness(releaseOptions(), releaseDeps);
  assert.equal(release.failure, "adb-reverse-query");
  assert.equal(release.evidence.reverseMappings, null);
  assert.equal(
    release.evidence.steps.find(({ name }) => name === "adb-reverse-clean")?.ok,
    false,
  );
  const markdown = releaseDeps.writes.find(({ path }) => path.endsWith("evidence.md"))?.data ?? "";
  assert.match(markdown, /ADB reverse mappings: not read/);

  const devDeps = fakeDeps({ extraResponses: { "reverse --list": reverseError } });
  const dev = await runDeviceAHarness(
    {
      serial: SERIAL,
      apkPath: "/tmp/x.apk",
      mode: "dev",
      outDir: "/tmp/out",
      allowDevMode: true,
    },
    devDeps,
  );
  assert.equal(dev.failure, "adb-reverse-query");
  assert.equal(dev.evidence.reverseMappings, null);
  assert.equal(dev.evidence.steps.some(({ name }) => name === "adb-reverse-clean"), false);
  assert.equal(dev.evidence.steps.find(({ name }) => name === "adb-reverse-state")?.ok, false);
});

test("package-state ADB failure cannot masquerade as package absence", async () => {
  const pmError = new Error("adb transport failed");
  pmError.status = null;
  pmError.stderr = Buffer.from("device offline");
  const listError = new Error("adb transport failed");
  listError.status = null;
  listError.stderr = Buffer.from("device offline");
  const deps = fakeDeps({
    extraResponses: {
      "shell pm path dev.treetop.lattice.township": pmError,
      "shell pm list packages dev.treetop.lattice.township": listError,
    },
  });
  const result = await runDeviceAHarness(releaseOptions(), deps);
  assert.equal(result.failure, "package-state");
  assert.deepEqual(
    result.evidence.steps.find(({ name }) => name === "package-state"),
    { name: "package-state", ok: false, detail: "query failed" },
  );
  assert.ok(!deps.calls.some((call) => call.startsWith("install")));
});

test("OEM missing-package diagnostics are cross-checked before treating the device as clean", async () => {
  const missing = new Error("package not found");
  missing.status = 1;
  missing.stdout = Buffer.from("Error: package dev.treetop.lattice.township was not found\n");
  missing.stderr = Buffer.from("");
  const deps = fakeDeps({ initialPackagePathError: missing });
  const result = await runDeviceAHarness(releaseOptions(), deps);
  assert.equal(result.ok, true);
  assert.ok(deps.calls.includes("shell pm list packages dev.treetop.lattice.township"));
  assert.deepEqual(
    result.evidence.steps.find(({ name }) => name === "package-state"),
    { name: "package-state", ok: true, detail: "absent" },
  );
});

test("exit-zero pm path diagnostics are also cross-checked before install", async () => {
  const deps = fakeDeps({ initialPackagePathOutput: "Error: package lookup unavailable\n" });
  const result = await runDeviceAHarness(releaseOptions(), deps);
  assert.equal(result.ok, true);
  assert.ok(deps.calls.includes("shell pm list packages dev.treetop.lattice.township"));
  assert.equal(result.action, "clean-install");
});

test("signer mismatch captures baseline metadata then stops without uninstalling", async () => {
  const deps = fakeDeps({ installedCert: DEBUG_CERT });
  const result = await runDeviceAHarness(releaseOptions(), deps);
  assert.equal(result.ok, false);
  assert.equal(result.stopped, true);
  assert.equal(result.failure, "signer-mismatch");
  assert.match(result.operatorMessage, /explicit operator approval/i);
  assert.match(result.operatorMessage, /dev\.treetop\.lattice\.township/);
  assert.ok(deps.calls.some((call) => call.startsWith("WRITE") && call.includes("evidence.json")), "baseline evidence must be written");
  assert.ok(!deps.calls.some((call) => call.includes("uninstall") || call.includes("pm clear")), "harness must never uninstall");
  assert.ok(!deps.calls.some((call) => call.startsWith("install")), "must not install over a mismatched signer");
  assert.ok(!deps.calls.some((call) => call.startsWith("logcat") || call.startsWith("exec-out screencap")));
  assert.deepEqual(deps.removed, ["/tmp/device-a-installed-base.apk"]);
  assert.ok(!deps.calls.some((call) => call.includes(`${result.bundleDir}/pulled-base.apk`)));
  const markdown = deps.writes.find(({ path }) => path.endsWith("evidence.md"))?.data ?? "";
  assert.match(markdown, new RegExp(`Installed signer cert SHA-256: ${DEBUG_CERT}`));
  assert.match(markdown, new RegExp(`Operator stop: signer mismatch; installed ${DEBUG_CERT}; artifact ${PILOT_CERT}`));
});

test("clean run installs, launches, force-stops, and writes a redacted keyed bundle", async () => {
  const deps = fakeDeps();
  const result = await runDeviceAHarness(releaseOptions(), deps);
  assert.equal(result.ok, true);
  assert.equal(result.action, "clean-install");
  assert.match(result.bundleDir, /0123456789ab-/);
  assert.ok(deps.calls.some((call) => call.startsWith("install")));
  assert.ok(deps.calls.some((call) => call.startsWith("shell am force-stop dev.treetop.lattice.township")));
  const evidenceWrite = deps.calls.find((call) => call.startsWith("WRITE") && call.includes("evidence.json"));
  assert.ok(evidenceWrite, "evidence.json must be written");
  assert.equal(result.evidence.serial, redactSerial(SERIAL));
  assert.equal(result.evidence.expectedPilotCertSha256, PILOT_CERT);
  assert.equal(result.evidence.pinSource, "repository");
  assert.deepEqual(
    result.evidence.steps.find(({ name }) => name === "package-state"),
    { name: "package-state", ok: true, detail: "absent" },
    "adb shell pm path exit 1 with empty output is the real clean-install absence shape",
  );
  assert.equal(result.evidence.installedPackageState, "absent");
  const markdown = deps.writes.find(({ path }) => path.endsWith("evidence.md"))?.data ?? "";
  assert.match(markdown, /Installed package state: absent/);
  assert.match(markdown, /Installed signer cert SHA-256: package absent/);
  assert.equal(result.evidence.networkClass, "wifi");
  assert.ok(!JSON.stringify(result.evidence).includes(SERIAL), "bundle must not contain the raw serial");
  assert.ok(!deps.calls.some((call) => call.includes("uninstall") || call.includes("pm clear") || call.includes("reverse --remove")));
});

test("release refuses a foreign applicationId before contacting ADB", async () => {
  const deps = fakeDeps({ artifactPackageId: "dev.treetop.lattice.toolshed" });
  const result = await runDeviceAHarness(releaseOptions(), deps);
  assert.equal(result.failure, "artifact-package-mismatch");
  assert.ok(!deps.calls.includes("get-state"));
  assert.ok(!deps.calls.some((call) => call.startsWith("install")));
});

test("release refuses a multi-signer artifact before contacting ADB", async () => {
  const deps = fakeDeps({
    artifactCert: {
      dn: null,
      sha256: null,
      signerCount: 2,
      completeSignerCount: 2,
      distinctSignerCount: 2,
      signers: [
        { dn: "CN=Township Pilot", sha256: PILOT_CERT },
        { dn: "CN=Unexpected Co-Signer", sha256: DEBUG_CERT },
      ],
    },
  });
  const result = await runDeviceAHarness(releaseOptions(), deps);
  assert.equal(result.failure, "artifact-signer-count");
  assert.equal(result.evidence.artifactSignerBlockCount, 2);
  assert.equal(result.evidence.artifactDistinctSignerCount, 2);
  assert.ok(!deps.calls.includes("get-state"));
});

test("post-install unreadability is distinct from an artifact comparison failure", async () => {
  const pathError = new Error("package path unavailable");
  pathError.stderr = Buffer.from("permission denied");
  pathError.status = 1;
  const pathResult = await runDeviceAHarness(
    releaseOptions(),
    fakeDeps({ postInstallPathError: pathError }),
  );
  assert.equal(pathResult.failure, "installed-artifact-unreadable");
  assert.deepEqual(
    pathResult.evidence.steps.find(({ name }) => name === "installed-artifact-readable"),
    {
      name: "installed-artifact-readable",
      ok: false,
      detail: "installed package path unavailable; artifact remains installed but unverified",
    },
  );

  const pullError = new Error("pull denied");
  pullError.stderr = Buffer.from("remote permission denied");
  pullError.status = 1;
  const pullResult = await runDeviceAHarness(
    releaseOptions(),
    fakeDeps({ postInstallPullError: pullError }),
  );
  assert.equal(pullResult.failure, "installed-artifact-unreadable");
  assert.equal(
    pullResult.evidence.steps.find(({ name }) => name === "installed-artifact-readable")?.ok,
    false,
  );
});

test("nonzero adb install cannot masquerade as success and cleanup faults preserve evidence", async () => {
  const installError = new Error("wrapper failed after output");
  installError.stdout = Buffer.from("Success\n");
  installError.stderr = Buffer.from("");
  installError.status = 1;
  const installDeps = fakeDeps({ extraResponses: { "install -r /tmp/x.apk": installError } });
  const installResult = await runDeviceAHarness(releaseOptions(), installDeps);
  assert.equal(installResult.failure, "install-failed");
  assert.deepEqual(
    installResult.evidence.steps.find(({ name }) => name === "install"),
    { name: "install", ok: false, detail: "ADB_NONZERO_EXIT" },
  );

  const cleanupDeps = fakeDeps({ cleanupError: new Error("temporary file busy") });
  const cleanupResult = await runDeviceAHarness(releaseOptions(), cleanupDeps);
  assert.equal(cleanupResult.ok, true, "temporary cleanup is evidence-worthy but non-fatal");
  assert.ok(cleanupResult.evidence.steps.some(({ name }) => name === "temp-cleanup-warning"));
  assert.ok(cleanupDeps.writes.some(({ path }) => path.endsWith("evidence.json")));
});

test("device-controlled metadata cannot inject lines into Markdown evidence", async () => {
  const deps = fakeDeps({
    extraResponses: {
      "shell getprop ro.product.model": "Pixel\n- [x] forged-evidence\n",
    },
  });
  const result = await runDeviceAHarness(releaseOptions(), deps);
  assert.equal(result.ok, true);
  const markdown = deps.writes.find(({ path }) => path.endsWith("evidence.md"))?.data ?? "";
  assert.doesNotMatch(markdown, /^- \[x\] forged-evidence$/m);
  assert.match(markdown, /Device: Pixel - \[x\] forged-evidence/);
});

test("a reported install success is refused unless the exact APK bytes and signer landed", async () => {
  const deps = fakeDeps({ postInstallBytes: Buffer.from("different-installed-apk") });
  const result = await runDeviceAHarness(releaseOptions(), deps);
  assert.equal(result.ok, false);
  assert.equal(result.failure, "installed-artifact-verified");
  assert.deepEqual(
    result.evidence.steps.find(({ name }) => name === "installed-artifact-verified"),
    { name: "installed-artifact-verified", ok: false, detail: "installed APK differs from artifact" },
  );
  assert.ok(!deps.calls.some((call) => call.startsWith("shell am start")));
});

test("release run refuses an unpinned artifact before contacting a device", async () => {
  const deps = fakeDeps();
  const result = await runDeviceAHarness(
    { serial: SERIAL, apkPath: "/tmp/x.apk", mode: "release", outDir: "/tmp/out" },
    deps,
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure, "artifact-unpinned");
  assert.ok(!deps.calls.includes("get-state"), "an unpinned artifact must be refused before ADB");
  assert.ok(!deps.calls.some((call) => call.startsWith("install")));
});

test("artifact signer inspection failure emits structured refusal evidence", async () => {
  const deps = fakeDeps({ artifactCertError: new Error("Android SDK not found; set ANDROID_HOME") });
  const result = await runDeviceAHarness(releaseOptions(), deps);
  assert.equal(result.failure, "artifact-signer-uninspectable");
  assert.equal(result.evidence.artifactSignerCertSha256, null);
  assert.deepEqual(
    result.evidence.steps.find(({ name }) => name === "artifact-signer-verified"),
    { name: "artifact-signer-verified", ok: false, detail: "signer inspection unavailable" },
  );
  assert.ok(deps.logs.some((line) => line.includes("Android SDK not found")));
  assert.ok(deps.writes.some(({ path }) => path.endsWith("evidence.json")));
  const markdown = deps.writes.find(({ path }) => path.endsWith("evidence.md"))?.data ?? "";
  assert.match(markdown, /Artifact signer cert SHA-256: not read/);
  assert.ok(!deps.calls.includes("get-state"));
});

test("installed signer tool failure is distinct from a signer mismatch", async () => {
  const deps = fakeDeps({
    installedCert: PILOT_CERT,
    installedCertError: new Error("pinned Android build-tools unavailable"),
  });
  const result = await runDeviceAHarness(releaseOptions(), deps);
  assert.equal(result.failure, "installed-signer-uninspectable");
  assert.deepEqual(
    result.evidence.steps.find(({ name }) => name === "package-state"),
    { name: "package-state", ok: true, detail: "present" },
  );
  assert.ok(deps.logs.some((line) => line.includes("build-tools unavailable")));
  assert.ok(!deps.calls.some((call) => call.startsWith("install")));
});

test("unparseable installed signer output never produces uninstall guidance", async () => {
  const deps = fakeDeps({
    installedCert: PILOT_CERT,
    installedSignerResult: { dn: null, sha256: null },
  });
  const result = await runDeviceAHarness(releaseOptions(), deps);
  assert.equal(result.failure, "installed-signer-count");
  assert.equal(result.stopped, undefined);
  assert.equal(result.evidence.operatorMessage, undefined);
  assert.ok(!deps.logs.some((line) => /approval|uninstall/i.test(line)));
  assert.ok(!deps.calls.some((call) => call.startsWith("install")));
});

test("dev mode never turns an unparseable artifact signer into uninstall guidance", async () => {
  const deps = fakeDeps({
    installedCert: DEBUG_CERT,
    artifactCert: { dn: null, sha256: null },
  });
  const result = await runDeviceAHarness(
    {
      serial: SERIAL,
      apkPath: "/tmp/x.apk",
      mode: "dev",
      outDir: "/tmp/out",
      allowDevMode: true,
    },
    deps,
  );
  assert.equal(result.failure, "artifact-signer-count");
  assert.equal(result.stopped, undefined);
  assert.equal(result.evidence.operatorMessage, undefined);
  assert.ok(!deps.logs.some((line) => /approval|uninstall/i.test(line)));
  assert.ok(!deps.calls.includes("get-state"));
});

test("post-install signer tool failure is distinct from artifact mismatch", async () => {
  const deps = fakeDeps({ postInstallCertError: new Error("apksigner unavailable") });
  const result = await runDeviceAHarness(releaseOptions(), deps);
  assert.equal(result.failure, "installed-artifact-uninspectable");
  assert.ok(deps.logs.some((line) => line.includes("apksigner unavailable")));
  assert.ok(!deps.calls.some((call) => call.startsWith("shell am start")));
});

test("release run refuses a debug-signed artifact even when its fingerprint is supplied", async () => {
  const deps = fakeDeps({
    artifactCert: { dn: "C=US, O=Android, CN=Android Debug", sha256: DEBUG_CERT },
  });
  const result = await runDeviceAHarness(
    releaseOptions(),
    deps,
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure, "artifact-debug-signed");
  assert.ok(!deps.calls.includes("get-state"), "a debug-signed artifact must be refused before ADB");
  assert.ok(!deps.calls.some((call) => call.startsWith("install")));
});

test("release run refuses an artifact that does not match the pinned pilot certificate", async () => {
  const anotherCert = "a05d98afdda542d84e20e3bc451a22f12d63ed52d53032ddef2538137435fbaa";
  const deps = fakeDeps({ artifactCert: { dn: "CN=Unexpected signer", sha256: anotherCert } });
  const result = await runDeviceAHarness(
    releaseOptions(),
    deps,
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure, "artifact-signer-mismatch");
  assert.equal(result.evidence.reverseMappings, null);
  assert.ok(!deps.calls.includes("get-state"), "a mismatched artifact must be refused before ADB");
  assert.ok(!deps.calls.some((call) => call.startsWith("install")));
});

test("a provisioned repository pin refuses an operator-supplied override end to end", async () => {
  assert.equal(pilotPinStatus(PILOT_CERT, PILOT_CERT), "matched");
  assert.equal(pilotPinStatus(DEBUG_CERT, PILOT_CERT), "mismatched");
  assert.equal(
    pilotPinStatus(PILOT_CERT.toUpperCase().match(/.{2}/g).join(":"), PILOT_CERT.toUpperCase()),
    "matched",
  );
  assert.equal(pilotPinStatus(PILOT_CERT, null), "unprovisioned");
  const deps = fakeDeps();
  const result = await runDeviceAHarness(
    releaseOptions({ expectedPilotCertSha256: DEBUG_CERT }),
    deps,
  );
  assert.equal(result.failure, "artifact-pin-override");
  assert.ok(!deps.calls.includes("get-state"));
});

test("an unprovisioned-window run records that its pin came from the explicit flag", async () => {
  const result = await runDeviceAHarness(releaseOptions({ repositoryPin: null }), fakeDeps());
  assert.equal(result.ok, true);
  assert.equal(result.evidence.pinSource, "explicit-flag");
  assert.equal(result.evidence.expectedPilotCertSha256, PILOT_CERT);
});

test("dev mode records that signer verification was skipped, never a false success", async () => {
  const deps = fakeDeps({
    reverseLines: ["tcp:4000 tcp:4000", "tcp:4001 tcp:4001"],
    artifactCert: { dn: "C=US, O=Android, CN=Android Debug", sha256: DEBUG_CERT },
  });
  const result = await runDeviceAHarness(
    {
      serial: SERIAL,
      apkPath: "/tmp/x.apk",
      mode: "dev",
      outDir: "/tmp/out",
      allowDevMode: true,
    },
    deps,
  );

  assert.equal(result.ok, true);
  assert.ok(!result.evidence.steps.some(({ name }) => name === "artifact-signer-verified"));
  assert.deepEqual(result.evidence.steps.find(({ name }) => name === "artifact-signer-skipped"), {
    name: "artifact-signer-skipped",
    ok: true,
    detail: "not required in dev mode",
  });
  assert.equal(result.evidence.reverseMappings, 2);
  assert.equal(result.evidence.steps.some(({ name }) => name === "adb-reverse-clean"), false);
  assert.deepEqual(
    result.evidence.steps.find(({ name }) => name === "adb-reverse-state"),
    {
      name: "adb-reverse-state",
      ok: true,
      detail: "2 mapping(s) observed; dev mode does not enforce clean state",
    },
  );
});

test("dev mode requires an explicit operator opt-out", async () => {
  const deps = fakeDeps();
  await assert.rejects(
    runDeviceAHarness(
      { serial: SERIAL, apkPath: "/tmp/x.apk", mode: "dev", outDir: "/tmp/out" },
      deps,
    ),
    /explicit --allow-dev-mode opt-out/,
  );
  assert.deepEqual(deps.calls, []);
});

test("install and launch evidence retain only falsifiable structured outcomes", async () => {
  assert.deepEqual(installOutcome("Failure [INSTALL_FAILED_VERSION_DOWNGRADE]"), {
    ok: false,
    detail: "INSTALL_FAILED_VERSION_DOWNGRADE",
  });
  assert.deepEqual(installOutcome("adb: failed to stat x"), {
    ok: false,
    detail: "ADB_FAILED_TO_STAT",
  });
  assert.deepEqual(installOutcome("device offline"), { ok: false, detail: "ADB_DEVICE_OFFLINE" });
  assert.deepEqual(installOutcome("no devices/emulators found"), { ok: false, detail: "ADB_NO_DEVICE" });
  assert.deepEqual(installOutcome("more than one device/emulator"), {
    ok: false,
    detail: "ADB_MULTIPLE_DEVICES",
  });
  const installError = new Error("adb install failed");
  installError.stdout = Buffer.from("");
  installError.stderr = Buffer.from(
    "Failure [INSTALL_FAILED_VERSION_DOWNGRADE: private OEM detail]",
  );
  const installFailure = fakeDeps({
    extraResponses: {
      "install -r /tmp/x.apk": installError,
    },
  });
  const failedInstall = await runDeviceAHarness(releaseOptions(), installFailure);
  assert.equal(failedInstall.failure, "install-failed");
  assert.deepEqual(
    failedInstall.evidence.steps.find(({ name }) => name === "install"),
    { name: "install", ok: false, detail: "INSTALL_FAILED_VERSION_DOWNGRADE" },
  );
  assert.ok(installFailure.logs.some((line) => line.includes("INSTALL_FAILED_VERSION_DOWNGRADE")));
  assert.ok(!installFailure.logs.some((line) => line.includes("private OEM detail")));

  const unknownInstallError = new Error("adb install failed");
  unknownInstallError.stdout = Buffer.from("");
  unknownInstallError.stderr = Buffer.from("Failure [-124: Failed parse during installPackageLI]");
  const unknownInstall = fakeDeps({
    extraResponses: { "install -r /tmp/x.apk": unknownInstallError },
  });
  const unknownResult = await runDeviceAHarness(releaseOptions(), unknownInstall);
  assert.equal(unknownResult.failure, "install-failed");
  assert.ok(unknownInstall.logs.some((line) => line.includes("ADB install failed: failed")));
  assert.ok(!unknownInstall.logs.some((line) => line.includes("installPackageLI")));
  assert.ok(!JSON.stringify(unknownResult.evidence).includes("installPackageLI"));

  const launchFailure = fakeDeps({
    extraResponses: {
      "shell am start -W -n dev.treetop.lattice.township/.MainActivity":
        "Status: error\nError: private activity detail\n",
    },
  });
  const failedLaunch = await runDeviceAHarness(releaseOptions(), launchFailure);
  assert.equal(failedLaunch.failure, "launch");
  assert.deepEqual(
    failedLaunch.evidence.steps.find(({ name }) => name === "launch"),
    { name: "launch", ok: false, detail: "status=error" },
  );
  assert.ok(!JSON.stringify(failedLaunch.evidence).includes("private activity detail"));

  const crashedAfterStart = fakeDeps({
    extraResponses: {
      "shell pidof dev.treetop.lattice.township": absentProcessError(),
    },
  });
  const crashed = await runDeviceAHarness(releaseOptions(), crashedAfterStart);
  assert.equal(crashed.failure, "process-alive");
  assert.deepEqual(
    crashed.evidence.steps.find(({ name }) => name === "process-alive"),
    { name: "process-alive", ok: false, detail: "not running" },
  );
});

test("mid-run ADB failures still emit a structured evidence bundle", async () => {
  const adbError = new Error("USB reset with private device detail");
  adbError.stderr = Buffer.from("private device detail");
  const deps = fakeDeps({
    extraResponses: {
      "shell getprop ro.product.model": adbError,
    },
  });
  const result = await runDeviceAHarness(releaseOptions(), deps);
  assert.equal(result.ok, false);
  assert.equal(result.failure, "device-versions");
  assert.ok(deps.writes.some(({ path }) => path.endsWith("evidence.json")));
  assert.ok(!deps.writes.some(({ data }) => String(data).includes("private device detail")));

  const spawnFailure = new Error("spawn adb ENOENT");
  spawnFailure.code = "ENOENT";
  spawnFailure.stdout = null;
  spawnFailure.stderr = null;
  const forceStopDeps = fakeDeps({ postStopPidError: spawnFailure });
  const forceStopResult = await runDeviceAHarness(releaseOptions(), forceStopDeps);
  assert.equal(forceStopResult.ok, false);
  assert.equal(forceStopResult.failure, "force-stop");
});

test("evidence stores structured outcomes, never screenshots or general logcat", async () => {
  const userContent = "private resident statement that must not enter evidence";
  const deps = fakeDeps({
    extraResponses: {
      "install -r /tmp/x.apk": `Success\n${userContent}\n`,
    },
  });

  const result = await runDeviceAHarness(releaseOptions(), deps);
  assert.equal(result.ok, true);

  assert.ok(
    !deps.writes.some(({ path }) => path.endsWith(".png")),
    "raw screenshots must never be written to an evidence bundle",
  );
  assert.ok(
    !deps.calls.some((call) => call.startsWith("logcat")),
    "the baseline harness must not collect general logcat at all",
  );
  assert.deepEqual(
    deps.writes
      .filter(({ data }) => String(data).includes(userContent))
      .map(({ path }) => path),
    [],
    "user-visible screen/log content must not survive in any evidence file",
  );
  assert.ok(!deps.calls.some((call) => call.startsWith("exec-out screencap")));

  const allowedSteps = new Set([
    "artifact-package-verified",
    "artifact-signer-verified",
    "artifact-signer-skipped",
    "device-online",
    "device-versions",
    "adb-reverse-clean",
    "adb-reverse-state",
    "package-state",
    "installed-signer-read",
    "signer-match",
    "install",
    "installed-artifact-readable",
    "installed-artifact-verified",
    "launch",
    "process-alive",
    "force-stop",
    "network-class",
    "temp-cleanup-warning",
  ]);
  assert.ok(
    result.evidence.steps.every(({ name }) => allowedSteps.has(name)),
    "evidence may retain only allowlisted structured harness steps",
  );
  const devResult = await runDeviceAHarness(
    {
      serial: SERIAL,
      apkPath: "/tmp/x.apk",
      mode: "dev",
      outDir: "/tmp/out",
      allowDevMode: true,
    },
    fakeDeps({ reverseLines: ["tcp:4000 tcp:4000"] }),
  );
  assert.ok(
    devResult.evidence.steps.every(({ name }) => allowedSteps.has(name)),
    "the same explicit vocabulary must cover dev evidence",
  );
  assert.deepEqual(
    devResult.evidence.steps.find(({ name }) => name === "installed-artifact-readable"),
    { name: "installed-artifact-readable", ok: true, detail: "installed APK pulled for verification" },
  );
  assert.deepEqual(
    devResult.evidence.steps.find(({ name }) => name === "installed-artifact-verified"),
    { name: "installed-artifact-verified", ok: true, detail: "exact APK bytes and signer match" },
  );
  assert.ok(
    !JSON.stringify(result.evidence.steps).includes(userContent),
    "allowlisted step details must still redact sensitive content",
  );
});
