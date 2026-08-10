#!/usr/bin/env node
// Emits the machine-readable build manifest that accompanies every Township
// Android artifact: APK SHA-256, signing certificate fingerprint, git SHA,
// version identifiers, and lineage. Never includes secrets or keystore paths.
//
// Usage:
//   node scripts/android-pilot/emit_build_manifest.mjs --apk <path> \
//     --lineage pilot|dev-smoke|ephemeral-ci-throwaway --out <dir>

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseApksignerCerts, runAapt2Badging, runApksignerPrintCerts } from "./sdk.mjs";
import {
  pilotPinStatus,
  sha256Hex,
  TOWNSHIP_PACKAGE_ID,
  TOWNSHIP_PILOT_CERT_SHA256,
  TOWNSHIP_PILOT_KEY_ALIAS,
} from "./pilot_policy.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apk") args.apk = argv[++i];
    else if (argv[i] === "--lineage") args.lineage = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--expected-cert-sha256") args.expectedCertSha256 = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.apk || !args.lineage || !args.out) {
    throw new Error("--apk, --lineage, and --out are required");
  }
  if (!["pilot", "dev-smoke", "ephemeral-ci-throwaway"].includes(args.lineage)) {
    throw new Error(`unknown lineage ${args.lineage}`);
  }
  return args;
}

function badging(apkPath) {
  const output = runAapt2Badging(apkPath);
  const header = output.match(
    /package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/,
  );
  return header
    ? { packageId: header[1], versionCode: Number(header[2]), versionName: header[3] }
    : { packageId: null, versionCode: null, versionName: null };
}

const args = parseArgs(process.argv.slice(2));
const apkBytes = readFileSync(args.apk);
const certs = parseApksignerCerts(runApksignerPrintCerts(args.apk));
const badge = badging(args.apk);
const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const expectedPilotCertSha256 = String(
  args.expectedCertSha256 ?? TOWNSHIP_PILOT_CERT_SHA256 ?? "",
).replaceAll(":", "").trim().toLowerCase();

const failures = [];
if (badge.packageId !== TOWNSHIP_PACKAGE_ID) {
  failures.push(`packageId ${badge.packageId} is not ${TOWNSHIP_PACKAGE_ID}`);
}
if (!certs.signerCount || certs.completeSignerCount !== certs.signerCount) {
  failures.push(`artifact signer output is incomplete (${certs.completeSignerCount}/${certs.signerCount} complete blocks)`);
} else if (certs.distinctSignerCount !== 1) {
  failures.push(`artifact must have exactly one distinct signer (found ${certs.distinctSignerCount} certificates across ${certs.signerCount} blocks)`);
}
if (args.lineage === "pilot") {
  if (!/^[0-9a-f]{64}$/.test(expectedPilotCertSha256)) {
    failures.push("pilot lineage requires --expected-cert-sha256 or a reviewed repository pin");
  } else if (certs.sha256 !== expectedPilotCertSha256) {
    failures.push("pilot signer does not match the expected certificate pin");
  }
  if (pilotPinStatus(expectedPilotCertSha256) === "mismatched") {
    failures.push("pilot certificate pin differs from the reviewed repository pin");
  }
  if (certs.dn?.includes("CN=Android Debug")) {
    failures.push("pilot lineage refuses a debug-signed artifact");
  }
}
if (failures.length > 0) {
  console.error(`REFUSED: ${failures.join("; ")}`);
  process.exit(1);
}

const manifest = {
  product: "township",
  packageId: badge.packageId,
  expectedPackageId: TOWNSHIP_PACKAGE_ID,
  lineage: args.lineage,
  signingAlias:
    args.lineage === "pilot" && certs.sha256 === expectedPilotCertSha256
      ? TOWNSHIP_PILOT_KEY_ALIAS
      : null,
  apk: basename(args.apk),
  apkSha256: sha256Hex(apkBytes),
  apkSizeBytes: apkBytes.length,
  signerDn: certs.dn,
  signerCertSha256: certs.sha256,
  signerBlockCount: certs.signerCount,
  distinctSignerCount: certs.distinctSignerCount,
  versionCode: badge.versionCode,
  versionName: badge.versionName,
  gitSha,
  builtAt: new Date().toISOString(),
};

mkdirSync(args.out, { recursive: true });
writeFileSync(join(args.out, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(
  join(args.out, "build-manifest.md"),
  [
    "# Township Android build manifest",
    "",
    `- Lineage: ${manifest.lineage}`,
    `- Package: ${manifest.packageId} v${manifest.versionName} (versionCode ${manifest.versionCode})`,
    `- Git SHA: ${manifest.gitSha}`,
    `- APK SHA-256: ${manifest.apkSha256}`,
    `- Signer cert SHA-256: ${manifest.signerCertSha256}`,
    `- Signer DN: ${manifest.signerDn}`,
    `- Built at: ${manifest.builtAt}`,
    "",
  ].join("\n"),
);
console.log(JSON.stringify(manifest, null, 2));
