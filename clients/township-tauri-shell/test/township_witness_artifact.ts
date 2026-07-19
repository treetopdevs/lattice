import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  assembleWitnessedSuccessionArtifact,
  canonicalBytesForWitnessedSuccessionClaim,
  canonicalOrder,
  carrierOpsToSemanticOps,
  decodeCarrierOpFrame,
  exportWitnessedSuccessionArtifactJson,
  frontier,
  index,
  type Op,
  type TauriInvoke,
  type WitnessedSuccessionReview,
} from "@treetopdevs/lattice-client";
import {
  TOWNSHIP_CARRIER_OUTBOX_KEY,
  TOWNSHIP_DELEGATION_FRAMES_KEY,
  TOWNSHIP_ENSURE_GOVERNANCE_WITNESS_KEY_COMMAND,
  TOWNSHIP_GOVERNANCE_WITNESS_PUBLIC_KEY_COMMAND,
  TOWNSHIP_LOCAL_OP_LOG_KEY,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_SIGN_GOVERNANCE_WITNESS_COMMAND,
  TOWNSHIP_STORAGE_NAMESPACE,
} from "../src/native_workflow";
import {
  exportTownshipWitnessArtifact,
  loadTownshipWitnessArtifacts,
  loadTownshipWitnessReview,
  submitTownshipWitnessArtifact,
  TOWNSHIP_WITNESS_ARTIFACT_INDEX_KEY,
  TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX,
  TOWNSHIP_WITNESS_INDEFINITE_VALIDITY_WARNING,
} from "../src/township_actions";
import { assertTownshipKvStoresNoSecrets } from "../src/storage_contract";

interface ProjectionVector {
  replica: string;
  oracleCarrierOps: unknown[];
  realmByPubkey: Record<string, string>;
  genesisProjection: {
    role: "clerk";
    acquisitionOperationIds: string[];
    holderPubkey: string;
    holderEpochOperationId: string;
    effectivePolicy: {
      successorPubkey: string;
      witnessPubkeys: string[];
      threshold: number;
    };
    winningPolicyGenesisOperationId: string;
    policyId: string;
    impostorGenesisOperationId: string;
  };
}

interface NativeIdentity {
  publicKey: Uint8Array;
  publicKeyBase64: string;
  privateSeedBase64: string;
  privateSeedHex: string;
  sign(bytes: Uint8Array): Uint8Array;
}

console.log("\n▸ Township witness artifact persistence and comprehension");

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(
    join(here, "..", "..", "lattice-client", "test", "vectors", "township_genesis_projection_parity.json"),
    "utf8",
  ),
) as ProjectionVector;
const projection = vector.genesisProjection;
const vectorSeed = "township:genesis-projection-parity";
const residentIdentity = seededEd25519Identity(`${vectorSeed}:resident`);
const governanceIdentity = seededEd25519Identity(`${vectorSeed}:witness_b`);
const malloryWitnessIdentity = seededEd25519Identity(`${vectorSeed}:mallory`);
assert.ok(
  projection.effectivePolicy.witnessPubkeys.includes(governanceIdentity.publicKeyBase64),
  "expected witness_b pinned in the effective valid-genesis policy",
);
assert.ok(
  !projection.effectivePolicy.witnessPubkeys.includes(malloryWitnessIdentity.publicKeyBase64),
  "expected mallory outside the pinned witness set",
);

const decodedOps = carrierOpsToSemanticOps(
  vector.oracleCarrierOps.map((frame) => decodeCarrierOpFrame(frame)),
  vector.realmByPubkey,
);
const opsById = index(decodedOps);
const orderedOps = canonicalOrder(decodedOps, opsById).map((id) => opsById.get(id)!);
const verifiedFrontier = frontier(orderedOps);
const prefixOps = causalPrefixExcluding(orderedOps, projection.winningPolicyGenesisOperationId);
assert.ok(
  prefixOps.length > 0 && prefixOps.length < orderedOps.length,
  "expected a strict causal prefix without the winning genesis",
);

