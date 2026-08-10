// Android SDK tool discovery shared by the pilot verification scripts and the
// Device A harness. No secrets are read here.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function androidSdkRoot() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Library/Android/sdk"),
    "/usr/local/lib/android/sdk",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Android SDK not found; set ANDROID_HOME");
}

// The flagship workflow installs exactly this build-tools version. Tool
// selection is pinned and fail-closed: newest-wins selection on a runner with
// preinstalled SDK images can silently pick a different (or incomplete)
// apksigner whose output the verification pipeline has never seen.
export const PINNED_BUILD_TOOLS_VERSION = "36.0.0";

export function pinnedBuildToolsDir(sdkRoot = androidSdkRoot()) {
  const buildTools = join(sdkRoot, "build-tools");
  const pinned = join(buildTools, PINNED_BUILD_TOOLS_VERSION);
  if (!existsSync(pinned)) {
    const found = existsSync(buildTools) ? readdirSync(buildTools).sort().join(", ") : "(none)";
    throw new Error(
      `pinned Android build-tools ${PINNED_BUILD_TOOLS_VERSION} not found under ${buildTools}; ` +
        `installed versions: ${found}. Install it with: ` +
        `sdkmanager --install "build-tools;${PINNED_BUILD_TOOLS_VERSION}"`,
    );
  }
  return pinned;
}

export function buildToolPath(tool) {
  const path = join(pinnedBuildToolsDir(), tool);
  if (!existsSync(path)) {
    throw new Error(`${tool} missing from pinned build-tools ${PINNED_BUILD_TOOLS_VERSION} at ${path}`);
  }
  return path;
}

export function adbPath() {
  return join(androidSdkRoot(), "platform-tools", "adb");
}

export function runApksignerPrintCerts(apkPath) {
  // stderr is inherited so apksigner warnings/errors land in the job log
  // instead of vanishing; stdout is returned for parsing.
  return execFileSync(buildToolPath("apksigner"), ["verify", "--print-certs", apkPath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

export function runAapt2Badging(apkPath) {
  return execFileSync(buildToolPath("aapt2"), ["dump", "badging", apkPath], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

export function parseAapt2PackageId(output) {
  return String(output).match(/^package: name='([^']+)'/m)?.[1] ?? null;
}

// apksigner prints ordinary signers as "Signer #N certificate ..." and may
// print SDK-ranged v3/v3.1 signers as "Signer (minSdkVersion=..., ...) ...".
// Preserve every signer block. Pilot callers fail closed unless exactly one
// complete, distinct signer is present; rotation requires an explicit policy
// change instead of silently trusting the first lineage node.
const SIGNER_LINE = /^Signer (#[0-9]+|\([^)]+\)) certificate (DN|SHA-256 digest): (.+)$/gm;

export function parseApksignerCerts(output) {
  const byLabel = new Map();
  for (const match of String(output).matchAll(SIGNER_LINE)) {
    const [, label, field, rawValue] = match;
    const signer = byLabel.get(label) ?? { label, dn: null, sha256: null };
    if (field === "DN") signer.dn = rawValue.trim();
    if (field === "SHA-256 digest") signer.sha256 = rawValue.trim().toLowerCase();
    byLabel.set(label, signer);
  }
  const signers = [...byLabel.values()];
  const completeSigners = signers.filter(({ dn, sha256 }) => dn && sha256);
  const distinctSha256 = [...new Set(completeSigners.map(({ sha256 }) => sha256))];
  const soleSigner =
    signers.length > 0 && completeSigners.length === signers.length && distinctSha256.length === 1
      ? completeSigners[0]
      : null;
  return {
    dn: soleSigner?.dn ?? null,
    sha256: soleSigner?.sha256 ?? null,
    signerCount: signers.length,
    completeSignerCount: completeSigners.length,
    distinctSignerCount: distinctSha256.length,
    signers,
  };
}
