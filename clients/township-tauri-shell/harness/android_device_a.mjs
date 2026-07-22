#!/usr/bin/env node
// CLI for the non-destructive Device A harness baseline. See device_a_lib.mjs
// for the guarantees. Read-only toward existing app data: it installs,
// launches, force-stops, and observes; it never uninstalls, never clears app
// data, and never touches adb reverse mappings.
//
// Usage:
//   ANDROID_SERIAL=<serial> node harness/android_device_a.mjs \
//     --apk <path> --mode release|dev [--out output/device-a]

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { adbPath, parseApksignerCerts, runApksignerPrintCerts } from "../scripts/android-pilot/sdk.mjs";
import { runDeviceAHarness } from "./device_a_lib.mjs";

// Resolve the git SHA of the checkout that contains this harness, never the
// caller's working directory.
const harnessRepoDir = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { out: "output/device-a", mode: "release" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apk") args.apk = argv[++i];
    else if (argv[i] === "--mode") args.mode = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.apk) throw new Error("--apk <path> is required");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const serial = process.env.ANDROID_SERIAL;
if (!serial) {
  console.error("ANDROID_SERIAL is required; the harness never guesses a device");
  process.exit(2);
}

const adb = (adbArgs) =>
  execFileSync(adbPath(), ["-s", serial, ...adbArgs], { maxBuffer: 64 * 1024 * 1024 });

const deps = {
  adb: (adbArgs) => adb(adbArgs),
  apksignerCerts: (apkPath) => parseApksignerCerts(runApksignerPrintCerts(apkPath)),
  readFileBytes: (path) => readFileSync(path),
  writeFile: (path, data) => writeFileSync(path, data),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  gitSha: () => execFileSync("git", ["-C", harnessRepoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.error(line),
};

const result = await runDeviceAHarness(
  { serial, apkPath: args.apk, mode: args.mode, outDir: args.out },
  deps,
);

console.log(JSON.stringify({ ok: result.ok, status: result.evidence.status, bundleDir: result.bundleDir }, null, 2));
if (result.stopped) {
  console.error(result.operatorMessage);
  process.exit(3);
}
process.exit(result.ok ? 0 : 1);