const expectedClaim: WitnessedSuccessionReview["claim"] = {
  version: 1,
  replica: vector.replica,
  role: projection.role,
  holder: projection.holderPubkey,
  holderEpoch: projection.holderEpochOperationId,
  successor: projection.effectivePolicy.successorPubkey,
  policyId: projection.policyId,
};
const expectedReview: WitnessedSuccessionReview = {
  claim: expectedClaim,
  policyGenesisOperationId: projection.winningPolicyGenesisOperationId,
  witness: governanceIdentity.publicKeyBase64,
  threshold: projection.effectivePolicy.threshold,
  verifiedFrontier,
};
const expectedPayload = canonicalBytesForWitnessedSuccessionClaim(expectedClaim);
const expectedSignature = bytesBase64(governanceIdentity.sign(expectedPayload));
const expectedArtifact = assembleWitnessedSuccessionArtifact(expectedClaim, {
  witness: governanceIdentity.publicKeyBase64,
  signature: expectedSignature,
});
const expectedArtifactJson = exportWitnessedSuccessionArtifactJson(expectedArtifact);
const expectedIndexEntry = { artifactId: expectedArtifact.artifactId, review: expectedReview };

assert.equal(TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX, "township:witness-artifact:v1:");
assert.equal(TOWNSHIP_WITNESS_ARTIFACT_INDEX_KEY, "township:witness-artifacts:v1:index");
assert.equal(
  TOWNSHIP_WITNESS_INDEFINITE_VALIDITY_WARNING,
  "This artifact has no expiry and may remain valid indefinitely. " +
    "Valid until the clerk or recovery policy changes; this app cannot revoke an exported signature.",
);

console.log("  review derivation from verified local operations");
{
  const values = seededValues(orderedOps);
  const calls: string[] = [];
  const invoke = witnessInvoke(values, calls);

  const review = await loadTownshipWitnessReview({ invoke, replica: vector.replica });
  assert.ok(review.ok, "expected verified witness review");
  assert.deepEqual(review.review, expectedReview);
  assert.equal(calls.filter((command) => command === "lattice_kv_set").length, 0);
  assert.equal(calls.filter((command) => command === TOWNSHIP_ENSURE_GOVERNANCE_WITNESS_KEY_COMMAND).length, 0);
  assert.equal(calls.filter((command) => command === TOWNSHIP_GOVERNANCE_WITNESS_PUBLIC_KEY_COMMAND).length, 1);
  assert.equal(calls.filter((command) => command === TOWNSHIP_SIGN_GOVERNANCE_WITNESS_COMMAND).length, 0);
}

