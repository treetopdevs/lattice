// Conformance harness: the TS reducer MUST reproduce Lattice.Sim's output.
//
// Sim (Elixir) is the oracle. For each vector (exported by the mix task, or
// hand-authored from a verified scenario), we materialize with the TS reducer
// and assert equality of state, quarantine set, and the partial-frontier LWW
// behaviour. Any drift here is exactly the two-implementations bug V-01 exists
// to prevent — so this file is the guardrail that lets a second (TS)
// implementation of the reducer exist at all.
//
// Run:  npx tsx test/conformance.ts   (from lattice-client/)
// Tier B (byte-identical op hashes) is added here once ADR-P08 / CBOR lands and
// vectors carry `encoding`.

import { readFileSync, readdirSync } from "node:fs";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  analyzeAuthority,
  canonicalBytesForCarrierDelegation,
  canonicalHash,
  canonicalOrder,
  carrierDelegationsFromFrames,
  carrierOpsToSemanticOps,
  decodeCarrierOpFrame,
  index,
  materialize,
  verifyCarrierOp,
  verifyWitnessedSuccessionCertificate,
  witnessedRecoveryPolicyId,
} from "../src/index";
import type { Op, ReplicaSchema } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const vecDir = join(here, "vectors");
const verifier = { verify: verifyEd25519 };

