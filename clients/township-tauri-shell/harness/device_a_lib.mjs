// Non-destructive Device A acceptance-harness baseline (plan 158 "Physical
// Device Acceptance Harness", Wave A1 slice).
//
// Guarantees enforced here and pinned by test/android_device_harness_contract.mjs:
// - the device is selected only through ANDROID_SERIAL;
// - a release run FAILS if any adb reverse mapping exists, and the harness
//   never deletes a mapping it did not create (it creates none);
// - a signer mismatch against the installed package captures only baseline
//   signing/device metadata, STOPS, and requires explicit operator approval before
//   anyone uninstalls dev.treetop.lattice.township — the harness itself never
//   uninstalls, never runs `pm clear`, and never wipes anything;
// - evidence bundles are keyed by git SHA + APK SHA-256 + capture/run identity and never contain
//   private keys, capability payloads, pairing QR contents, full device
//   serials, raw screenshots, general logcat, or user content.

import { createHash, randomUUID } from "node:crypto";
import {
  ANDROID_DEBUG_CERT_DN_MARKER,
  pilotPinStatus,
  TOWNSHIP_PILOT_CERT_SHA256,
  TOWNSHIP_PACKAGE_ID,
} from "../scripts/android-pilot/pilot_policy.mjs";

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

export function evidenceKey(gitSha, apkSha256, capturedAt, runId) {
  const timestamp = String(capturedAt).replace(/[^0-9]/g, "").slice(0, 17);
  const nonce = String(runId).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 36);
  return `${String(gitSha).slice(0, 12)}-${String(apkSha256).slice(0, 12)}-${timestamp}-${nonce}`;
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

export function installOutcome(output) {
  const text = String(output);
  if (/^Success\s*$/m.test(text)) return { ok: true, detail: "success" };
  const code = text.match(/\bINSTALL_[A-Z0-9_]+\b/)?.[0];
  if (/failed to stat/i.test(text)) return { ok: false, detail: "ADB_FAILED_TO_STAT" };
  if (/device offline/i.test(text)) return { ok: false, detail: "ADB_DEVICE_OFFLINE" };
  if (/no devices?\b/i.test(text)) return { ok: false, detail: "ADB_NO_DEVICE" };
  if (/more than one device/i.test(text)) return { ok: false, detail: "ADB_MULTIPLE_DEVICES" };
  return { ok: false, detail: code ?? "failed" };
}

function launchOutcome(output) {
  const text = String(output);
  const status = text.match(/^Status:\s*([^\r\n]+)$/m)?.[1]?.trim() ?? "missing";
  const activity = text.match(/^Activity:\s*([^\r\n]+)$/m)?.[1]?.trim() ?? null;
  const totalTime = text.match(/^TotalTime:\s*(\d+)$/m)?.[1] ?? null;
  return {
    ok: status.toLowerCase() === "ok",
    detail: [
      `status=${status}`,
      ...(activity ? [`activity=${activity}`] : []),
      ...(totalTime ? [`totalTimeMs=${totalTime}`] : []),
    ].join(" "),
  };
}

function pidProbe(result) {
  const pid = result.output.trim();
  if (result.ok) return { reachable: true, running: pid.length > 0 };
  // Android's pidof exits 1 with no stdout/stderr when no process matches.
  if (result.exitCode === 1 && pid.length === 0) {
    return { reachable: true, running: false };
  }
  return { reachable: false, running: false };
}