console.log("  sign persists exactly one artifact under the serialized writer");
const persistedValues = seededValues(orderedOps);
const persistedCalls: string[] = [];
const persistedTraces: string[] = [];
{
  const invoke = witnessInvoke(persistedValues, persistedCalls, { traces: persistedTraces });
  const review = await loadTownshipWitnessReview({ invoke, replica: vector.replica });
  assert.ok(review.ok, "expected verified witness review before signing");

  const localOpsBefore = persistedValues.get(storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY));
  const outboxBefore = persistedValues.get(storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY)) ?? null;
  const delegationsBefore = persistedValues.get(storageKey(TOWNSHIP_DELEGATION_FRAMES_KEY)) ?? null;
  const setCallsBefore = persistedCalls.filter((command) => command === "lattice_kv_set").length;

  const submitted = await submitTownshipWitnessArtifact({
    invoke,
    replica: vector.replica,
    priorReview: review.review,
  });
  assert.ok(
    submitted.ok,
    `expected witness artifact submission to succeed: ${JSON.stringify(submitted)}`,
  );
  assert.equal(submitted.artifactId, expectedArtifact.artifactId);
  assert.equal(submitted.storageKey, `${TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX}${expectedArtifact.artifactId}`);
  assert.equal(submitted.artifactJson, expectedArtifactJson);
  assert.equal(
    persistedValues.get(storageKey(`${TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX}${expectedArtifact.artifactId}`)),
    expectedArtifactJson,
  );
  assert.deepEqual(readArtifactIndex(persistedValues), { v: 1, entries: [expectedIndexEntry] });
  assert.equal(
    persistedCalls.filter((command) => command === "lattice_kv_set").length - setCallsBefore,
    2,
    "expected exactly the artifact entry and index writes",
  );
  assert.equal(persistedValues.get(storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY)), localOpsBefore);
  assert.equal(persistedValues.get(storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY)) ?? null, outboxBefore);
  assert.equal(persistedValues.get(storageKey(TOWNSHIP_DELEGATION_FRAMES_KEY)) ?? null, delegationsBefore);
  assert.equal(persistedCalls.filter((command) => command === "lattice_sign_carrier").length, 0);
  assert.equal(persistedCalls.filter((command) => command === TOWNSHIP_SIGN_GOVERNANCE_WITNESS_COMMAND).length, 1);
  assert.ok(!submitted.artifactJson.includes("expiry"), "display labels never enter the canonical artifact");
}

console.log("  re-signing the identical claim is idempotent and uses fresh presence");
{
  const invoke = witnessInvoke(persistedValues, persistedCalls, { traces: persistedTraces });
  const review = await loadTownshipWitnessReview({ invoke, replica: vector.replica });
  assert.ok(review.ok);
  const resubmitted = await submitTownshipWitnessArtifact({
    invoke,
    replica: vector.replica,
    priorReview: review.review,
  });
  assert.ok(resubmitted.ok, "expected idempotent witness artifact re-submission");
  assert.equal(resubmitted.artifactId, expectedArtifact.artifactId);
  assert.equal(
    persistedValues.get(storageKey(`${TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX}${expectedArtifact.artifactId}`)),
    expectedArtifactJson,
  );
  assert.deepEqual(readArtifactIndex(persistedValues), { v: 1, entries: [expectedIndexEntry] });
  assert.equal(
    persistedCalls.filter((command) => command === TOWNSHIP_SIGN_GOVERNANCE_WITNESS_COMMAND).length,
    2,
    "every governance signature requires a fresh native presence decision",
  );
}

console.log("  unrelated frontier growth keeps the identical artifact idempotent");
{
  const activityId = createHash("sha256").update("township:witness-artifact:later-post").digest("base64url");
  const laterPost: Op = {
    id: activityId,
    hash: activityId,
    replica: vector.replica,
    deps: verifiedFrontier,
    kind: "command",
    author: "resident",
    field: "posts",
    mutation: "append",
    value: "Later township activity",
  };
  persistedValues.set(
    storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY),
    JSON.stringify([...orderedOps, laterPost]),
  );
  const invoke = witnessInvoke(persistedValues, persistedCalls, { traces: persistedTraces });
  const review = await loadTownshipWitnessReview({ invoke, replica: vector.replica });
  assert.ok(review.ok, "expected a review after unrelated activity");
  assert.deepEqual(review.review.claim, expectedClaim);
  assert.notDeepEqual(review.review.verifiedFrontier, expectedReview.verifiedFrontier);

  const resubmitted = await submitTownshipWitnessArtifact({
    invoke,
    replica: vector.replica,
    priorReview: review.review,
  });
  assert.ok(
    resubmitted.ok,
    `expected frontier-independent idempotency: ${JSON.stringify(resubmitted)}`,
  );
  assert.equal(resubmitted.artifactId, expectedArtifact.artifactId);
  assert.equal(
    persistedValues.get(storageKey(`${TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX}${expectedArtifact.artifactId}`)),
    expectedArtifactJson,
  );
  assert.deepEqual(readArtifactIndex(persistedValues), { v: 1, entries: [expectedIndexEntry] });
}

