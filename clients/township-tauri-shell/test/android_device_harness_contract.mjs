// Contract for the non-destructive Device A harness baseline (plan 158
// "Physical Device Acceptance Harness", Wave A1 slice): ANDROID_SERIAL
// selection, adb-reverse fail-closed release policy, signer-mismatch stop
// with operator approval, redacted evidence, and a bundle keyed by
// git SHA + APK hash. The harness never uninstalls, never clears app data,
// and never deletes an adb reverse mapping it did not create.

import assert from "node:assert/strict";
import test from "node:test";

const {
  classifyNetworkClass,
  decideInstallAction,
  evidenceKey,
  parseReverseList,
  redactEvidenceText,
  redactSerial,
  runDeviceAHarness,
} = await import("../harness/device_a_lib.mjs");

const SERIAL = "1A2B3C4D5E6F";

function fakeDeps({ reverseLines = [], installedCert = null, extraResponses = {} } = {}) {
  const calls = [];
  const adb = (args) => {
    calls.push(args.join(" "));
    const key = args.join(" ");
    if (key in extraResponses) return extraResponses[key];
    if (key === "get-state") return "device\n";
    if (key === "reverse --list") return `${reverseLines.join("\n")}\n`;
    if (key.startsWith("shell getprop ro.product.model")) return "Pixel 6 Pro\n";
    if (key.startsWith("shell getprop ro.build.version.release")) return "16\n";
    if (key.startsWith("shell getprop ro.build.version.sdk")) return "36\n";
    if (key.startsWith("shell getprop ro.product.cpu.abi")) return "arm64-v8a\n";
    if (key.startsWith("shell pm path")) {
      return installedCert ? "package:/data/app/base.apk\n" : "";
    }
    if (key.startsWith("pull ")) return "1 file pulled\n";
    if (key.startsWith("install")) return "Success\n";
    if (key.startsWith("shell monkey")) return "Events injected: 1\n";
    if (key.startsWith("shell am force-stop")) return "";
    if (key.startsWith("shell pidof")) return "";
    if (key.startsWith("logcat")) return `serial ${SERIAL} saw township://pair?cap=QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w\n`;
    if (key.startsWith("shell dumpsys connectivity")) return "Active default network: 100\n  NetworkAgentInfo [WIFI () - 100]\n";
    if (key.startsWith("exec-out screencap")) return Buffer.from("PNGFAKE");
    return "";
  };
  return {
    calls,
    adb,
    apksignerCerts: (path) =>
      path.endsWith("pulled-base.apk")
        ? { dn: "C=US, O=Android, CN=Android Debug", sha256: installedCert }
        : { dn: "CN=Township Local Throwaway", sha256: "f05d98afdda542d84e20e3bc451a22f12d63ed52d53032ddef2538137435fbab" },
    readFileBytes: () => Buffer.from("apk-bytes"),
    writeFile: (path, data) => calls.push(`WRITE ${path} ${data.length}`),
    mkdir: () => {},
    gitSha: () => "0123456789abcdef0123456789abcdef01234567",
    sleep: async () => {},
    log: () => {},
  };
}

test("redaction removes serials, base64 blobs, and pairing payloads", () => {
  const text = [
    `device ${SERIAL} attached`,
    "township://pair?cap=QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w",
    "seed: c2VjcmV0LXNlZWQtbWF0ZXJpYWwtc2VjcmV0LXNlZWQtbWF0ZXJpYWw=",
    "ordinary log line stays",
  ].join("\n");
  const redacted = redactEvidenceText(text, { serial: SERIAL });
  assert.ok(!redacted.includes(SERIAL), "full serial must never appear");
  assert.ok(!redacted.includes("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w"), "QR/pairing payload must be redacted");
  assert.ok(!redacted.includes("c2VjcmV0"), "key-material-shaped base64 must be redacted");
  assert.match(redacted, /ordinary log line stays/);
});

test("redacted serial is stable and non-reversible-looking", () => {
  const a = redactSerial(SERIAL);
  assert.equal(a, redactSerial(SERIAL));
  assert.ok(!a.includes(SERIAL));
  assert.match(a, /^serial-[0-9a-f]{8}$/);
});

test("evidence bundle is keyed by git sha and apk hash", () => {
  assert.equal(
    evidenceKey("0123456789abcdef0123456789abcdef01234567", "ff3909bef21cf7883e8609ff52611d88"),
    "0123456789ab-ff3909bef21c",
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
  const result = await runDeviceAHarness(
    { serial: SERIAL, apkPath: "/tmp/x.apk", mode: "release", outDir: "/tmp/out" },
    deps,
  );
  assert.equal(result.ok, false);
  assert.equal(result.failure, "adb-reverse-present");
  assert.ok(!deps.calls.some((call) => call.includes("reverse --remove")), "must never delete a mapping it did not create");
  assert.ok(!deps.calls.some((call) => call.includes("uninstall") || call.includes("pm clear")));
});

test("signer mismatch captures disposable baseline evidence then stops without uninstalling", async () => {
  const deps = fakeDeps({ installedCert: "5c5ee033b521ff3977d95df8f9d866377e3d364f8cdb4dbe84527d5fd670c342" });
  const result = await runDeviceAHarness(
    { serial: SERIAL, apkPath: "/tmp/x.apk", mode: "release", outDir: "/tmp/out" },
    deps,
  );
  assert.equal(result.ok, false);
  assert.equal(result.stopped, true);
  assert.equal(result.failure, "signer-mismatch");
  assert.match(result.operatorMessage, /explicit operator approval/i);
  assert.match(result.operatorMessage, /dev\.treetop\.lattice\.township/);
  assert.ok(deps.calls.some((call) => call.startsWith("WRITE") && call.includes("evidence.json")), "baseline evidence must be written");
  assert.ok(!deps.calls.some((call) => call.includes("uninstall") || call.includes("pm clear")), "harness must never uninstall");
  assert.ok(!deps.calls.some((call) => call.startsWith("install")), "must not install over a mismatched signer");
});

test("clean run installs, launches, force-stops, and writes a redacted keyed bundle", async () => {
  const deps = fakeDeps();
  const result = await runDeviceAHarness(
    { serial: SERIAL, apkPath: "/tmp/x.apk", mode: "release", outDir: "/tmp/out" },
    deps,
  );
  assert.equal(result.ok, true);
  assert.equal(result.action, "clean-install");
  assert.match(result.bundleDir, /0123456789ab-/);
  assert.ok(deps.calls.some((call) => call.startsWith("install")));
  assert.ok(deps.calls.some((call) => call.startsWith("shell am force-stop dev.treetop.lattice.township")));
  const evidenceWrite = deps.calls.find((call) => call.startsWith("WRITE") && call.includes("evidence.json"));
  assert.ok(evidenceWrite, "evidence.json must be written");
  assert.equal(result.evidence.serial, redactSerial(SERIAL));
  assert.equal(result.evidence.networkClass, "wifi");
  assert.ok(!JSON.stringify(result.evidence).includes(SERIAL), "bundle must not contain the raw serial");
  assert.ok(!deps.calls.some((call) => call.includes("uninstall") || call.includes("pm clear") || call.includes("reverse --remove")));
});
