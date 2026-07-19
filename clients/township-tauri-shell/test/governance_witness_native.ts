import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalBytesForWitnessedSuccessionClaim } from "@treetopdevs/lattice-client";
import type { TauriInvoke, WitnessedSuccessionClaimEvidence } from "@treetopdevs/lattice-client";
import {
  ensureGovernanceWitnessKey,
  loadGovernanceWitnessPublicKey,
  signGovernanceWitnessClaim,
  TOWNSHIP_ENSURE_GOVERNANCE_WITNESS_KEY_COMMAND,
  TOWNSHIP_GOVERNANCE_WITNESS_PUBLIC_KEY_COMMAND,
  TOWNSHIP_SIGN_GOVERNANCE_WITNESS_COMMAND,
  verifyGovernanceWitnessSignature,
} from "../src/native_workflow";

console.log("\n▸ Township governance witness native bridge");

const claim: WitnessedSuccessionClaimEvidence = {
  version: 1,
  replica:
    "replica:matter:succession-witnessed-recovery#root:lc9GuxZMwEl99X0zNhDLAa6jR9n8pBX-2zFS3ghRwWo",
  role: "clerk",
  holder: "mCaZpMJ0SU2lf3v2ljw0D05Px4pmoY1jUIIVv19hmZ4=",
  holderEpoch: "SJMi-K8IUPUvtk3zYRUVMeska-KcUvNT_8oPWTlKDAI",
  successor: "DBY121cVb1O+BdK+NucwFZyZtUTdrPpxhnZ2Wg41jjY=",
  policyId: "APOtJzZqq0XmqxkCRK2sl4L--O-nrZ5QhxUOHpZhJ30",
};
const seed = new Uint8Array(32).fill(7);
const witness = Buffer.from(ed25519.getPublicKey(seed)).toString("base64");
const payload = canonicalBytesForWitnessedSuccessionClaim(claim);
const signature = Buffer.from(ed25519.sign(payload, seed)).toString("base64");
const payloadDigest = createHash("sha256").update(payload).digest("base64url");
const otherSeed = new Uint8Array(32).fill(9);
const otherWitness = Buffer.from(ed25519.getPublicKey(otherSeed)).toString("base64");
const otherSignature = Buffer.from(ed25519.sign(payload, otherSeed)).toString("base64");

assert.equal(
  TOWNSHIP_ENSURE_GOVERNANCE_WITNESS_KEY_COMMAND,
  "lattice_ensure_governance_witness_key",
);
assert.equal(TOWNSHIP_SIGN_GOVERNANCE_WITNESS_COMMAND, "lattice_sign_governance_witness");
assert.equal(
  TOWNSHIP_GOVERNANCE_WITNESS_PUBLIC_KEY_COMMAND,
  "lattice_governance_witness_public_key",
);

const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
const invoke: TauriInvoke = async <T = unknown>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> => {
  calls.push({ command, args });
  const result =
    command === TOWNSHIP_ENSURE_GOVERNANCE_WITNESS_KEY_COMMAND ||
    command === TOWNSHIP_GOVERNANCE_WITNESS_PUBLIC_KEY_COMMAND
      ? witness
      : { witness, signature, payloadDigest };
  return result as T;
};

assert.equal(await ensureGovernanceWitnessKey({ invoke }), witness);
assert.equal(await loadGovernanceWitnessPublicKey({ invoke }), witness);
assert.deepEqual(await signGovernanceWitnessClaim(claim, witness, { invoke }), {
  witness,
  signature,
  payloadDigest,
});
assert.equal(verifyGovernanceWitnessSignature(claim, witness, signature), true);
assert.equal(
  verifyGovernanceWitnessSignature(
    claim,
    witness,
    Buffer.from(new Uint8Array(64)).toString("base64"),
  ),
  false,
);
assert.deepEqual(calls, [
  { command: TOWNSHIP_ENSURE_GOVERNANCE_WITNESS_KEY_COMMAND, args: {} },
  { command: TOWNSHIP_GOVERNANCE_WITNESS_PUBLIC_KEY_COMMAND, args: {} },
  { command: TOWNSHIP_SIGN_GOVERNANCE_WITNESS_COMMAND, args: { claim } },
]);

for (const result of [
  {
    witness,
    signature,
    payloadDigest: `${payloadDigest.slice(0, 10)}${payloadDigest[10] === "A" ? "B" : "A"}${payloadDigest.slice(11)}`,
  },
  { witness: otherWitness, signature: otherSignature, payloadDigest },
  { witness, signature: Buffer.from(new Uint8Array(64)).toString("base64"), payloadDigest },
  { witness, signature, payloadDigest, bytes: "caller-selected" },
]) {
  const refusingInvoke: TauriInvoke = async <T = unknown>() => result as T;
  await assert.rejects(signGovernanceWitnessClaim(claim, witness, { invoke: refusingInvoke }));
}

const malformedEnsureInvoke: TauriInvoke = async <T = unknown>() => "not-base64" as T;
await assert.rejects(ensureGovernanceWitnessKey({ invoke: malformedEnsureInvoke }));

console.log("\x1b[32m✓ governance witness native bridge checks passed\x1b[0m");