console.log("  a distinct claim persists separately and never replaces the prior artifact");
let distinctArtifactId: string;
let distinctReview: WitnessedSuccessionReview;
{
  persistedValues.set(storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY), JSON.stringify(prefixOps));
  const invoke = witnessInvoke(persistedValues, persistedCalls, { traces: persistedTraces });
  const review = await loadTownshipWitnessReview({ invoke, replica: vector.replica });
  assert.ok(review.ok, "expected verified review over the causal prefix");
  distinctReview = review.review;
  assert.equal(review.review.claim.holderEpoch, projection.acquisitionOperationIds[0]);
  assert.notDeepEqual(review.review.claim, expectedClaim);

  const submitted = await submitTownshipWitnessArtifact({
    invoke,
    replica: vector.replica,
    priorReview: review.review,
  });
  assert.ok(submitted.ok, "expected the distinct-claim submission to succeed");
  distinctArtifactId = submitted.artifactId;
  assert.notEqual(distinctArtifactId, expectedArtifact.artifactId);
  assert.equal(
    persistedValues.get(storageKey(`${TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX}${expectedArtifact.artifactId}`)),
    expectedArtifactJson,
    "the prior artifact must remain byte-identical",
  );
  assert.equal(
    persistedValues.get(storageKey(`${TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX}${distinctArtifactId}`)),
    submitted.artifactJson,
  );
  assert.deepEqual(readArtifactIndex(persistedValues), {
    v: 1,
    entries: [
      expectedIndexEntry,
      { artifactId: distinctArtifactId, review: distinctReview },
    ].sort((left, right) =>
      left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0,
    ),
  });
}

console.log("  a fresh process reloads the durable artifacts");
{
  const rehydratedValues = new Map(
    [...persistedValues].map(([key, value]) => [String(key), new TextDecoder().decode(new TextEncoder().encode(value))]),
  );
  const calls: string[] = [];
  const invoke = witnessInvoke(rehydratedValues, calls);
  const loaded = await loadTownshipWitnessArtifacts({ invoke });
  assert.ok(loaded.ok, `expected artifact reload to succeed: ${JSON.stringify(loaded)}`);
  assert.deepEqual(
    loaded.artifacts.map((artifact) => artifact.artifactId),
    [expectedArtifact.artifactId, distinctArtifactId].sort(),
  );
  const reloadedPrimary = loaded.artifacts.find(
    (artifact) => artifact.artifactId === expectedArtifact.artifactId,
  );
  assert.equal(reloadedPrimary?.artifactJson, expectedArtifactJson);
  assert.equal(calls.filter((command) => command === "lattice_kv_set").length, 0);
  assert.equal(calls.filter((command) => command === TOWNSHIP_SIGN_GOVERNANCE_WITNESS_COMMAND).length, 0);
}