function operatorStopMessage(installedCert, artifactCert) {
  return [
    `Installed ${TOWNSHIP_PACKAGE_ID} is signed by a different certificate than the artifact`,
    `(installed ${installedCert ?? "unknown"}, artifact ${artifactCert}).`,
    "Android will not accept this as an in-place update. Baseline signing and device metadata were captured.",
    "STOPPING: uninstalling requires EXPLICIT OPERATOR APPROVAL for exactly",
    `${TOWNSHIP_PACKAGE_ID} (one-time debug->pilot reset, discards the dev key and fixture state).`,
    "This harness never uninstalls, never runs `pm clear`, and never wipes anything itself.",
  ].join(" ");
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeCertSha256(value) {
  return String(value ?? "").replaceAll(":", "").trim().toLowerCase();
}

function isSha256Hex(value) {
  return /^[0-9a-f]{64}$/.test(value);
}

function isAndroidDebugCertificate({ dn }) {
  return String(dn ?? "").includes(ANDROID_DEBUG_CERT_DN_MARKER);
}

function normalizedSignerInspection(certs = {}) {
  const inferredCount = certs.dn || certs.sha256 ? 1 : 0;
  return {
    ...certs,
    signerCount: Number.isInteger(certs.signerCount) ? certs.signerCount : inferredCount,
    completeSignerCount: Number.isInteger(certs.completeSignerCount)
      ? certs.completeSignerCount
      : inferredCount,
    distinctSignerCount: Number.isInteger(certs.distinctSignerCount)
      ? certs.distinctSignerCount
      : inferredCount,
  };
}

function hasExactlyOneSigner(certs) {
  return (
    certs.signerCount > 0 &&
    certs.completeSignerCount === certs.signerCount &&
    certs.distinctSignerCount === 1
  );
}

// Required deps: adb(argsArray) -> string|Buffer,
// apksignerCerts(apkPath) -> {dn, sha256, signerCount, distinctSignerCount},
// apkPackageId(apkPath) -> string|null, readFileBytes(path) -> Buffer,
// writeFile(path, data), mkdir(path), temporaryFile(name), removeFile(path),
// gitSha() -> string, sleep(ms), log(line). Optional deps: now() -> Date and
// evidenceRunId() -> string; secure defaults provide capture/run identity.
export async function runDeviceAHarness(options, deps) {
  const {
    serial,
    apkPath,
    mode,
    outDir,
    packageId = TOWNSHIP_PACKAGE_ID,
    expectedPilotCertSha256,
    repositoryPin = TOWNSHIP_PILOT_CERT_SHA256,
    allowDevMode = false,
  } = options;
  if (!serial) throw new Error("ANDROID_SERIAL is required; the harness never guesses a device");
  if (!["release", "dev"].includes(mode)) throw new Error(`unknown mode ${mode}`);
  if (mode === "dev" && allowDevMode !== true) {
    throw new Error("dev mode requires the explicit --allow-dev-mode opt-out");
  }

  const redact = (text) => redactEvidenceText(text, { serial });
  const steps = [];
  const record = (name, ok, detail = null) => {
    const detailText = detail == null ? null : String(detail);
    const safeDetail = /^(?:INSTALL|ADB)_[A-Z0-9_]+$/.test(detailText ?? "")
      ? detailText
      : detailText
        ? redact(detailText)
            .replace(/[\u0000-\u001f\u007f]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        : null;
    steps.push({ name, ok, ...(safeDetail ? { detail: safeDetail } : {}) });
  };
  const callAdb = (args) => {
    try {
      return { ok: true, output: String(deps.adb(args)), exitCode: 0 };
    } catch (error) {
      return {
        ok: false,
        output: [error?.stdout, error?.stderr]
          .filter((part) => part != null)
          .map(String)
          .join("\n"),
        exitCode: Number.isInteger(error?.status) ? error.status : null,
      };
    }
  };
  const reportAdbFailure = (label, result) => {
    if (result.ok) return;
    const diagnostic = redact(result.output || "no adb diagnostic available").slice(0, 4_096);
    deps.log?.(`${label}: ${diagnostic}`);
  };
  const reportToolFailure = (label, error) => {
    const diagnostic = redact(error?.message ?? String(error)).slice(0, 4_096);
    deps.log?.(`${label}: ${diagnostic}`);
  };

  const gitSha = deps.gitSha();
  const apkBytes = deps.readFileBytes(apkPath);
  const apkSha256 = sha256Hex(apkBytes);
  let artifactCerts = normalizedSignerInspection();
  let artifactSignerInspectionError = null;
  try {
    artifactCerts = normalizedSignerInspection(deps.apksignerCerts(apkPath));
  } catch (error) {
    artifactSignerInspectionError = error;
  }
  const artifactCertSha256 = normalizeCertSha256(artifactCerts.sha256);
  const expectedCertSha256 = normalizeCertSha256(expectedPilotCertSha256);
  const repositoryPinStatus = pilotPinStatus(expectedCertSha256, repositoryPin);
  const pinSource = repositoryPinStatus === "matched" ? "repository" : "explicit-flag";
  const capturedAt = (deps.now?.() ?? new Date()).toISOString();
  const runId = deps.evidenceRunId?.() ?? randomUUID();
  const bundleDir = `${outDir}/${evidenceKey(gitSha, apkSha256, capturedAt, runId)}`;
  deps.mkdir(bundleDir);

  const evidence = {
    schema: 1,
    packageId,
    mode,
    gitSha,
    apkSha256,
    artifactSignerCertSha256: artifactCertSha256 || null,
    artifactSignerDn: artifactCerts.dn,
    artifactSignerBlockCount: artifactCerts.signerCount,
    artifactDistinctSignerCount: artifactCerts.distinctSignerCount,
    expectedPilotCertSha256: expectedCertSha256 || null,
    pinSource: mode === "release" ? pinSource : "not-required",
    serial: redactSerial(serial),
    capturedAt,
    device: {},
    networkClass: "unknown",
    reverseMappings: null,
    installedPackageState: "unread",
    steps,
    status: "incomplete",
  };

  const finish = (result) => {
    evidence.status = result.ok ? "passed" : result.failure ?? "failed";
    deps.writeFile(`${bundleDir}/evidence.json`, `${JSON.stringify(evidence, null, 2)}\n`);
    const inline = (value, fallback) => {
      if (value == null || value === "") return fallback;
      return redact(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    };
    const fingerprint = (value, fallback) =>
      /^[0-9a-f]{64}$/.test(String(value ?? "")) ? value : inline(value, fallback);
    const installedSignerDisplay = evidence.installedPackageState === "absent"
      ? "package absent"
      : inline(evidence.installedSignerCertSha256, "not read");
    const installedDnDisplay = evidence.installedPackageState === "absent"
      ? "package absent"
      : inline(evidence.installedSignerDn, "not read");
    deps.writeFile(
      `${bundleDir}/evidence.md`,
      [
        `# Device A harness evidence (${evidence.status})`,
        "",
        `- Package: ${packageId}`,
        `- Mode: ${mode}`,
        `- Git SHA: ${gitSha}`,
        `- APK SHA-256: ${apkSha256}`,
        `- Artifact signer cert SHA-256: ${fingerprint(evidence.artifactSignerCertSha256, "not read")}`,
        `- Artifact signer DN: ${inline(evidence.artifactSignerDn, "not read")}`,
        `- Artifact signer blocks: ${evidence.artifactSignerBlockCount}`,
        `- Artifact distinct signer certificates: ${evidence.artifactDistinctSignerCount}`,
        `- Expected pilot cert SHA-256: ${fingerprint(evidence.expectedPilotCertSha256, "not required")}`,
        `- Pin source: ${inline(evidence.pinSource, "not required")}`,
        `- Installed package state: ${evidence.installedPackageState}`,
        `- Installed signer cert SHA-256: ${fingerprint(evidence.installedSignerCertSha256, installedSignerDisplay)}`,
        `- Installed signer DN: ${installedDnDisplay}`,
        `- ADB reverse mappings: ${evidence.reverseMappings ?? "not read"}`,
        `- Device: ${inline(evidence.device.model, "unknown")} (Android ${inline(evidence.device.os, "?")}, API ${inline(evidence.device.api, "?")}, ${inline(evidence.device.abi, "?")})`,
        `- Network class: ${inline(evidence.networkClass, "unknown")}`,
        `- Serial (redacted): ${evidence.serial}`,
        ...(evidence.operatorMessage
          ? [
              `- Operator stop: signer mismatch; installed ${fingerprint(evidence.installedSignerCertSha256, "unknown")}; artifact ${fingerprint(evidence.artifactSignerCertSha256, "unknown")}; explicit approval is required before any reset.`,
            ]
          : []),
        "",
        ...steps.map((step) => `- [${step.ok ? "x" : " "}] ${step.name}${step.detail ? ` — ${step.detail}` : ""}`),
        "",
      ].join("\n"),
    );
    return { ...result, bundleDir, evidence };
  };

  if (artifactSignerInspectionError) {
    reportToolFailure("Artifact signer inspection unavailable", artifactSignerInspectionError);
    record("artifact-signer-verified", false, "signer inspection unavailable");
    return finish({ ok: false, failure: "artifact-signer-uninspectable" });
  }

  if (!hasExactlyOneSigner(artifactCerts)) {
    record(
      "artifact-signer-verified",
      false,
      `expected one distinct signer; found ${artifactCerts.signerCount} blocks / ${artifactCerts.distinctSignerCount} distinct certificates`,
    );
    return finish({ ok: false, failure: "artifact-signer-count" });
  }

  let artifactPackageId;
  try {
    artifactPackageId = deps.apkPackageId(apkPath);
  } catch (error) {
    reportToolFailure("Artifact package inspection unavailable", error);
    record("artifact-package-verified", false, "package inspection unavailable");
    return finish({ ok: false, failure: "artifact-package-uninspectable" });
  }
  if (artifactPackageId !== packageId) {
    record("artifact-package-verified", false, `artifact package ${artifactPackageId ?? "missing"} is not ${packageId}`);
    return finish({ ok: false, failure: "artifact-package-mismatch" });
  }
  record("artifact-package-verified", true, packageId);

  if (mode === "release" && !isSha256Hex(expectedCertSha256)) {
    record("artifact-signer-verified", false, "pilot certificate pin missing");
    return finish({ ok: false, failure: "artifact-unpinned" });
  }
  if (mode === "release" && repositoryPinStatus === "mismatched") {
    record("artifact-signer-verified", false, "supplied pin differs from reviewed repository pin");
    return finish({ ok: false, failure: "artifact-pin-override" });
  }
  if (!isSha256Hex(artifactCertSha256)) {
    record("artifact-signer-verified", false, "artifact certificate fingerprint invalid");
    return finish({ ok: false, failure: "artifact-signer-invalid" });
  }
  if (mode === "release" && isAndroidDebugCertificate(artifactCerts)) {
    record("artifact-signer-verified", false, "Android debug certificate refused");
    return finish({ ok: false, failure: "artifact-debug-signed" });
  }
  if (mode === "release" && artifactCertSha256 !== expectedCertSha256) {
    record("artifact-signer-verified", false, "artifact certificate does not match pilot pin");
    return finish({ ok: false, failure: "artifact-signer-mismatch" });
  }
  if (mode === "release") {
    record("artifact-signer-verified", true, `${pinSource} pin`);
  } else {
    record("artifact-signer-skipped", true, "not required in dev mode");
  }

  const stateResult = callAdb(["get-state"]);
  const state = stateResult.output.trim();
  record("device-online", stateResult.ok && state === "device", stateResult.ok ? state : "query failed");
  if (!stateResult.ok || state !== "device") {
    reportAdbFailure("ADB get-state failed", stateResult);
    return finish({ ok: false, failure: "device-offline" });
  }

  const deviceResults = {
    model: callAdb(["shell", "getprop", "ro.product.model"]),
    os: callAdb(["shell", "getprop", "ro.build.version.release"]),
    api: callAdb(["shell", "getprop", "ro.build.version.sdk"]),
    abi: callAdb(["shell", "getprop", "ro.product.cpu.abi"]),
  };
  const deviceMetadataOk = Object.values(deviceResults).every(
    (result) => result.ok && result.output.trim().length > 0,
  );
  evidence.device = Object.fromEntries(
    Object.entries(deviceResults).map(([key, result]) => [key, result.ok ? result.output.trim() : "unknown"]),
  );
  record(
    "device-versions",
    deviceMetadataOk,
    deviceMetadataOk ? `${evidence.device.model} API ${evidence.device.api}` : "metadata query failed",
  );
  if (!deviceMetadataOk) {
    for (const [field, result] of Object.entries(deviceResults)) {
      if (!result.ok) reportAdbFailure(`ADB ${field} metadata query failed`, result);
    }
    deps.log?.("Required device metadata was unavailable");
    return finish({ ok: false, failure: "device-versions" });
  }

  const reverseResult = callAdb(["reverse", "--list"]);
  if (!reverseResult.ok) {
    reportAdbFailure("ADB reverse query failed", reverseResult);
    record(mode === "release" ? "adb-reverse-clean" : "adb-reverse-state", false, "mapping query failed");
    return finish({ ok: false, failure: "adb-reverse-query" });
  }
  const reverse = parseReverseList(reverseResult.output);
  evidence.reverseMappings = reverse.length;
  if (mode === "release" && reverse.length > 0) {
    // Never delete a mapping this run did not create — and this baseline
    // harness never creates one, so it never deletes any.
    record("adb-reverse-clean", false, `${reverse.length} mapping(s) present; release run refused`);
    return finish({ ok: false, failure: "adb-reverse-present" });
  }
  if (mode === "release") {
    record("adb-reverse-clean", true, "0 mappings");
  } else {
    record("adb-reverse-state", true, `${reverse.length} mapping(s) observed; dev mode does not enforce clean state`);
  }

  const pmPath = callAdb(["shell", "pm", "path", packageId]);
  let packagePresent = pmPath.ok && pmPath.output.includes("package:");
  const cleanAbsentShape = !pmPath.ok && pmPath.exitCode === 1 && pmPath.output.trim().length === 0;
  const needsPackageListCrossCheck =
    (!pmPath.ok && !cleanAbsentShape) ||
    (pmPath.ok && !packagePresent && pmPath.output.trim().length > 0);
  if (needsPackageListCrossCheck) {
    const listed = callAdb(["shell", "pm", "list", "packages", packageId]);
    if (!listed.ok) {
      reportAdbFailure("ADB package-state query failed", pmPath);
      reportAdbFailure("ADB package-list fallback failed", listed);
      record("package-state", false, "query failed");
      return finish({ ok: false, failure: "package-state" });
    }
    const exactPackage = new RegExp(`^package:${packageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");
    packagePresent = exactPackage.test(listed.output.trim());
    if (packagePresent) {
      reportAdbFailure("ADB installed package path unavailable", pmPath);
      record("package-state", false, "package listed but APK path unavailable");
      return finish({ ok: false, failure: "package-state" });
    }
  }
  evidence.installedPackageState = packagePresent ? "present" : "absent";
  record("package-state", true, packagePresent ? "present" : "absent");
  let installedCertSha256 = null;
  let installedDn = null;
  if (packagePresent) {
    const remoteApk = pmPath.output.split("package:")[1].split("\n")[0].trim();
    const pulledPath = deps.temporaryFile("installed-base.apk");
    let installedSignerFailure = null;
    try {
      const pull = callAdb(["pull", remoteApk, pulledPath]);
      if (!pull.ok) {
        reportAdbFailure("ADB installed-APK pull failed", pull);
        record("installed-signer-read", false, "installed APK pull failed");
        installedSignerFailure = "installed-signer-read";
      } else {
        let installedCerts;
        try {
          installedCerts = normalizedSignerInspection(deps.apksignerCerts(pulledPath));
        } catch (error) {
          reportToolFailure("Installed signer inspection unavailable", error);
          record("installed-signer-read", false, "signer inspection unavailable");
          installedSignerFailure = "installed-signer-uninspectable";
        }
        if (installedCerts && !hasExactlyOneSigner(installedCerts)) {
          record("installed-signer-read", false, "installed APK does not have exactly one signer");
          installedSignerFailure = "installed-signer-count";
        } else if (installedCerts && !isSha256Hex(normalizeCertSha256(installedCerts.sha256))) {
          record("installed-signer-read", false, "installed signer fingerprint invalid");
          installedSignerFailure = "installed-signer-invalid";
        }
        const inspectedCertSha256 = normalizeCertSha256(installedCerts?.sha256);
        if (!installedSignerFailure) {
          installedCertSha256 = inspectedCertSha256;
          installedDn = installedCerts.dn;
        }
      }
    } finally {
      try {
        deps.removeFile(pulledPath);
      } catch (error) {
        reportToolFailure("Temporary installed-APK cleanup failed", error);
        record("temp-cleanup-warning", true, "installed APK temporary file could not be removed");
      }
    }
    if (installedSignerFailure) return finish({ ok: false, failure: installedSignerFailure });
  }
  evidence.installedSignerCertSha256 = installedCertSha256;
  evidence.installedSignerDn = installedDn;
  if (packagePresent) record("installed-signer-read", true, "package present");

  const decision = decideInstallAction({
    packagePresent,
    installedCertSha256,
    artifactCertSha256,
  });

  if (decision.action === "stop-signer-mismatch") {
    // The signer fingerprints plus structured device metadata are sufficient
    // for the operator's reset decision. Do not capture user-visible pixels
    // or general logcat merely to hash or redact them.
    const network = callAdb(["shell", "dumpsys", "connectivity"]);
    reportAdbFailure("ADB network classification failed", network);
    evidence.networkClass = network.ok ? classifyNetworkClass(network.output) : "unknown";
    record("network-class", network.ok, evidence.networkClass);
    record("signer-match", false, "installed signer differs from artifact signer");
    const operatorMessage = operatorStopMessage(installedCertSha256, artifactCertSha256);
    evidence.operatorMessage = operatorMessage;
    deps.log?.(operatorMessage);
    return finish({ ok: false, stopped: true, failure: "signer-mismatch", operatorMessage });
  }
  record("signer-match", true, decision.action);

  const installResult = callAdb(["install", "-r", apkPath]);
  const installOut = installResult.output;
  const parsedInstall = installOutcome(installOut);
  const install = installResult.ok
    ? parsedInstall
    : { ok: false, detail: parsedInstall.ok ? "ADB_NONZERO_EXIT" : parsedInstall.detail };
  // Installer output is neither evidence nor a log payload: OEM tooling may
  // echo paths or device-local text. Retain only Success or a structured code.
  record("install", install.ok, install.detail);
  if (!install.ok) {
    // Raw installer output is intentionally not logged: OEM wrappers may echo
    // local paths or user-controlled package metadata. Other ADB probes have
    // bounded redacted diagnostics; install retains only this structured code.
    reportAdbFailure("ADB install failed", { ...installResult, ok: false, output: install.detail });
    deps.log?.(`ADB install refused: ${install.detail}`);
    return finish({ ok: false, failure: "install-failed" });
  }

  // The install command's Success line is not evidence that the intended
  // bytes landed. Pull the installed base APK and compare both its signer and
  // exact digest with the artifact verified before contacting the device.
  // APK Signature Schemes v2/v3 cover the complete signed file, so Android
  // cannot re-align or ABI-filter base.apk without invalidating its signature;
  // unreadable OEM app directories are reported separately from byte mismatch.
  const postInstallPath = callAdb(["shell", "pm", "path", packageId]);
  const installedRemoteApk = postInstallPath.ok
    ? postInstallPath.output.match(/^package:([^\r\n]+)$/m)?.[1]?.trim()
    : null;
  if (!installedRemoteApk) {
    reportAdbFailure("ADB post-install package query failed", postInstallPath);
    record("installed-artifact-readable", false, "installed package path unavailable; artifact remains installed but unverified");
    return finish({ ok: false, failure: "installed-artifact-unreadable" });
  }
  const postInstallPulled = deps.temporaryFile("post-install-base.apk");
  let postInstallFailure = null;
  try {
    const pull = callAdb(["pull", installedRemoteApk, postInstallPulled]);
    if (!pull.ok) {
      reportAdbFailure("ADB post-install APK pull failed", pull);
      record("installed-artifact-readable", false, "installed APK pull failed; artifact remains installed but unverified");
      postInstallFailure = "installed-artifact-unreadable";
    } else {
      record("installed-artifact-readable", true, "installed APK pulled for verification");
      let installedArtifactCerts;
      let installedArtifactSha256;
      try {
        installedArtifactCerts = normalizedSignerInspection(deps.apksignerCerts(postInstallPulled));
        installedArtifactSha256 = sha256Hex(deps.readFileBytes(postInstallPulled));
      } catch (error) {
        reportToolFailure("Post-install APK inspection unavailable", error);
        record("installed-artifact-verified", false, "inspection unavailable");
        postInstallFailure = "installed-artifact-uninspectable";
      }
      if (installedArtifactCerts && !hasExactlyOneSigner(installedArtifactCerts)) {
        record("installed-artifact-verified", false, "installed APK does not have exactly one signer");
        postInstallFailure = "installed-artifact-signer-count";
      }
      if (!postInstallFailure) {
        const installedArtifactCert = normalizeCertSha256(installedArtifactCerts.sha256);
        const installedArtifactMatches =
          installedArtifactCert === artifactCertSha256 && installedArtifactSha256 === apkSha256;
        record(
          "installed-artifact-verified",
          installedArtifactMatches,
          installedArtifactMatches ? "exact APK bytes and signer match" : "installed APK differs from artifact",
        );
        if (!installedArtifactMatches) postInstallFailure = "installed-artifact-verified";
      }
    }
  } finally {
    try {
      deps.removeFile(postInstallPulled);
    } catch (error) {
      reportToolFailure("Temporary post-install APK cleanup failed", error);
      record("temp-cleanup-warning", true, "post-install APK temporary file could not be removed");
    }
  }
  if (postInstallFailure) return finish({ ok: false, failure: postInstallFailure });

  const launchResult = callAdb(["shell", "am", "start", "-W", "-n", `${packageId}/.MainActivity`]);
  reportAdbFailure("ADB launch failed", launchResult);
  const launch = launchOutcome(launchResult.output);
  record("launch", launch.ok, launch.detail);
  if (!launch.ok) {
    callAdb(["shell", "am", "force-stop", packageId]);
    return finish({ ok: false, failure: "launch" });
  }
  await deps.sleep(4000);
  const running = callAdb(["shell", "pidof", packageId]);
  const runningState = pidProbe(running);
  if (!runningState.reachable) reportAdbFailure("ADB process-liveness query failed", running);
  record(
    "process-alive",
    runningState.reachable && runningState.running,
    runningState.reachable ? (runningState.running ? "running" : "not running") : "query failed",
  );
  if (!runningState.reachable || !runningState.running) {
    callAdb(["shell", "am", "force-stop", packageId]);
    return finish({ ok: false, failure: "process-alive" });
  }

  const stopped = callAdb(["shell", "am", "force-stop", packageId]);
  reportAdbFailure("ADB force-stop failed", stopped);
  await deps.sleep(1000);
  const stoppedPid = callAdb(["shell", "pidof", packageId]);
  const stoppedState = pidProbe(stoppedPid);
  if (!stoppedState.reachable) reportAdbFailure("ADB force-stop verification failed", stoppedPid);
  record(
    "force-stop",
    stopped.ok && stoppedState.reachable && !stoppedState.running,
    stopped.ok && stoppedState.reachable
      ? (stoppedState.running ? "process still alive" : null)
      : "command failed",
  );

  const network = callAdb(["shell", "dumpsys", "connectivity"]);
  reportAdbFailure("ADB network classification failed", network);
  evidence.networkClass = network.ok ? classifyNetworkClass(network.output) : "unknown";
  record("network-class", network.ok, evidence.networkClass);

  const failedStep = steps.find((step) => !step.ok);
  if (failedStep) return finish({ ok: false, failure: failedStep.name });
  return finish({ ok: true, action: decision.action });
}
