#!/usr/bin/env node
// Verifies that an Android release artifact is signed by the pinned Township
// pilot certificate, never the Android debug certificate.
//
// Usage:
//   node scripts/android-pilot/verify_apk_signature.mjs --apk <path> \
//     [--expected-cert-sha256 <hex>] [--allow-unpinned] [--json <out-path>]
//
// Env: TOWNSHIP_PILOT_CERT_SHA256 may supply the pin instead of the flag.
// Exit codes: 0 verified; 1 refused (debug cert / pin mismatch / unsigned).

import { readFileSync, writeFileSync } from "node:fs";
import { parseApksignerCerts, runApksignerPrintCerts } from "./sdk.mjs";
import { ANDROID_DEBUG_CERT_DN_MARKER, sha256Hex } from "./pilot_policy.mjs";

function parseArgs(argv) {
  const args = { allowUnpinned: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apk") args.apk = argv[++i];
    else if (argv[i] === "--expected-cert-sha256") args.expected = argv[++i];
    else if (argv[i] === "--allow-unpinned") args.allowUnpinned = true;
    else if (argv[i] === "--json") args.json = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.apk) throw new Error("--apk <path> is required");
  return args;
}

export function evaluateSignature({ dn, sha256 }, { expected, allowUnpinned }) {
  const failures = [];
  if (!dn || !sha256) failures.push("artifact has no verifiable signer");
  if (dn && dn.includes(ANDROID_DEBUG_CERT_DN_MARKER)) {
    failures.push(`artifact is debug-signed (${dn}); debug keys never enter the pilot lineage`);
  }
  const pin = expected?.trim().toLowerCase() || null;
  if (pin) {
    if (sha256 !== pin) failures.push(`signer cert sha256 ${sha256} does not match pinned pilot cert ${pin}`);
  } else if (!allowUnpinned) {
    failures.push(
      "no pilot certificate pin supplied (TOWNSHIP_PILOT_CERT_SHA256 or --expected-cert-sha256); refusing unpinned verification",
    );
  }
  return failures;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const expected = args.expected ?? process.env.TOWNSHIP_PILOT_CERT_SHA256;
  const apkBytes = readFileSync(args.apk);
  const rawApksignerOutput = runApksignerPrintCerts(args.apk);
  const certs = parseApksignerCerts(rawApksignerOutput);
  if (!certs.dn || !certs.sha256) {
    // Fail-closed either way, but make the next failure diagnosable: dump the
    // exact apksigner stdout the parser could not match instead of bare nulls.
    console.error("apksigner verify --print-certs output (no signer line matched the parser):");
    console.error(rawApksignerOutput);
  }
  const failures = evaluateSignature(certs, { expected, allowUnpinned: args.allowUnpinned });
  const result = {
    apk: args.apk,
    apkSha256: sha256Hex(apkBytes),
    signerDn: certs.dn,
    signerCertSha256: certs.sha256,
    pinned: Boolean(expected?.trim()),
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
