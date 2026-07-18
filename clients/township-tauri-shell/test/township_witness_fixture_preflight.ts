import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  canonicalBytesForWitnessedSuccessionClaim,
  carrierOpsToSemanticOps,
  decodeCarrierOpFrame,
  deriveWitnessedSuccessionReview,
  witnessedRecoveryPolicyId,
  type CarrierOpFrame,
  type WitnessedSuccessionClaimEvidence,
} from "@treetopdevs/lattice-client";
import { townshipMatterSchema } from "../src/township_preview";
import { runBeamSupport } from "./support/beam_peer";
import { discoverGovernanceTestPresencePublicKey } from "./support/governance_preflight";

interface WitnessFixtureOracle {
  replica: string;
  realmByPubkey: Record<string, string>;
  oracleCarrierOps: CarrierOpFrame[];
  appWitnessPubkey: string;
  controlWitnessPubkey: string;
  sourceAuthorPubkeys: string[];
  claim: WitnessedSuccessionClaimEvidence;
  claimPayloadSha256: string;
  source: {
    sha256: string;
    opIds: string[];
    frontier: string[];
  };
  projection: {
    role: "clerk";
    holderPubkey: string;
    holderEpochOperationId: string;
    successorPubkey: string;
    policyGenesisOperationId: string;
    policyId: string;
    rootPubkey: string;
    quarantineReasons: Record<string, string>;
    recovery: {
      mode: "witnessed";
      version: 1;
      witnesses: string[];
      threshold: 2;
    };
  };
}

interface RestoredWitnessFixtureOracle {
  replica: string;
  source: WitnessFixtureOracle["source"];
  projection: WitnessFixtureOracle["projection"];
}

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");

console.log("\n▸ Township witness fixture preflight");

const tempRoot = mkdtempSync(join(tmpdir(), "township-witness-preflight-"));
const sourcePath = join(tempRoot, "matter.log");
const oraclePath = join(tempRoot, "oracle.json");
const restoredOraclePath = join(tempRoot, "restored-oracle.json");

