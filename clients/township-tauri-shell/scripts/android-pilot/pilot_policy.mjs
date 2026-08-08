// Shared policy constants and pure helpers for the Township Android pilot
// distribution lane (plan 158 "Signed Android Internal Distribution").
//
// The pilot artifact must be signed by the external township-pilot-v1 key and
// must not carry dev traces, environment probes, or seeded-key paths. The
// frontend bundle is embedded compressed inside the native library, so probe
// markers are scanned on the exact `dist/` tree the build embedded, while the
// APK itself is scanned for plaintext markers and its embedded tauri.conf.json
// is checked for the real Content-Security-Policy.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const TOWNSHIP_PILOT_KEY_ALIAS = "township-pilot-v1";
export const TOWNSHIP_PACKAGE_ID = "dev.treetop.lattice.township";
export const ANDROID_DEBUG_CERT_DN_MARKER = "CN=Android Debug";

// Forbidden in a pilot artifact: probe surfaces, env-seeded configuration, and
// the Android-emulator host-loopback address. Kept in sync with the
// src/township_*_probe.ts log prefixes and env key constants.
export const PILOT_FORBIDDEN_MARKERS = [
  "township-release-transport-probe",
  "township-release-beam-probe",
  "township-release-sync-probe",
  "township-release-author-probe",
  "township-release-pairing-probe",
  "township-release-onboarding-probe",
  "township-release-root-origination-probe",
  "township-canonical-probe",
  "township-ios-key-reuse-probe",
  "township-packaged-onboarding",
  "VITE_TOWNSHIP_RELEASE_",
  "VITE_TOWNSHIP_PACKAGED_ONBOARDING",
  "VITE_TOWNSHIP_IOS_KEY_REUSE_PROBE",
  "10.0.2.2",
];

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function findMarkersInBytes(bytes, markers = PILOT_FORBIDDEN_MARKERS) {
  const text = bytes.toString("latin1");
  const found = [];
  for (const marker of markers) {
    let count = 0;
    let index = text.indexOf(marker);
    while (index !== -1) {
      count += 1;
      index = text.indexOf(marker, index + marker.length);
    }
    if (count > 0) found.push({ marker, count });
  }
  return found;
}

export function listFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out.sort();
}

export function scanDirForMarkers(dir, markers = PILOT_FORBIDDEN_MARKERS) {
  const findings = [];
  const files = [];
  for (const file of listFilesRecursive(dir)) {
    const bytes = readFileSync(file);
    files.push({ file, sha256: sha256Hex(bytes), size: bytes.length });
    for (const found of findMarkersInBytes(bytes, markers)) {
      findings.push({ file, ...found });
    }
  }
  return { files, findings };
}

// A pilot CSP must exist, must allow encrypted WebSocket transport, must not
// allow eval, and may only allow cleartext ws:// toward loopback.
export function cspPolicyFailures(csp) {
  const failures = [];
  if (typeof csp !== "string" || csp.trim().length === 0) {
    return ["csp missing: embedded tauri.conf.json must carry a real Content-Security-Policy"];
  }
  if (!csp.includes("wss:")) failures.push("csp does not allow wss: carrier transport");
  if (csp.includes("unsafe-eval")) failures.push("csp allows unsafe-eval");
  if (!/default-src [^;]*'self'/.test(csp)) failures.push("csp default-src must be 'self'");
  for (const match of csp.matchAll(/ws:\/\/([^\s;:/]+)/g)) {
    const host = match[1];
    if (host !== "127.0.0.1" && host !== "localhost") {
      failures.push(`csp allows cleartext ws:// to non-loopback host ${host}`);
    }
  }
  return failures;
}