console.log("  export requires a separate trusted event and returns the exact stored bytes");
{
  const calls: string[] = [];
  const invoke = witnessInvoke(persistedValues, calls);
  const untrusted = await exportTownshipWitnessArtifact({
    invoke,
    artifactId: expectedArtifact.artifactId,
    event: { isTrusted: false },
  });
  assert.ok(!untrusted.ok, "expected script-triggered export to refuse");
  assert.equal(untrusted.reason, "unavailable");
  assert.equal(calls.length, 0, "untrusted export must not read durable storage");

  const exported = await exportTownshipWitnessArtifact({
    invoke,
    artifactId: expectedArtifact.artifactId,
    event: { isTrusted: true },
  });
  assert.ok(exported.ok, "expected artifact export to succeed");
  assert.equal(exported.artifactJson, expectedArtifactJson);
  assert.equal(exported.warning, TOWNSHIP_WITNESS_INDEFINITE_VALIDITY_WARNING);
  assert.deepEqual(exported.confirmation, [
    `Replica: ${expectedReview.claim.replica}`,
    `Role: ${expectedReview.claim.role}`,
    `Holder: ${expectedReview.claim.holder}`,
    `Holder epoch: ${expectedReview.claim.holderEpoch}`,
    `Successor: ${expectedReview.claim.successor}`,
    `Policy ID: ${expectedReview.claim.policyId}`,
    `Winning policy genesis operation ID: ${expectedReview.policyGenesisOperationId}`,
    `Witness key: ${expectedReview.witness}`,
    `Threshold: ${expectedReview.threshold}`,
    TOWNSHIP_WITNESS_INDEFINITE_VALIDITY_WARNING,
  ]);
  const commandsUsed = [...new Set(calls)].filter((command) => command !== "lattice_ensure_carrier_key");
  assert.deepEqual(commandsUsed, ["lattice_kv_get"], "export reads only durable storage");

  const missing = await exportTownshipWitnessArtifact({
    invoke,
    artifactId: "A".repeat(43),
    event: { isTrusted: true },
  });
  assert.ok(!missing.ok, "expected export of an unknown artifact to refuse");
  assert.equal(missing.reason, "unavailable");
}

console.log("  reload and export reject a canonical-looking invalid stored signature");
{
  const values = new Map(persistedValues);
  const artifactKey = storageKey(
    `${TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX}${expectedArtifact.artifactId}`,
  );
  const tampered = JSON.parse(values.get(artifactKey) ?? "null") as Record<string, unknown>;
  tampered.signature = bytesBase64(new Uint8Array(64));
  values.set(artifactKey, JSON.stringify(tampered));
  const calls: string[] = [];
  const invoke = witnessInvoke(values, calls);

  const loaded = await loadTownshipWitnessArtifacts({ invoke });
  assert.ok(!loaded.ok, "invalid stored signature must not reload");
  assert.equal(loaded.reason, "malformed");
  const exported = await exportTownshipWitnessArtifact({
    invoke,
    artifactId: expectedArtifact.artifactId,
    event: { isTrusted: true },
  });
  assert.ok(!exported.ok, "invalid stored signature must not export");
  assert.equal(exported.reason, "malformed");
}

console.log("  index rejects noncanonical base64url digest trailing bits");
{
  const values = new Map(persistedValues);
  const witnessIndex = readArtifactIndex(values) as {
    v: 1;
    entries: Array<{ artifactId: string; review: WitnessedSuccessionReview }>;
  };
  const firstEntry = witnessIndex.entries[0];
  if (!firstEntry) throw new Error("expected indexed witness artifact");
  firstEntry.review.policyGenesisOperationId = nonCanonicalBase64Url(
    firstEntry.review.policyGenesisOperationId,
  );
  values.set(storageKey(TOWNSHIP_WITNESS_ARTIFACT_INDEX_KEY), JSON.stringify(witnessIndex));

  const loaded = await loadTownshipWitnessArtifacts({ invoke: witnessInvoke(values, []) });
  assert.ok(!loaded.ok, "noncanonical index digest must not reload");
  assert.equal(loaded.reason, "malformed");
}

