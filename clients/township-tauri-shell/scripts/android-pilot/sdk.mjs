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

// apksigner prints the first signer either as "Signer #1 certificate ..." or,
// for SDK-ranged (v3/v3.1) signers, as "Signer (minSdkVersion=24, ...)
// certificate ...". Accept both; anything else stays null so the caller's
// fail-closed check refuses the artifact.
const SIGNER_DN_LINE = /Signer (?:#1|\([^)]+\)) certificate DN: (.+)/;
const SIGNER_SHA256_LINE = /Signer (?:#1|\([^)]+\)) certificate SHA-256 digest: ([0-9a-fA-F]+)/;

export function parseApksignerCerts(output) {
  const dn = output.match(SIGNER_DN_LINE)?.[1]?.trim() ?? null;
  const sha256 = output.match(SIGNER_SHA256_LINE)?.[1]?.toLowerCase() ?? null;
  return { dn, sha256 };
}
