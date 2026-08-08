// Non-destructive Device A acceptance-harness baseline (plan 158 "Physical
// Device Acceptance Harness", Wave A1 slice).
//
// Guarantees enforced here and pinned by test/android_device_harness_contract.mjs:
// - the device is selected only through ANDROID_SERIAL;
// - a release run FAILS if any adb reverse mapping exists, and the harness
//   never deletes a mapping it did not create (it creates none);
// - a signer mismatch against the installed package captures disposable
//   baseline evidence, STOPS, and requires explicit operator approval before
//   anyone uninstalls dev.treetop.lattice.township — the harness itself never
//   uninstalls, never runs `pm clear`, and never wipes anything;
// - evidence bundles are keyed by git SHA + APK SHA-256 and never contain
//   private keys, capability payloads, pairing QR contents, full device
//   serials, or user content.

import { createHash } from "node:crypto";
import { TOWNSHIP_PACKAGE_ID } from "../scripts/android-pilot/pilot_policy.mjs";

export { TOWNSHIP_PACKAGE_ID };

export function redactSerial(serial) {
  return `serial-${createHash("sha256").update(String(serial)).digest("hex").slice(0, 8)}`;
}

const BASE64_RUN = /[A-Za-z0-9+/=_-]{32,}/g;
const TOWNSHIP_LINK = /township:\/\/[^\s"']*/g;
const SENSITIVE_LINE = /seed|private[-_ ]?key|BEGIN [A-Z ]*KEY|capability|passphrase|password/i;

export function redactEvidenceText(text, { serial } = {}) {
  const lines = String(text).split("\n").map((line) => {
    let out = line;
    if (serial) out = out.split(serial).join(redactSerial(serial));
    out = out.replace(TOWNSHIP_LINK, "township://[redacted]");
    if (SENSITIVE_LINE.test(out)) return "[redacted:line]";
    out = out.replace(BASE64_RUN, "[redacted:b64]");
    return out;
  });
  return lines.join("\n");
}

export function parseReverseList(output) {
  return String(output)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function classifyNetworkClass(dumpsysOutput) {
  const text = String(dumpsysOutput);
  if (/\bWIFI\b|TRANSPORT_WIFI/.test(text)) return "wifi";
  if (/\bMOBILE\b|\bCELLULAR\b|TRANSPORT_CELLULAR/.test(text)) return "cellular";
  if (text.trim().length === 0) return "unknown";
  return "none";
}

export function evidenceKey(gitSha, apkSha256) {
  return `${String(gitSha).slice(0, 12)}-${String(apkSha256).slice(0, 12)}`;
}

export function decideInstallAction({ packagePresent, installedCertSha256, artifactCertSha256 }) {
  if (!packagePresent) return { action: "clean-install" };
  if (installedCertSha256 && installedCertSha256 === artifactCertSha256) {
    return { action: "upgrade-install" };
  }
  return {
    action: "stop-signer-mismatch",
    requiresOperatorApproval: true,
    forbidden: ["uninstall", "pm clear"],
  };
}

function operatorStopMessage(installedCert, artifactCert) {
  return [
    `Installed ${TOWNSHIP_PACKAGE_ID} is signed by a different certificate than the artifact`,
    `(installed ${installedCert ?? "unknown"}, artifact ${artifactCert}).`,
    "Android will not accept this as an in-place update. Disposable baseline evidence was captured.",
    "STOPPING: uninstalling requires EXPLICIT OPERATOR APPROVAL for exactly",
    `${TOWNSHIP_PACKAGE_ID} (one-time debug->pilot reset, discards the dev key and fixture state).`,
    "This harness never uninstalls, never runs `pm clear`, and never wipes anything itself.",
  ].join(" ");
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// deps: { adb(argsArray) -> string|Buffer, apksignerCerts(apkPath) -> {dn, sha256},
//         readFileBytes(path) -> Buffer, writeFile(path, data), mkdir(path),
//         gitSha() -> string, sleep(ms), log(line) }
export async function runDeviceAHarness(options, deps) {
  const { serial, apkPath, mode, outDir, packageId = TOWNSHIP_PACKAGE_ID } = options;
  if (!serial) throw new Error("ANDROID_SERIAL is required; the harness never guesses a device");
  if (!["release", "dev"].includes(mode)) throw new Error(`unknown mode ${mode}`);

  const steps = [];
  const record = (name, ok, detail = null) => steps.push({ name, ok, ...(detail ? { detail } : {}) });
  const redact = (text) => redactEvidenceText(text, { serial });
  // Query commands like `pm path` and `pidof` exit nonzero when the package
  // or process is absent; treat that as an empty answer, never a crash.
  const tryAdb = (args) => {
    try {
      return String(deps.adb(args));
    } catch {
      return "";
    }
  };

  const gitSha = deps.gitSha();
  const apkBytes = deps.readFileBytes(apkPath);
  const apkSha256 = sha256Hex(apkBytes);
  const artifactCerts = deps.apksignerCerts(apkPath);
  const bundleDir = `${outDir}/${evidenceKey(gitSha, apkSha256)}`;
  deps.mkdir(bundleDir);

  const evidence = {
    schema: 1,
    packageId,
    mode,
    gitSha,
    apkSha256,
    artifactSignerCertSha256: artifactCerts.sha256,
    artifactSignerDn: artifactCerts.dn,
    serial: redactSerial(serial),
    capturedAt: new Date().toISOString(),
    device: {},
    networkClass: "unknown",
    reverseMappings: 0,
    steps,
    status: "incomplete",
  };

  const finish = (result) => {
    evidence.status = result.ok ? "passed" : result.failure ?? "failed";
    deps.writeFile(`${bundleDir}/evidence.json`, `${JSON.stringify(evidence, null, 2)}\n`);
    deps.writeFile(
      `${bundleDir}/evidence.md`,
      [
        `# Device A harness evidence (${evidence.status})`,
        "",
        `- Package: ${packageId}`,
        `- Mode: ${mode}`,
        `- Git SHA: ${gitSha}`,
        `- APK SHA-256: ${apkSha256}`,
        `- Artifact signer cert SHA-256: ${artifactCerts.sha256}`,
        `- Device: ${evidence.device.model ?? "unknown"} (Android ${evidence.device.os ?? "?"}, API ${evidence.device.api ?? "?"}, ${evidence.device.abi ?? "?"})`,
        `- Network class: ${evidence.networkClass}`,
        `- Serial (redacted): ${evidence.serial}`,
        "",
        ...steps.map((step) => `- [${step.ok ? "x" : " "}] ${step.name}${step.detail ? ` — ${step.detail}` : ""}`),
        "",
      ].join("\n"),
    );
    return { ...result, bundleDir, evidence };
  };

  const state = String(deps.adb(["get-state"])).trim();
  record("device-online", state === "device", state);
  if (state !== "device") return finish({ ok: false, failure: "device-offline" });

  evidence.device = {
    model: String(deps.adb(["shell", "getprop", "ro.product.model"])).trim(),
    os: String(deps.adb(["shell", "getprop", "ro.build.version.release"])).trim(),
    api: String(deps.adb(["shell", "getprop", "ro.build.version.sdk"])).trim(),
    abi: String(deps.adb(["shell", "getprop", "ro.product.cpu.abi"])).trim(),
  };
  record("device-versions", true, `${evidence.device.model} API ${evidence.device.api}`);

  const reverse = parseReverseList(deps.adb(["reverse", "--list"]));
  evidence.reverseMappings = reverse.length;
  if (mode === "release" && reverse.length > 0) {
    // Never delete a mapping this run did not create — and this baseline
    // harness never creates one, so it never deletes any.
    record("adb-reverse-clean", false, `${reverse.length} mapping(s) present; release run refused`);
    return finish({ ok: false, failure: "adb-reverse-present" });
  }
  record("adb-reverse-clean", true);

  const pmPath = tryAdb(["shell", "pm", "path", packageId]);
  const packagePresent = pmPath.includes("package:");
  let installedCertSha256 = null;
  let installedDn = null;
  if (packagePresent) {
    const remoteApk = pmPath.split("package:")[1].split("\n")[0].trim();
    const pulledPath = `${bundleDir}/pulled-base.apk`;
    deps.adb(["pull", remoteApk, pulledPath]);
    const installedCerts = deps.apksignerCerts(pulledPath);
    installedCertSha256 = installedCerts.sha256;
    installedDn = installedCerts.dn;
  }
  evidence.installedSignerCertSha256 = installedCertSha256;
  evidence.installedSignerDn = installedDn;
  record("installed-signer-read", true, packagePresent ? "package present" : "package absent");

  const decision = decideInstallAction({
    packagePresent,
    installedCertSha256,
    artifactCertSha256: artifactCerts.sha256,
  });

  if (decision.action === "stop-signer-mismatch") {
    // Disposable baseline evidence: screen, redacted recent log, versions.
    const screen = deps.adb(["exec-out", "screencap", "-p"]);
    deps.writeFile(`${bundleDir}/baseline-screen.png`, screen);
    deps.writeFile(`${bundleDir}/baseline-logcat.redacted.txt`, redact(String(deps.adb(["logcat", "-d", "-t", "400"]))));
    evidence.networkClass = classifyNetworkClass(deps.adb(["shell", "dumpsys", "connectivity"]));
    record("signer-match", false, "installed signer differs from artifact signer");
    const operatorMessage = operatorStopMessage(installedCertSha256, artifactCerts.sha256);
    evidence.operatorMessage = operatorMessage;
    deps.log?.(operatorMessage);
    return finish({ ok: false, stopped: true, failure: "signer-mismatch", operatorMessage });
  }
  record("signer-match", true, decision.action);

  const installOut = String(deps.adb(["install", "-r", apkPath]));
  const installed = installOut.includes("Success");
  record("install", installed, redact(installOut.trim()));
  if (!installed) return finish({ ok: false, failure: "install-failed" });

  deps.adb(["shell", "am", "start", "-W", "-n", `${packageId}/.MainActivity`]);
  await deps.sleep(4000);
  const screen = deps.adb(["exec-out", "screencap", "-p"]);
  deps.writeFile(`${bundleDir}/launch-screen.png`, screen);
  record("launch", true);

  deps.adb(["shell", "am", "force-stop", packageId]);
  await deps.sleep(1000);
  const pid = tryAdb(["shell", "pidof", packageId]).trim();
  record("force-stop", pid.length === 0, pid.length === 0 ? null : "process still alive");

  deps.writeFile(`${bundleDir}/logcat.redacted.txt`, redact(String(deps.adb(["logcat", "-d", "-t", "400"]))));
  evidence.networkClass = classifyNetworkClass(deps.adb(["shell", "dumpsys", "connectivity"]));
  record("network-class", true, evidence.networkClass);

  const failedStep = steps.find((step) => !step.ok);
  if (failedStep) return finish({ ok: false, failure: failedStep.name });
  return finish({ ok: true, action: decision.action });
}
