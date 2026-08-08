#!/usr/bin/env node
// Scans a Township Android release artifact for dev traces, environment
// probes, and seeded-key markers, and asserts the embedded real CSP.
//
// The frontend bundle is embedded compressed inside the native library, so it
// is invisible to a naive APK string scan. This scanner therefore checks:
//   1. the exact `dist/` tree the build embedded (marker scan + hash record);
//   2. every decompressed APK entry for plaintext markers;
//   3. the embedded assets/tauri.conf.json for the pilot CSP policy.
//
// Usage:
//   node scripts/android-pilot/scan_pilot_artifact.mjs --apk <path> --dist <dir> [--json <out>]
// Exit codes: 0 clean; 1 findings.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  cspPolicyFailures,
  findMarkersInBytes,
  PILOT_FORBIDDEN_MARKERS,
  scanDirForMarkers,
  sha256Hex,
} from "./pilot_policy.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apk") args.apk = argv[++i];
    else if (argv[i] === "--dist") args.dist = argv[++i];
    else if (argv[i] === "--json") args.json = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.apk || !args.dist) throw new Error("--apk <path> and --dist <dir> are required");
  return args;
}

function apkEntries(apkPath) {
  const listing = execFileSync("unzip", ["-Z1", apkPath], { encoding: "utf8" });
  return listing.split("\n").filter((line) => line.length > 0 && !line.endsWith("/"));
}

function apkEntryBytes(apkPath, entry) {
  return execFileSync("unzip", ["-p", apkPath, entry], { maxBuffer: 256 * 1024 * 1024 });
}

const args = parseArgs(process.argv.slice(2));
const failures = [];

const dist = scanDirForMarkers(args.dist);
for (const finding of dist.findings) {
  failures.push(`dist marker: ${finding.marker} x${finding.count} in ${finding.file}`);
}

const apkFindings = [];
let embeddedCsp = null;
for (const entry of apkEntries(args.apk)) {
  const bytes = apkEntryBytes(args.apk, entry);
  for (const found of findMarkersInBytes(bytes)) {
    apkFindings.push({ entry, ...found });
    failures.push(`apk marker: ${found.marker} x${found.count} in ${entry}`);
  }
  if (entry === "assets/tauri.conf.json") {
    embeddedCsp = JSON.parse(bytes.toString("utf8"))?.app?.security?.csp ?? null;
  }
}
if (embeddedCsp === null && failures.every((f) => !f.startsWith("csp"))) {
  // Either the entry is missing or csp is null; both refuse below.
}
for (const failure of cspPolicyFailures(embeddedCsp)) {
  failures.push(failure);
}

const result = {
  apk: args.apk,
  apkSha256: sha256Hex(readFileSync(args.apk)),
  markers: PILOT_FORBIDDEN_MARKERS,
  embeddedCsp,
  distFiles: dist.files,
  findings: { dist: dist.findings, apk: apkFindings },
  clean: failures.length === 0,
  failures,
};
if (args.json) writeFileSync(args.json, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ ...result, distFiles: `${dist.files.length} files hashed` }, null, 2));
if (failures.length > 0) {
  console.error(`REFUSED: ${failures.length} finding(s)`);
  process.exit(1);
}
