#!/usr/bin/env node
// Verifies that an Android release artifact is signed by the pinned Township
// pilot certificate, never the Android debug certificate.
//
// Usage:
//   node scripts/android-pilot/verify_apk_signature.mjs --apk <path> \
//     --lineage pilot|ephemeral-ci-throwaway \
//     --expected-cert-sha256 <hex> [--json <out-path>]
//
// Env: TOWNSHIP_PILOT_CERT_SHA256 may supply the pin instead of the flag.
// Exit codes: 0 verified; 1 refused (debug cert / pin mismatch / unsigned).

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseApksignerCerts, runApksignerPrintCerts } from "./sdk.mjs";
import { ANDROID_DEBUG_CERT_DN_MARKER, pilotPinStatus, sha256Hex } from "./pilot_policy.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apk") args.apk = argv[++i];
    else if (argv[i] === "--lineage") args.lineage = argv[++i];
    else if (argv[i] === "--expected-cert-sha256") args.expected = argv[++i];
    else if (argv[i] === "--json") args.json = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.apk) throw new Error("--apk <path> is required");
  if (!["pilot", "ephemeral-ci-throwaway"].includes(args.lineage)) {
    throw new Error("--lineage must be pilot or ephemeral-ci-throwaway");
  }
  return args;
}

export function normalizeCertPin(value) {
  const normalized = String(value ?? "").replaceAll(":", "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

export function lineagePinFailures(lineage, expected, repositoryPin) {
  if (lineage !== "pilot") return [];
  const repositoryStatus = pilotPinStatus(normalizeCertPin(expected), repositoryPin);
  if (repositoryStatus === "matched") return [];
  return [
    repositoryStatus === "unprovisioned"
      ? "reviewed repository pilot certificate pin is not provisioned"
      : "supplied pilot certificate pin differs from the reviewed repository pin",
  ];
}

export function evaluateSignature(
  { dn, sha256, signerCount, completeSignerCount, distinctSignerCount },
  { expected },
) {
  const failures = [];
  if (!signerCount || completeSignerCount !== signerCount) {
    failures.push(`artifact signer output is incomplete (${completeSignerCount ?? 0}/${signerCount ?? 0} complete blocks)`);
  } else if (distinctSignerCount !== 1) {
    failures.push(`artifact must have exactly one distinct signer (found ${distinctSignerCount ?? 0} certificates across ${signerCount} blocks)`);
  }
  if (!dn || !sha256) failures.push("artifact has no verifiable signer");
  if (dn && dn.includes(ANDROID_DEBUG_CERT_DN_MARKER)) {
    failures.push(`artifact is debug-signed (${dn}); debug keys never enter the pilot lineage`);
  }
  const pin = normalizeCertPin(expected);
  if (pin) {
    if (sha256 !== pin) failures.push(`signer cert sha256 ${sha256} does not match pinned pilot cert ${pin}`);
  } else {
    failures.push(
      "no pilot certificate pin supplied (TOWNSHIP_PILOT_CERT_SHA256 or --expected-cert-sha256); refusing unpinned verification",
    );
  }
  return failures;
}

const invokedDirectly = process.argv[1]
  ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url
  : false;
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const expected = args.expected ?? process.env.TOWNSHIP_PILOT_CERT_SHA256;
  const normalizedExpected = normalizeCertPin(expected);
  const apkBytes = readFileSync(args.apk);
  const rawApksignerOutput = runApksignerPrintCerts(args.apk);
  const certs = parseApksignerCerts(rawApksignerOutput);
  if (!certs.dn || !certs.sha256) {
    // Fail-closed either way, but make the next failure diagnosable: dump the
    // exact apksigner stdout the parser could not match instead of bare nulls.
    console.error("apksigner verify --print-certs output (no signer line matched the parser):");
    console.error(rawApksignerOutput);
  }
  const failures = evaluateSignature(certs, { expected });
  failures.push(...lineagePinFailures(args.lineage, normalizedExpected));
  const result = {
    apk: args.apk,
    apkSha256: sha256Hex(apkBytes),
    signerDn: certs.dn,
    signerCertSha256: certs.sha256,
    signerBlockCount: certs.signerCount,
    completeSignerCount: certs.completeSignerCount,
    distinctSignerCount: certs.distinctSignerCount,
    lineage: args.lineage,
    pinned: normalizedExpected != null,
    verified: failures.length === 0,
    failures,
  };
  if (args.json) writeFileSync(args.json, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (failures.length > 0) {
    console.error(`REFUSED: ${failures.join("; ")}`);
    process.exit(1);
  }
}