console.log("  refusals make zero signer and zero artifact-KV writes");
{
  const unavailableInvoke: TauriInvoke = async () => {
    throw new Error("native shell unavailable");
  };
  const nativeUnavailable = await submitTownshipWitnessArtifact({
    invoke: unavailableInvoke,
    replica: vector.replica,
    priorReview: expectedReview,
  });
  assert.ok(!nativeUnavailable.ok);
  assert.equal(nativeUnavailable.reason, "native_unavailable");
}
{
  const values = seededValues(orderedOps);
  const calls: string[] = [];
  const invoke = witnessInvoke(values, calls);
  const mismatch = await submitTownshipWitnessArtifact({
    invoke,
    replica: "replica:matter:other#root:QUB7owpVIsZn3IyoVLJbsFc5HLkozhi2PVBL5Lzhj3w",
    priorReview: expectedReview,
  });
  assert.ok(!mismatch.ok);
  assert.equal(mismatch.reason, "replica_mismatch");
  assertNoArtifactWrites(values, calls, 0);
}
{
  const values = seededValues(orderedOps);
  const calls: string[] = [];
  const invoke = witnessInvoke(values, calls, {
    governancePublicKey: malloryWitnessIdentity.publicKeyBase64,
  });
  const unpinned = await submitTownshipWitnessArtifact({
    invoke,
    replica: vector.replica,
    priorReview: expectedReview,
  });
  assert.ok(!unpinned.ok);
  assert.equal(unpinned.reason, "unpinned");
  assertNoArtifactWrites(values, calls, 0);
}
{
  const values = seededValues(orderedOps);
  const calls: string[] = [];
  const invoke = witnessInvoke(values, calls);
  const staleReview: WitnessedSuccessionReview = {
    ...expectedReview,
    claim: { ...expectedClaim, holderEpoch: projection.impostorGenesisOperationId },
  };
  const stale = await submitTownshipWitnessArtifact({
    invoke,
    replica: vector.replica,
    priorReview: staleReview,
  });
  assert.ok(!stale.ok);
  assert.equal(stale.reason, "stale");
  assertNoArtifactWrites(values, calls, 0);
}
{
  const values = seededValues([]);
  const calls: string[] = [];
  const invoke = witnessInvoke(values, calls);
  const malformed = await submitTownshipWitnessArtifact({
    invoke,
    replica: vector.replica,
    priorReview: expectedReview,
  });
  assert.ok(!malformed.ok);
  assert.equal(malformed.reason, "malformed");
  assertNoArtifactWrites(values, calls, 0);
}
{
  const values = seededValues(orderedOps);
  const calls: string[] = [];
  const invoke = witnessInvoke(values, calls, {
    signGovernance: () => {
      throw new Error("governance witness authentication cancelled");
    },
  });
  const cancelled = await submitTownshipWitnessArtifact({
    invoke,
    replica: vector.replica,
    priorReview: expectedReview,
  });
  assert.ok(!cancelled.ok);
  assert.equal(cancelled.reason, "cancelled");
  assertNoArtifactWrites(values, calls, 1);
}
{
  const values = seededValues(orderedOps);
  const calls: string[] = [];
  const invoke = witnessInvoke(values, calls, {
    readGovernance: () => {
      throw new Error("governance witness authentication unavailable");
    },
  });
  const unavailable = await submitTownshipWitnessArtifact({
    invoke,
    replica: vector.replica,
    priorReview: expectedReview,
  });
  assert.ok(!unavailable.ok);
  assert.equal(unavailable.reason, "unavailable");
  assertNoArtifactWrites(values, calls, 0);
}
{
  const values = seededValues(orderedOps);
  const calls: string[] = [];
  const invoke = witnessInvoke(values, calls, {
    signGovernance: (claim) => {
      const payload = canonicalBytesForWitnessedSuccessionClaim(claim);
      return {
        witness: malloryWitnessIdentity.publicKeyBase64,
        signature: bytesBase64(malloryWitnessIdentity.sign(payload)),
        payloadDigest: createHash("sha256").update(payload).digest("base64url"),
      };
    },
  });
  const tampered = await submitTownshipWitnessArtifact({
    invoke,
    replica: vector.replica,
    priorReview: expectedReview,
  });
  assert.ok(!tampered.ok);
  assert.equal(tampered.reason, "malformed");
  assertNoArtifactWrites(values, calls, 1);
}