let failures = 0;
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function check(name: string, got: unknown, want: unknown) {
  const ok = eq(got, want);
  if (!ok) failures++;
  const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag} ${name}`);
  if (!ok) {
    console.log(`       got : ${JSON.stringify(got)}`);
    console.log(`       want: ${JSON.stringify(want)}`);
  }
}

function sortedPairs(pairs: readonly [string, string][]): [string, string][] {
  return [...pairs].sort(([left], [right]) => left.localeCompare(right));
}

interface Vector {
  scenario: string;
  schema: ReplicaSchema;
  ops: Op[];
  capabilityCase?: {
    expectedSuccessorPubkey?: string;
    [key: string]: unknown;
  };
  oracleCarrierOps?: unknown[];
  realmByPubkey?: Record<string, string>;
  successionOperationId?: string;
  tickProvenance?: "author_asserted_untrusted";
  genesisProjection?: {
    role: string;
    acquisitionOperationIds: string[];
    holderPubkey: string;
    holderEpochOperationId: string;
    effectivePolicy: {
      mode: "witnessed";
      version: number;
      successorPubkey: string;
      witnessPubkeys: string[];
      threshold: number;
    };
    winningPolicyGenesisOperationId: string;
    policyId: string;
    impostorGenesisOperationId: string;
  };
  witnessedRecovery?: {
    deniedOperationId: string;
    honoredOperationId: string;
    impostorPolicyGenesisOperationId: string;
    impostorPolicySuccessionOperationId: string;
    policyId: string;
    claim: {
      version: number;
      replica: string;
      role: string;
      holderPubkey: string;
      holderEpoch: string;
      successorPubkey: string;
      policyId: string;
    };
    policy: {
      mode: "witnessed";
      version: number;
      witnessPubkeys: string[];
      threshold: number;
    };
  };
  expectAtFullFrontier: {
    state: Record<string, unknown>;
    quarantine: string[];
    authorityQuarantine?: [string, string][];
    winners?: Record<string, string | null>;
  };
  expectAtFrontier?: { include: string[]; state: Record<string, unknown>; note?: string }[];
}

for (const file of readdirSync(vecDir).filter((f) => f.endsWith(".json"))) {
  const vec = JSON.parse(readFileSync(join(vecDir, file), "utf8")) as Vector;
  console.log(`\n▸ ${vec.scenario}  (${file})`);

  const carrierFrames = vec.oracleCarrierOps?.map(decodeCarrierOpFrame);
  const ops =
    carrierFrames !== undefined && vec.realmByPubkey !== undefined
      ? carrierOpsToSemanticOps(carrierFrames, vec.realmByPubkey)
      : vec.ops;

  if (vec.capabilityCase !== undefined && carrierFrames !== undefined) {
    for (const frame of carrierFrames.filter((candidate) => candidate.kind === "command")) {
      const semantic = ops.find((op) => op.id === frame.id) as
        | (Op & { cap?: string | null })
        | undefined;
      const expectedCap =
        frame.cap[0] === "bin"
          ? Buffer.from(frame.cap[1], "base64").toString("utf8")
          : null;

      check(`command ${frame.id} decoded`, semantic !== undefined, true);
      check(`command ${frame.id} retained capability`, semantic?.cap, expectedCap);
    }
  }

  if (vec.scenario === "township_authority_forged_root") {
    const [frame] = carrierFrames ?? [];
    check(
      "impostor genesis carrier hash/signature",
      frame === undefined ? null : await verifyCarrierOp(frame, verifier),
      { hash: true, signature: true, valid: true },
    );

    const [delegation] = frame === undefined ? [] : carrierDelegationsFromFrames([frame]);
    const delegationBytes =
      delegation === undefined ? undefined : canonicalBytesForCarrierDelegation(delegation);
    check(
      "impostor genesis delegation hash",
      delegationBytes === undefined ? null : await canonicalHash(delegationBytes),
      delegation?.id,
    );
    check(
      "impostor genesis delegation signature",
      delegation === undefined || delegationBytes === undefined
        ? false
        : await verifyEd25519(
            delegation.issuer,
            delegationBytes,
            Buffer.from(delegation.sig, "base64"),
          ),
      true,
    );
  }

  if (vec.scenario === "township_authority_forged_delegation_sig") {
    const [frame] = carrierFrames ?? [];
    check(
      "forged delegation signature outer op hash/signature",
      frame === undefined ? null : await verifyCarrierOp(frame, verifier),
      { hash: true, signature: true, valid: true },
    );

    const [delegation] = frame === undefined ? [] : carrierDelegationsFromFrames([frame]);
    const delegationBytes =
      delegation === undefined ? undefined : canonicalBytesForCarrierDelegation(delegation);
    check(
      "forged delegation signature hash",
      delegationBytes === undefined ? null : await canonicalHash(delegationBytes),
      delegation?.id,
    );
    check(
      "forged delegation signature verification",
      delegation === undefined || delegationBytes === undefined
        ? true
        : await verifyEd25519(
            delegation.issuer,
            delegationBytes,
            Buffer.from(delegation.sig, "base64"),
          ),
      false,
    );
  }

  if (vec.scenario === "township_authority_delegation_id_collision") {
    const [forgedFrame, pristineFrame] = carrierFrames ?? [];
    check(
      "delegation collision outer op hash/signatures",
      forgedFrame === undefined || pristineFrame === undefined
        ? null
        : [
            await verifyCarrierOp(forgedFrame, verifier),
            await verifyCarrierOp(pristineFrame, verifier),
          ],
      [
        { hash: true, signature: true, valid: true },
        { hash: true, signature: true, valid: true },
      ],
    );

    const [forgedDelegation, pristineDelegation] =
      forgedFrame === undefined || pristineFrame === undefined
        ? []
        : carrierDelegationsFromFrames([forgedFrame, pristineFrame]);
    const forgedBytes =
      forgedDelegation === undefined
        ? undefined
        : canonicalBytesForCarrierDelegation(forgedDelegation);
    const pristineBytes =
      pristineDelegation === undefined
        ? undefined
        : canonicalBytesForCarrierDelegation(pristineDelegation);

    check(
      "delegation collision canonical identity",
      forgedBytes === undefined ||
        pristineBytes === undefined ||
        forgedDelegation === undefined ||
        pristineDelegation === undefined
        ? null
        : {
            bytesEqual: Buffer.from(forgedBytes).equals(Buffer.from(pristineBytes)),
            forgedHash: await canonicalHash(forgedBytes),
            forgedId: forgedDelegation.id,
            pristineHash: await canonicalHash(pristineBytes),
            pristineId: pristineDelegation.id,
          },
      forgedDelegation === undefined || pristineDelegation === undefined
        ? null
        : {
            bytesEqual: true,
            forgedHash: pristineDelegation.id,
            forgedId: pristineDelegation.id,
            pristineHash: pristineDelegation.id,
            pristineId: pristineDelegation.id,
          },
    );

    const forgedSig =
      forgedDelegation === undefined ? undefined : Buffer.from(forgedDelegation.sig, "base64");
    const pristineSig =
      pristineDelegation === undefined
        ? undefined
        : Buffer.from(pristineDelegation.sig, "base64");
    check(
      "delegation collision embedded signature asymmetry",
      forgedDelegation === undefined ||
        pristineDelegation === undefined ||
        forgedBytes === undefined ||
        pristineBytes === undefined ||
        forgedSig === undefined ||
        pristineSig === undefined
        ? null
        : {
            signaturesEqual: forgedSig.equals(pristineSig),
            lengths: [forgedSig.length, pristineSig.length],
            forgedValid: await verifyEd25519(
              forgedDelegation.issuer,
              forgedBytes,
              forgedSig,
            ),
            pristineValid: await verifyEd25519(
              pristineDelegation.issuer,
              pristineBytes,
              pristineSig,
            ),
          },
      {
        signaturesEqual: false,
        lengths: [64, 64],
        forgedValid: false,
        pristineValid: true,
      },
    );
    check(
      "delegation collision forged outer op sorts first",
      forgedFrame === undefined || pristineFrame === undefined
        ? null
        : forgedFrame.id < pristineFrame.id,
      true,
    );
  }

  // full-frontier materialization
  const full = materialize(vec.schema, ops);
  const exp = vec.expectAtFullFrontier;

  for (const [field, want] of Object.entries(exp.state)) {
    check(`state.${field}`, full.state[field], want);
  }
  check("quarantine set", [...full.quarantine].sort(), [...exp.quarantine].sort());
  if (vec.capabilityCase !== undefined) {
    const reasoned = full as typeof full & {
      quarantineReasons?: ReadonlyMap<string, string>;
    };
    const reasonPairs =
      reasoned.quarantineReasons === undefined
        ? null
        : sortedPairs([...reasoned.quarantineReasons]);

    check(
      "quarantine reason pairs",
      reasonPairs,
      sortedPairs(exp.authorityQuarantine ?? []),
    );
    check(
      "quarantine reason ids",
      reasonPairs?.map(([id]) => id) ?? null,
      [...full.quarantine].sort(),
    );
  }
  if (exp.winners) {
    for (const [field, want] of Object.entries(exp.winners)) {
      check(`winner.${field}`, full.winners[field], want);
    }
  }

  if (vec.scenario === "township_succession_unproven_tick") {
    const successionId = vec.successionOperationId ?? "<missing succession operation id>";
    const verificationResults =
      carrierFrames === undefined
        ? null
        : await Promise.all(carrierFrames.map((frame) => verifyCarrierOp(frame, verifier)));

    check("unproven-tick carrier hash/signatures", verificationResults, [
      { hash: true, signature: true, valid: true },
      { hash: true, signature: true, valid: true },
    ]);
    check(
      "unproven-tick succession id in carrier evidence",
      carrierFrames?.some((frame) => frame.id === successionId) ?? false,
      true,
    );
    check("unproven-tick provenance marker", vec.tickProvenance, "author_asserted_untrusted");
    check(
      "unproven-tick succession absent from TS quarantine",
      full.quarantine.includes(successionId),
      false,
    );
    check(
      "unproven-tick succession absent from BEAM authority quarantine",
      exp.authorityQuarantine?.some(([id]) => id === successionId) ?? null,
      false,
    );
    check("unproven-tick clerk state", full.state.clerk, "resident");
    check("unproven-tick clerk winner", full.winners.clerk, successionId);
  }

  if (vec.scenario === "township_genesis_projection_parity") {
    const projection = vec.genesisProjection;
    const byId = index(ops);
    const included = new Set(ops.map((op) => op.id));
    const authority = analyzeAuthority(
      vec.schema,
      ops,
      included,
      canonicalOrder(ops, byId),
      byId,
    );
    const reversedOps = [...ops].reverse();
    const reversedById = index(reversedOps);
    const reversedAuthority = analyzeAuthority(
      vec.schema,
      reversedOps,
      included,
      canonicalOrder(reversedOps, reversedById),
      reversedById,
    );
    const acquisitions = authority.acquiresByRole.get(projection?.role ?? "") ?? [];
    const currentAcquire = acquisitions.at(-1);
    const policyProjection = authority.recoveryPoliciesByRole.get(projection?.role ?? "");
    const witnessedPolicy =
      policyProjection?.policy.mode === "witnessed" ? policyProjection.policy : undefined;

    check(
      "genesis-projection carrier hash/signatures",
      carrierFrames === undefined
        ? null
        : await Promise.all(carrierFrames.map((frame) => verifyCarrierOp(frame, verifier))),
      [
        { hash: true, signature: true, valid: true },
        { hash: true, signature: true, valid: true },
        { hash: true, signature: true, valid: true },
      ],
    );
    check(
      "genesis-projection local authority input boundary",
      analyzeAuthority.length,
      5,
    );
    check(
      "genesis-projection delivery-order independence",
      {
        acquisitions: reversedAuthority.acquiresByRole
          .get(projection?.role ?? "")
          ?.map((acquire) => acquire.opId),
        policyGenesisOperationId: reversedAuthority.recoveryPoliciesByRole.get(
          projection?.role ?? "",
        )?.genesisOperationId,
      },
      {
        acquisitions: authority.acquiresByRole
          .get(projection?.role ?? "")
          ?.map((acquire) => acquire.opId),
        policyGenesisOperationId: authority.recoveryPoliciesByRole.get(
          projection?.role ?? "",
        )?.genesisOperationId,
      },
    );
    check(
      "genesis-projection acquisition timeline",
      acquisitions.map((acquire) => ({
        opId: acquire.opId,
        holder: acquire.holder,
        holderPubkey: acquire.holderPubkey,
        atTick: acquire.atTick,
      })),
      projection?.acquisitionOperationIds.map((opId) => ({
        opId,
        holder: "clerk",
        holderPubkey: projection.holderPubkey,
        atTick: 0,
      })),
    );
    check(
      "genesis-projection current holder epoch",
      currentAcquire === undefined
        ? null
        : { opId: currentAcquire.opId, holderPubkey: currentAcquire.holderPubkey },
      projection === undefined
        ? undefined
        : {
            opId: projection.holderEpochOperationId,
            holderPubkey: projection.holderPubkey,
          },
    );
    check(
      "genesis-projection recovery policy source",
      policyProjection?.genesisOperationId,
      projection?.winningPolicyGenesisOperationId,
    );
    check(
      "genesis-projection effective witnessed policy",
      witnessedPolicy === undefined
        ? null
        : Object.entries({
            mode: witnessedPolicy.mode,
            version: witnessedPolicy.recovery.version,
            successorPubkey: witnessedPolicy.successor,
            witnessPubkeys: [...witnessedPolicy.recovery.witnesses].sort(),
            threshold: witnessedPolicy.recovery.threshold,
          }).sort(([left], [right]) => left.localeCompare(right)),
      projection === undefined
        ? undefined
        : Object.entries({
            ...projection.effectivePolicy,
            witnessPubkeys: [...projection.effectivePolicy.witnessPubkeys].sort(),
          }).sort(([left], [right]) => left.localeCompare(right)),
    );
    check(
      "genesis-projection recomputed policy id",
      witnessedPolicy === undefined
        ? null
        : witnessedRecoveryPolicyId(witnessedPolicy.recovery),
      projection?.policyId,
    );
    check(
      "genesis-projection bound root",
      authority.security.root?.pubkey,
      projection?.holderPubkey,
    );
    check(
      "genesis-projection impostor reason",
      authority.quarantineReasons.get(projection?.impostorGenesisOperationId ?? ""),
      "impostor_genesis",
    );
  }

  if (vec.scenario === "township_authority_replayed_genesis") {
    const byId = index(ops);
    const authority = analyzeAuthority(
      vec.schema,
      ops,
      new Set(ops.map((op) => op.id)),
      canonicalOrder(ops, byId),
      byId,
    );

    check(
      "replayed genesis cannot replace the root-authored succession policy",
      authority.policiesByRole.get("clerk")?.successor,
      vec.capabilityCase?.expectedSuccessorPubkey,
    );
  }

  if (vec.scenario === "township_succession_witnessed_recovery") {
    const recovery = vec.witnessedRecovery;
    const genesisFrame = carrierFrames?.find((frame) => frame.id === recovery?.claim.holderEpoch);
    const impostorGenesisFrame = carrierFrames?.find(
      (frame) => frame.id === recovery?.impostorPolicyGenesisOperationId,
    );
    const impostorSuccessionFrame = carrierFrames?.find(
      (frame) => frame.id === recovery?.impostorPolicySuccessionOperationId,
    );
    const deniedFrame = carrierFrames?.find(
      (frame) => frame.id === recovery?.deniedOperationId,
    );
    const honoredFrame = carrierFrames?.find(
      (frame) => frame.id === recovery?.honoredOperationId,
    );
    const genesisOp = ops.find((op) => op.id === genesisFrame?.id);
    const impostorGenesisOp = ops.find((op) => op.id === impostorGenesisFrame?.id);
    const impostorSuccessionOp = ops.find((op) => op.id === impostorSuccessionFrame?.id);
    const deniedOp = ops.find((op) => op.id === recovery?.deniedOperationId);
    const honoredOp = ops.find((op) => op.id === recovery?.honoredOperationId);
    const genesisEvidence =
      genesisOp?.authority?.type === "genesis" ? genesisOp.authority : undefined;
    const policy = genesisEvidence?.policies?.clerk;
    const witnessedPolicy = policy?.mode === "witnessed" ? policy : undefined;
    const impostorGenesisEvidence =
      impostorGenesisOp?.authority?.type === "genesis"
        ? impostorGenesisOp.authority
        : undefined;
    const impostorPolicy = impostorGenesisEvidence?.policies?.clerk;
    const witnessedImpostorPolicy =
      impostorPolicy?.mode === "witnessed" ? impostorPolicy : undefined;
    const impostorSuccessionEvidence =
      impostorSuccessionOp?.authority?.type === "succeed"
        ? impostorSuccessionOp.authority
        : undefined;
    const impostorProof =
      impostorSuccessionEvidence?.proof.mode === "witnessed"
        ? impostorSuccessionEvidence.proof
        : undefined;
    const deniedProof =
      deniedOp?.authority?.type === "succeed" && deniedOp.authority.proof.mode === "witnessed"
        ? deniedOp.authority.proof
        : undefined;
    const honoredEvidence =
      honoredOp?.authority?.type === "succeed" ? honoredOp.authority : undefined;
    const honoredProof =
      honoredEvidence?.proof.mode === "witnessed" ? honoredEvidence.proof : undefined;

    check(
      "witnessed-recovery carrier hash/signatures",
      carrierFrames === undefined
        ? null
        : await Promise.all(carrierFrames.map((frame) => verifyCarrierOp(frame, verifier))),
      [
        { hash: true, signature: true, valid: true },
        { hash: true, signature: true, valid: true },
        { hash: true, signature: true, valid: true },
        { hash: true, signature: true, valid: true },
        { hash: true, signature: true, valid: true },
      ],
    );

    const policyId =
      witnessedPolicy === undefined ? null : witnessedRecoveryPolicyId(witnessedPolicy.recovery);
    check("witnessed-recovery recomputed policy id", policyId, recovery?.policyId);

    const expectedClaim =
      genesisEvidence === undefined || honoredEvidence === undefined || honoredOp?.replica === undefined || policyId === null
        ? undefined
        : {
            version: 1,
            replica: honoredOp.replica,
            role: honoredEvidence.role,
            holder: genesisEvidence.delegation.audience,
            holderEpoch: genesisOp!.id,
            successor: honoredEvidence.delegation.audience,
            policyId,
          };

    check(
      "witnessed-recovery expected claim is independently bound",
      expectedClaim === undefined
        ? null
        : Object.entries({
            version: expectedClaim.version,
            replica: expectedClaim.replica,
            role: expectedClaim.role,
            holderPubkey: expectedClaim.holder,
            holderEpoch: expectedClaim.holderEpoch,
            successorPubkey: expectedClaim.successor,
            policyId: expectedClaim.policyId,
          }).sort(([left], [right]) => left.localeCompare(right)),
      recovery === undefined
        ? undefined
        : Object.entries(recovery.claim).sort(([left], [right]) => left.localeCompare(right)),
    );

    check(
      "witnessed-recovery denied certificate",
      witnessedPolicy === undefined || deniedProof === undefined || expectedClaim === undefined
        ? null
        : verifyWitnessedSuccessionCertificate(
            deniedProof.certificate,
            expectedClaim,
            witnessedPolicy.recovery,
          ),
      { valid: false, reason: "insufficient_recovery_witnesses" },
    );
    check(
      "witnessed-recovery honored certificate",
      witnessedPolicy === undefined || honoredProof === undefined || expectedClaim === undefined
        ? null
        : verifyWitnessedSuccessionCertificate(
            honoredProof.certificate,
            expectedClaim,
            witnessedPolicy.recovery,
          ),
      { valid: true },
    );

    const impostorPolicyId =
      witnessedImpostorPolicy === undefined
        ? null
        : witnessedRecoveryPolicyId(witnessedImpostorPolicy.recovery);
    const expectedImpostorClaim =
      genesisEvidence === undefined ||
      impostorSuccessionEvidence === undefined ||
      impostorSuccessionOp?.replica === undefined ||
      impostorPolicyId === null
        ? undefined
        : {
            version: 1,
            replica: impostorSuccessionOp.replica,
            role: impostorSuccessionEvidence.role,
            holder: genesisEvidence.delegation.audience,
            holderEpoch: genesisOp!.id,
            successor: impostorSuccessionEvidence.delegation.audience,
            policyId: impostorPolicyId,
          };

    check(
      "witnessed-recovery impostor certificate is cryptographically valid",
      witnessedImpostorPolicy === undefined ||
        impostorProof === undefined ||
        expectedImpostorClaim === undefined
        ? null
        : verifyWitnessedSuccessionCertificate(
            impostorProof.certificate,
            expectedImpostorClaim,
            witnessedImpostorPolicy.recovery,
          ),
      { valid: true },
    );
    check(
      "witnessed-recovery BEAM reason",
      exp.authorityQuarantine === undefined
        ? undefined
        : sortedPairs(exp.authorityQuarantine),
      recovery === undefined
        ? null
        : sortedPairs([
            [recovery.impostorPolicyGenesisOperationId, "impostor_genesis"],
            [recovery.impostorPolicySuccessionOperationId, "unauthorized_succession"],
            [recovery.deniedOperationId, "insufficient_recovery_witnesses"],
          ]),
    );

    check(
      "witnessed-recovery TS reason parity",
      sortedPairs([...full.quarantineReasons]),
      exp.authorityQuarantine === undefined
        ? undefined
        : sortedPairs(exp.authorityQuarantine),
    );

    let invalidSignatureResult: ReturnType<typeof materialize> | null = null;
    const invalidSignatureOps = structuredClone(ops);
    const invalidSignatureOp = invalidSignatureOps.find(
      (op) => op.id === recovery?.honoredOperationId,
    );
    if (
      invalidSignatureOp?.authority?.type === "succeed" &&
      invalidSignatureOp.authority.proof.mode === "witnessed" &&
      invalidSignatureOp.authority.proof.certificate !== null
    ) {
      const [firstSignature] = invalidSignatureOp.authority.proof.certificate.signatures;
      if (firstSignature !== undefined && firstSignature.signature.length > 0) {
        const invalidSignature = Buffer.from(firstSignature.signature, "base64");
        invalidSignature[0] = invalidSignature[0]! ^ 1;
        firstSignature.signature = invalidSignature.toString("base64");
        invalidSignatureResult = materialize(vec.schema, invalidSignatureOps);
      }
    }

    check(
      "witnessed-recovery signature is reducer-load-bearing",
      invalidSignatureResult === null || recovery === undefined || genesisOp === undefined
        ? null
        : {
            clerk: invalidSignatureResult.state.clerk,
            winner: invalidSignatureResult.winners.clerk,
            quarantine: [...invalidSignatureResult.quarantine].sort(),
          },
      recovery === undefined || genesisOp === undefined
        ? null
        : {
            clerk: "clerk",
            winner: genesisOp.id,
            quarantine: [
              recovery.impostorPolicyGenesisOperationId,
              recovery.impostorPolicySuccessionOperationId,
              recovery.deniedOperationId,
              recovery.honoredOperationId,
            ].sort(),
          },
    );
  }

  // partial-frontier assertions (the LWW flip, perspective, etc.)
  for (const fr of vec.expectAtFrontier ?? []) {
    const m = materialize(vec.schema, ops, new Set(fr.include));
    for (const [field, want] of Object.entries(fr.state)) {
      check(`@frontier[${fr.include.length}] state.${field}${fr.note ? ` (${fr.note})` : ""}`, m.state[field], want);
    }
  }
}

console.log("\n▸ externally determined quarantine");
{
  const schema: ReplicaSchema = {
    name: "ExternalQuarantine",
    fields: { posts: { merge: "causal_list" } },
  };
  const accepted: Op = {
    id: "accepted",
    deps: [],
    kind: "command",
    author: "resident",
    field: "posts",
    mutation: "append",
    value: "accepted",
    hash: "accepted",
  };
  const quarantined: Op = {
    id: "quarantined",
    deps: [accepted.id],
    kind: "command",
    author: "resident",
    field: "posts",
    mutation: "append",
    value: "quarantined",
    hash: "quarantined",
  };
  const result = materialize(
    schema,
    [accepted, quarantined],
    undefined,
    new Set([quarantined.id]),
  );

  check("externally quarantined mutation is not applied", result.state.posts, ["accepted"]);
  check("externally quarantined op remains in canonical order", result.order, [accepted.id, quarantined.id]);
  check("externally quarantined op remains auditable", result.quarantine, [quarantined.id]);
}

console.log(`\n${failures === 0 ? "\x1b[32m✓ all conformance checks passed\x1b[0m" : `\x1b[31m✗ ${failures} check(s) failed\x1b[0m`}`);
process.exit(failures === 0 ? 0 : 1);

async function verifyEd25519(
  author: string,
  bytes: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const publicKey = createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(author, "base64")]),
    format: "der",
    type: "spki",
  });

  return edVerify(null, Buffer.from(bytes), publicKey, Buffer.from(signature));
}