try {
  const discoveredPublicKey = await discoverGovernanceTestPresencePublicKey({ shellRoot });
  assertCanonicalBase64PublicKey(discoveredPublicKey);
  const expectedTestProviderPublicKey = Buffer.from(
    ed25519.getPublicKey(new Uint8Array(32).fill(0xa5)),
  ).toString("base64");
  assert.equal(
    discoveredPublicKey,
    expectedTestProviderPublicKey,
    "the discovered key must match an independent Ed25519 derivation of the deterministic test-presence seed",
  );

  await runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_witness_artifact_fixture.exs",
    [tempRoot, discoveredPublicKey],
    "WITNESS_FIXTURE_READY",
  );
  await runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_witness_artifact_fixture_verify.exs",
    [sourcePath, restoredOraclePath],
    "WITNESS_FIXTURE_VERIFIED",
  );

  assert.ok(existsSync(sourcePath), `expected BEAM source fixture at ${sourcePath}`);
  const oracle = JSON.parse(readFileSync(oraclePath, "utf8")) as WitnessFixtureOracle;
  const restoredOracle = JSON.parse(
    readFileSync(restoredOraclePath, "utf8"),
  ) as RestoredWitnessFixtureOracle;

  assert.equal(
    oracle.source.sha256,
    createHash("sha256").update(readFileSync(sourcePath)).digest("hex"),
    "the oracle must commit to the exact dumped source bytes",
  );
  assert.deepEqual(
    { replica: oracle.replica, source: oracle.source, projection: oracle.projection },
    restoredOracle,
    "the independent fresh-process BEAM restore must reproduce the fixture oracle",
  );

  assert.equal(oracle.appWitnessPubkey, discoveredPublicKey);
  assertCanonicalBase64PublicKey(oracle.controlWitnessPubkey);
  assert.notEqual(oracle.controlWitnessPubkey, discoveredPublicKey);
  assert.notEqual(oracle.projection.holderPubkey, discoveredPublicKey);
  assert.notEqual(oracle.projection.successorPubkey, discoveredPublicKey);
  assert.ok(
    !oracle.sourceAuthorPubkeys.includes(discoveredPublicKey),
    "the governance witness key must never author a source operation",
  );
  assert.ok(
    !oracle.sourceAuthorPubkeys.includes(oracle.controlWitnessPubkey),
    "the control witness key must never author a source operation",
  );

  assert.match(oracle.replica, /^replica:matter:township-witness-artifact#root:/);
  assert.deepEqual(oracle.source.opIds, [oracle.projection.policyGenesisOperationId]);
  assert.deepEqual(oracle.source.frontier, [oracle.projection.policyGenesisOperationId]);
  assert.equal(oracle.oracleCarrierOps.length, 1);
  const genesisFrame = decodeCarrierOpFrame(oracle.oracleCarrierOps[0]);
  assert.equal(genesisFrame.id, oracle.projection.policyGenesisOperationId);
  assert.deepEqual(genesisFrame.deps, [], "the valid genesis must have no dependencies");
  assert.equal(genesisFrame.author, oracle.projection.holderPubkey);

  assert.equal(oracle.projection.role, "clerk");
  assertCanonicalBase64PublicKey(oracle.projection.holderPubkey);
  assertCanonicalBase64PublicKey(oracle.projection.successorPubkey);
  assertCanonicalBase64UrlDigest(oracle.projection.holderEpochOperationId);
  assert.equal(
    oracle.projection.holderEpochOperationId,
    oracle.projection.policyGenesisOperationId,
  );
  assertCanonicalBase64UrlDigest(oracle.projection.policyId);
  assert.equal(oracle.projection.rootPubkey, oracle.projection.holderPubkey);
  assert.deepEqual(
    oracle.projection.quarantineReasons,
    {},
    "the fixture source must start with no authority quarantine",
  );

  const expectedWitnesses = [discoveredPublicKey, oracle.controlWitnessPubkey].sort(
    compareRawPublicKeys,
  );
  assert.deepEqual(oracle.projection.recovery, {
    mode: "witnessed",
    version: 1,
    witnesses: expectedWitnesses,
    threshold: 2,
  });
  assert.equal(new Set(oracle.projection.recovery.witnesses).size, 2);
  assert.equal(
    oracle.projection.recovery.witnesses.filter((key) => key === discoveredPublicKey).length,
    1,
    "the discovered governance key must be pinned exactly once",
  );
  assert.equal(
    witnessedRecoveryPolicyId(oracle.projection.recovery),
    oracle.projection.policyId,
    "TypeScript must independently reproduce the BEAM policy id",
  );

  assert.deepEqual(oracle.claim, {
    version: 1,
    replica: oracle.replica,
    role: "clerk",
    holder: oracle.projection.holderPubkey,
    holderEpoch: oracle.projection.holderEpochOperationId,
    successor: oracle.projection.successorPubkey,
    policyId: oracle.projection.policyId,
  });
  assert.equal(
    Buffer.from(
      createHash("sha256")
        .update(canonicalBytesForWitnessedSuccessionClaim(oracle.claim))
        .digest(),
    ).toString("base64url"),
    oracle.claimPayloadSha256,
    "TypeScript must reproduce the exact BEAM claim signing-payload digest",
  );

  const semanticOps = carrierOpsToSemanticOps(
    oracle.oracleCarrierOps.map((frame) => decodeCarrierOpFrame(frame)),
    oracle.realmByPubkey,
  );
  const derived = deriveWitnessedSuccessionReview(
    townshipMatterSchema,
    semanticOps,
    { replica: oracle.replica, role: "clerk", witness: discoveredPublicKey },
    null,
  );
  assert.ok(derived.ok, "the independent TypeScript projection must accept the restored fixture");
  assert.deepEqual(derived.review, {
    claim: oracle.claim,
    policyGenesisOperationId: oracle.projection.policyGenesisOperationId,
    witness: discoveredPublicKey,
    threshold: 2,
    verifiedFrontier: oracle.source.frontier,
  });

  const unpinnedWitness = Buffer.from(
    ed25519.getPublicKey(new Uint8Array(32).fill(0x3c)),
  ).toString("base64");
  const refused = deriveWitnessedSuccessionReview(
    townshipMatterSchema,
    semanticOps,
    { replica: oracle.replica, role: "clerk", witness: unpinnedWitness },
    null,
  );
  assert.ok(!refused.ok, "an unpinned witness must be refused");
  assert.equal(refused.reason, "witness_not_pinned");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("[32m✓ Township witness fixture preflight checks passed[0m");

function assertCanonicalBase64PublicKey(value: string): void {
  const bytes = Buffer.from(value, "base64");
  assert.equal(bytes.byteLength, 32, "expected a 32-byte Ed25519 public key");
  assert.equal(bytes.toString("base64"), value, "expected canonical padded base64");
}

function assertCanonicalBase64UrlDigest(value: string): void {
  const bytes = Buffer.from(value, "base64url");
  assert.equal(bytes.byteLength, 32, "expected a 32-byte digest");
  assert.equal(bytes.toString("base64url"), value, "expected canonical unpadded base64url");
}

function compareRawPublicKeys(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "base64"), Buffer.from(right, "base64"));
}