console.log("  an interrupted index write is fail-loud and a retry converges");
{
  const values = seededValues(orderedOps);
  const failedCalls: string[] = [];
  const failed = await submitTownshipWitnessArtifact({
    invoke: witnessInvoke(values, failedCalls, {
      failKvSetOnce: storageKey(TOWNSHIP_WITNESS_ARTIFACT_INDEX_KEY),
    }),
    replica: vector.replica,
    priorReview: expectedReview,
  });
  assert.ok(!failed.ok, "the interrupted write must not report success");
  assert.equal(
    values.get(storageKey(`${TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX}${expectedArtifact.artifactId}`)),
    expectedArtifactJson,
    "artifact bytes are committed before the discoverability index",
  );
  assert.equal(values.has(storageKey(TOWNSHIP_WITNESS_ARTIFACT_INDEX_KEY)), false);

  const retryCalls: string[] = [];
  const retried = await submitTownshipWitnessArtifact({
    invoke: witnessInvoke(values, retryCalls),
    replica: vector.replica,
    priorReview: expectedReview,
  });
  assert.ok(retried.ok, "retry should index the already durable artifact");
  assert.deepEqual(readArtifactIndex(values), { v: 1, entries: [expectedIndexEntry] });
}

console.log("  artifact, key, and log bytes stay out of traces and the store stays secret-free");
{
  assertTownshipKvStoresNoSecrets(
    persistedValues,
    secretNeedles(residentIdentity, governanceIdentity, malloryWitnessIdentity),
  );
  const artifactKeys = [...persistedValues.keys()].filter((key) =>
    key.startsWith(storageKey(TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX)),
  );
  for (const [key, value] of persistedValues) {
    if (artifactKeys.includes(key)) continue;
    assert.ok(
      !value.includes(expectedSignature),
      `witness signature bytes leaked into ${key}`,
    );
  }
  for (const trace of persistedTraces) {
    assert.ok(!trace.includes(expectedSignature), "witness signature bytes leaked into a trace");
    assert.ok(!trace.includes(expectedArtifactJson), "artifact bytes leaked into a trace");
    assert.ok(
      !trace.includes(governanceIdentity.privateSeedBase64) && !trace.includes(governanceIdentity.privateSeedHex),
      "governance seed leaked into a trace",
    );
  }
  const parsed = JSON.parse(expectedArtifactJson) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ["v", "artifactId", "claim", "witness", "signature"]);
  assert.deepEqual(Object.keys(parsed.claim as Record<string, unknown>), [
    "version",
    "replica",
    "role",
    "holder",
    "holderEpoch",
    "successor",
    "policyId",
  ]);
}

console.log("\x1b[32m✓ township witness artifact persistence checks passed\x1b[0m");

interface WitnessInvokeOptions {
  governancePublicKey?: string;
  readGovernance?: () => string;
  failKvSetOnce?: string;
  signGovernance?: (claim: Parameters<typeof canonicalBytesForWitnessedSuccessionClaim>[0]) => {
    witness: string;
    signature: string;
    payloadDigest: string;
  };
  traces?: string[];
}

