#!/usr/bin/env node
// CLI for the non-destructive Device A harness baseline. See device_a_lib.mjs
// for the guarantees. Read-only toward existing app data: it installs,
// launches, force-stops, and observes; it never uninstalls, never clears app
// data, and never touches adb reverse mappings.
//
// Usage:
//   ANDROID_SERIAL=<serial> node harness/android_device_a.mjs \
//     --apk <path> --mode release \
//     --expected-pilot-cert-sha256 <hex> [--out output/device-a]
//   ANDROID_SERIAL=<serial> node harness/android_device_a.mjs \
//     --apk <path> --mode dev --allow-dev-mode [--out output/device-a]

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  adbPath,
  parseAapt2PackageId,
  parseApksignerCerts,
  runAapt2Badging,
  runApksignerPrintCerts,
} from "../scripts/android-pilot/sdk.mjs";
import { runDeviceAHarness } from "./device_a_lib.mjs";

// Resolve the git SHA of the checkout that contains this harness, never the
// caller's working directory.
const harnessRepoDir = dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const args = { out: "output/device-a", mode: "release" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apk") args.apk = argv[++i];
    else if (argv[i] === "--mode") args.mode = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--expected-pilot-cert-sha256") args.expectedPilotCertSha256 = argv[++i];
    else if (argv[i] === "--allow-dev-mode") args.allowDevMode = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.apk) throw new Error("--apk <path> is required");
  return args;
}

export function harnessOptions(args, env) {
  if (!env.ANDROID_SERIAL) {
    throw new Error("ANDROID_SERIAL is required; the harness never guesses a device");
  }
  if (!["release", "dev"].includes(args.mode)) throw new Error(`unknown mode ${args.mode}`);
  if (args.mode === "dev" && args.allowDevMode !== true) {
    throw new Error("dev mode requires the explicit --allow-dev-mode opt-out");
  }
  return {
    serial: env.ANDROID_SERIAL,
    apkPath: args.apk,
    mode: args.mode,
    outDir: args.out,
    expectedPilotCertSha256: args.expectedPilotCertSha256,
    allowDevMode: args.allowDevMode,
  };
}

export function createDeviceDeps(serial, runtime = {}) {
  const runFile = runtime.execFileSync ?? execFileSync;
  const makeUuid = runtime.randomUUID ?? randomUUID;
  const makeDir = runtime.mkdirSync ?? mkdirSync;
  const readFile = runtime.readFileSync ?? readFileSync;
  const resolveAdbPath = runtime.adbPath ?? adbPath;
  const removeFile = runtime.rmSync ?? rmSync;
  const tempDir = runtime.tmpdir ?? tmpdir;
  const writeFile = runtime.writeFileSync ?? writeFileSync;
  const signerCerts = runtime.apksignerCerts ?? ((apkPath) =>
    parseApksignerCerts(runApksignerPrintCerts(apkPath)));
  const adb = (adbArgs) =>
    runFile(resolveAdbPath(), ["-s", serial, ...adbArgs], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });

  return {
    adb,
    apksignerCerts: signerCerts,
    apkPackageId: (path) => parseAapt2PackageId(runAapt2Badging(path)),
    readFileBytes: (path) => readFile(path),
    writeFile: (path, data) => writeFile(path, data),
    mkdir: (path) => makeDir(path, { recursive: true }),
    temporaryFile: (name) => join(tempDir(), `township-device-a-${makeUuid()}-${name}`),
    evidenceRunId: () => makeUuid(),
    removeFile: (path) => removeFile(path, { force: true }),
    gitSha: () => runFile("git", ["-C", harnessRepoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    log: (line) => console.error(line),
  };
}

async function main() {
  let args;
  let options;
  try {
    args = parseArgs(process.argv.slice(2));
    options = harnessOptions(args, process.env);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  const deps = createDeviceDeps(options.serial);
  let result;
  try {
    result = await runDeviceAHarness(options, deps);
  } catch (error) {
    console.error(`Harness infrastructure error: ${error.message}`);
    process.exitCode = 4;
    return;
  }

  console.log(JSON.stringify({ ok: result.ok, status: result.evidence.status, bundleDir: result.bundleDir }, null, 2));
  if (result.stopped) {
    console.error(result.operatorMessage);
    process.exitCode = 3;
    return;
  }
  process.exitCode = result.ok ? 0 : 1;
}

const invokedAsMain = process.argv[1]
  ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url
  : false;
if (invokedAsMain) await main();
