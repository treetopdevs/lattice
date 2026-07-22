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

export function latestBuildToolsDir(sdkRoot = androidSdkRoot()) {
  const buildTools = join(sdkRoot, "build-tools");
  const versions = readdirSync(buildTools)
    .filter((entry) => /^\d+\.\d+\.\d+$/.test(entry))
    .sort((a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    });
  if (versions.length === 0) throw new Error(`no build-tools under ${buildTools}`);
  return join(buildTools, versions[versions.length - 1]);
}

export function buildToolPath(tool) {
  return join(latestBuildToolsDir(), tool);
}

export function adbPath() {
  return join(androidSdkRoot(), "platform-tools", "adb");
}

export function runApksignerPrintCerts(apkPath) {
  return execFileSync(buildToolPath("apksigner"), ["verify", "--print-certs", apkPath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function parseApksignerCerts(output) {
  const dn = output.match(/Signer #1 certificate DN: (.+)/)?.[1]?.trim() ?? null;
  const sha256 = output
    .match(/Signer #1 certificate SHA-256 digest: ([0-9a-f]+)/)?.[1]
    ?.toLowerCase() ?? null;
  return { dn, sha256 };
}