function witnessInvoke(
  values: Map<string, string>,
  calls: string[],
  options: WitnessInvokeOptions = {},
): TauriInvoke {
  let pendingFailedSetKey = options.failKvSetOnce;
  return async <T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    calls.push(command);

    let result: unknown;
    switch (command) {
      case "lattice_ensure_carrier_key":
        assert.equal(args.keyId, TOWNSHIP_NATIVE_KEY_ID);
        result = residentIdentity.publicKeyBase64;
        break;
      case "lattice_kv_get":
        result = values.get(String(args.key)) ?? null;
        break;
      case "lattice_kv_set":
        if (String(args.key) === pendingFailedSetKey) {
          pendingFailedSetKey = undefined;
          throw new Error("injected witness artifact index write failure");
        }
        values.set(String(args.key), String(args.value));
        result = null;
        break;
      case "lattice_sign_carrier":
        assert.equal(args.keyId, TOWNSHIP_NATIVE_KEY_ID);
        result = bytesBase64(residentIdentity.sign(base64Bytes(String(args.bytes))));
        break;
      case TOWNSHIP_GOVERNANCE_WITNESS_PUBLIC_KEY_COMMAND:
        result = options.readGovernance
          ? options.readGovernance()
          : options.governancePublicKey ?? governanceIdentity.publicKeyBase64;
        break;
      case TOWNSHIP_SIGN_GOVERNANCE_WITNESS_COMMAND: {
        const claim = args.claim as Parameters<typeof canonicalBytesForWitnessedSuccessionClaim>[0];
        if (options.signGovernance) {
          result = options.signGovernance(claim);
          break;
        }
        const payload = canonicalBytesForWitnessedSuccessionClaim(claim);
        result = {
          witness: governanceIdentity.publicKeyBase64,
          signature: bytesBase64(governanceIdentity.sign(payload)),
          payloadDigest: createHash("sha256").update(payload).digest("base64url"),
        };
        break;
      }
      case "lattice_trace_dev_event":
        options.traces?.push(String(args.event ?? ""));
        result = null;
        break;
      default:
        throw new Error(`unexpected command ${command}`);
    }

    return result as T;
  };
}

function assertNoArtifactWrites(
  values: Map<string, string>,
  calls: string[],
  expectedSignCalls: 0 | 1,
): void {
  assert.equal(calls.filter((command) => command === "lattice_kv_set").length, 0);
  assert.equal(
    calls.filter((command) => command === TOWNSHIP_SIGN_GOVERNANCE_WITNESS_COMMAND).length,
    expectedSignCalls,
  );
  assert.equal(
    [...values.keys()].filter((key) => key.startsWith(storageKey(TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX))).length,
    0,
  );
}

function seededValues(ops: readonly Op[]): Map<string, string> {
  const values = new Map<string, string>();
  values.set(storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY), JSON.stringify(ops));
  return values;
}

function readArtifactIndex(values: Map<string, string>): unknown {
  return JSON.parse(values.get(storageKey(TOWNSHIP_WITNESS_ARTIFACT_INDEX_KEY)) ?? "null");
}

function nonCanonicalBase64Url(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const index = alphabet.indexOf(value.at(-1) ?? "");
  if (index < 0 || (index & 0b11) !== 0) throw new Error("expected canonical 32-byte base64url digest");
  return `${value.slice(0, -1)}${alphabet[(index & 0b111100) | 0b01]}`;
}

function causalPrefixExcluding(ops: readonly Op[], excludedId: string): Op[] {
  const excluded = new Set<string>([excludedId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const op of ops) {
      if (excluded.has(op.id)) continue;
      if (op.deps.some((dep) => excluded.has(dep))) {
        excluded.add(op.id);
        changed = true;
      }
    }
  }
  return ops.filter((op) => !excluded.has(op.id));
}

function storageKey(key: string): string {
  return `${TOWNSHIP_STORAGE_NAMESPACE}:${key}`;
}

function secretNeedles(...identities: NativeIdentity[]): string[] {
  return identities.flatMap((identity) => [identity.privateSeedBase64, identity.privateSeedHex]);
}

function seededEd25519Identity(seed: string): NativeIdentity {
  const privateSeed = createHash("sha256").update(seed).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), privateSeed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyDer = (createPublicKey as (key: unknown) => ReturnType<typeof createPublicKey>)(privateKey).export({
    format: "der",
    type: "spki",
  });
  const publicKey = new Uint8Array(Buffer.from(publicKeyDer).subarray(12));

  return {
    publicKey,
    publicKeyBase64: bytesBase64(publicKey),
    privateSeedBase64: bytesBase64(privateSeed),
    privateSeedHex: privateSeed.toString("hex"),
    sign(bytes: Uint8Array): Uint8Array {
      return new Uint8Array(edSign(null, Buffer.from(bytes), privateKey));
    },
  };
}

function bytesBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64Bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}
