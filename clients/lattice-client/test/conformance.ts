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
  toolshedCarrierCommandTable,
  toolshedCarrierCommandNames,
  townshipCarrierCommandTable,
  townshipCarrierCommandNames,
  verifyCarrierOp,
  verifyWitnessedSuccessionCertificate,
  witnessedRecoveryPolicyId,
  witnessedBeaconHorizon,
} from "../src/index";
import type { CarrierOpFrame, Op, ReplicaSchema } from "../src/index";

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

function authorityFor(
  schema: ReplicaSchema,
  ops: Op[],
  expectedReplica?: string,
) {
  const byId = index(ops);
  return analyzeAuthority(
    schema,
    ops,
    new Set(ops.map((op) => op.id)),
    canonicalOrder(ops, byId),
    byId,
    expectedReplica,
  );
}

type AuthorityProjection = ReturnType<typeof authorityFor>;

function checkForeignReplicaEvidence(
  label: string,
  schema: ReplicaSchema,
  ops: Op[],
  isTarget: (op: Op) => boolean,
  isEffective: (analysis: AuthorityProjection, target: Op | null) => boolean,
) {
  const target = ops.find(isTarget) ?? null;
  const expectedReplica = ops.find((op) => op.replica !== undefined)?.replica;
  const control = authorityFor(schema, ops, expectedReplica);
  const mutatedOps = structuredClone(ops);
  const mutatedTarget = mutatedOps.find((op) => op.id === target?.id);
  if (mutatedTarget !== undefined) {
    mutatedTarget.replica = `${mutatedTarget.replica}:sibling`;
  }
  const mutated = authorityFor(schema, mutatedOps, expectedReplica);

  check(
    `local outer replica ${label} is effective control`,
    target === null ? null : isEffective(control, target),
    true,
  );
  check(
    `foreign outer replica ${label} is ineffective`,
    target === null ? null : isEffective(mutated, target),
    false,
  );
  check(
    `foreign outer replica ${label} reason`,
    target === null ? null : mutated.quarantineReasons.get(target.id),
    "wrong_replica",
  );
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedPairs(pairs: readonly [string, string][]): [string, string][] {
  return [...pairs].sort(([left], [right]) => compareCodePoints(left, right));
}

function sortedStringArray(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === "string")
  ) {
    return null;
  }
  return [...value].sort();
}

function sortedCommandTable(value: unknown): [string, number][] | null {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item): item is [string, number] =>
        Array.isArray(item) &&
        item.length === 2 &&
        typeof item[0] === "string" &&
        typeof item[1] === "number",
    )
  ) {
    return null;
  }
  return [...value].sort(([left], [right]) => compareCodePoints(left, right));
}

/** Plan 158 Wave A2: one `applicationPolicyCase.<tier>` taxonomy entry. */
interface PolicyTaxonomyEntry {
  referenceOperationId: string;
  referenceReason: string | null;
  targetOperationId: string;
  targetReason: string | null;
}

/** All `items.length!` orderings, used to prove delivery-order independence. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const [head, ...rest] = items;
  if (head === undefined) return [[]];
  const out: T[][] = [];
  for (const sub of permutations(rest)) {
    for (let i = 0; i <= sub.length; i++) {
      out.push([...sub.slice(0, i), head, ...sub.slice(i)]);
    }
  }
  return out;
}

function stableComparisonValue(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, item]) => [stableComparisonValue(key), stableComparisonValue(item)])
      .sort(([left], [right]) =>
        compareCodePoints(JSON.stringify(left), JSON.stringify(right)),
      );
  }
  if (value instanceof Set) {
    return [...value]
      .map(stableComparisonValue)
      .sort((left, right) =>
        compareCodePoints(JSON.stringify(left), JSON.stringify(right)),
      );
  }
  if (Array.isArray(value)) return value.map(stableComparisonValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([key, item]) => [key, stableComparisonValue(item)]),
    );
  }
  return value;
}

interface Vector {
  scenario: string;
  schema: ReplicaSchema;
  ops: Op[];
  capabilityCase?: {
    expectedSuccessorPubkey?: string;
    [key: string]: unknown;
  };
  applicationPolicyCase?: {
    expectedReason?: string | null;
    referenceOperationId?: string;
    targetOperationId?: string;
    deniedEvent?: Record<string, unknown>;
    honoredEvent?: Record<string, unknown>;
    honoredOperationId?: string;
    application?: PolicyTaxonomyEntry;
    authority?: PolicyTaxonomyEntry;
    capabilityBeforeApplication?: PolicyTaxonomyEntry;
    honored?: PolicyTaxonomyEntry;
    structural?: PolicyTaxonomyEntry;
    wrongKind?: PolicyTaxonomyEntry;
    candidateOperationIds?: string[];
    conflictKey?: string;
    deliveryOrderPermutationsChecked?: number;
    expectedLoserReason?: string;
    loserOperationIds?: string[];
    winnerOperationId?: string;
    canonicalWinnerOperationId?: string;
    peerPartialFrontierOperationIds?: string[];
    provisionallyHonoredOperationId?: string;
    provisionallyHonoredRealm?: string;
    reclassifiedReason?: string;
    rootPartialFrontierOperationIds?: string[];
    [key: string]: unknown;
  };
  commandNames?: unknown;
  commandTable?: unknown;
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

const testedDisguisedEvidenceTypes = new Set<string>();
let testedBoundaryHeartbeat = false;
let testedTownshipCommandDrift = false;
let testedToolshedCommandDrift = false;

for (const file of readdirSync(vecDir).filter((f) => f.endsWith(".json"))) {
  const vec = JSON.parse(readFileSync(join(vecDir, file), "utf8")) as Vector;
  console.log(`\n▸ ${vec.scenario}  (${file})`);

  const horizonVector = vec.scenario === "township_beacon_witnessed_horizon";
  const carrierFrames = horizonVector
    ? vec.oracleCarrierOps as CarrierOpFrame[] | undefined
    : vec.oracleCarrierOps?.map(decodeCarrierOpFrame);
  if (horizonVector) {
    check("witnessed epoch horizon is fixed across runtimes", witnessedBeaconHorizon, 9_007_199_254_740_991);
    const frame = carrierFrames?.find((candidate) => candidate.id === vec.capabilityCase?.beaconOperationId);
    check("horizon vector supplies its signed beacon frame", frame !== undefined, true);
    if (frame !== undefined) {
      let refused = false;
      try { decodeCarrierOpFrame(frame); } catch { refused = true; }
      check("strict frame decoding refuses above-horizon integer", refused, true);
    }
  }
  const ops =
    carrierFrames !== undefined && vec.realmByPubkey !== undefined
      ? carrierOpsToSemanticOps(carrierFrames, vec.realmByPubkey)
      : vec.ops;

  if (vec.scenario === "township_beacon_witnessed_large_policy_integer" ||
      vec.scenario === "township_beacon_witnessed_unbound_root") {
    check("beacon review vector supplies raw signed frames", (carrierFrames?.length ?? 0) > 0, true);
    for (const frame of carrierFrames ?? []) {
      check("beacon review raw frame hash/signature", await verifyCarrierOp(frame, verifier),
        { hash: true, signature: true, valid: true });
      check("contextual decoding preserves exact raw frame", decodeCarrierOpFrame(frame), frame);
    }
  }

  for (const op of ops) {
    const evidenceType = op.authority?.type;
    if (evidenceType === undefined) continue;
    testedDisguisedEvidenceTypes.add(evidenceType);

    const disguisedOps = structuredClone(ops);
    const disguisedOp = disguisedOps.find((candidate) => candidate.id === op.id);
    if (disguisedOp !== undefined) disguisedOp.kind = "command";

    const scrubbedOps = structuredClone(disguisedOps);
    const scrubbedOp = scrubbedOps.find((candidate) => candidate.id === op.id);
    if (scrubbedOp !== undefined) delete scrubbedOp.authority;

    const disguisedById = index(disguisedOps);
    const scrubbedById = index(scrubbedOps);
    const disguisedAnalysis = analyzeAuthority(
      vec.schema,
      disguisedOps,
      new Set(disguisedOps.map((candidate) => candidate.id)),
      canonicalOrder(disguisedOps, disguisedById),
      disguisedById,
    );
    const scrubbedAnalysis = analyzeAuthority(
      vec.schema,
      scrubbedOps,
      new Set(scrubbedOps.map((candidate) => candidate.id)),
      canonicalOrder(scrubbedOps, scrubbedById),
      scrubbedById,
    );

    check(
      `non-authority ${evidenceType} evidence is inert (${op.id})`,
      stableComparisonValue(disguisedAnalysis),
      stableComparisonValue(scrubbedAnalysis),
    );
  }

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

  if (vec.scenario === "township_link_election") {
    testedTownshipCommandDrift = true;
    const commandNames = vec.capabilityCase?.commandNames;
    check(
      "Township command decoder table matches the BEAM DSL",
      townshipCarrierCommandNames(),
      sortedStringArray(commandNames),
    );
    check(
      "Township command decoder arities match the BEAM DSL",
      townshipCarrierCommandTable(),
      sortedCommandTable(vec.capabilityCase?.commandTable),
    );
  }
  if (vec.scenario === "toolshed_custody_consent") {
    testedToolshedCommandDrift = true;
    check(
      "Toolshed command decoder table matches the BEAM DSL",
      toolshedCarrierCommandNames(),
      sortedStringArray(vec.commandNames),
    );
    check(
      "Toolshed command decoder arities match the BEAM DSL",
      toolshedCarrierCommandTable(),
      sortedCommandTable(vec.commandTable),
    );
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

  if (vec.scenario === "township_authority_double_transfer") {
    const genesis = ops.find((op) => op.authority?.type === "genesis");
    const honoredTransfer = ops.find(
      (op) =>
        op.authority?.type === "transfer" &&
        !exp.quarantine.includes(op.id),
    );
    const controlOps = [genesis, honoredTransfer].filter(
      (op): op is Op => op !== undefined,
    );
    const control = materialize(vec.schema, controlOps);

    check(
      "outer replica transfer mutation control moves holder",
      control.state.clerk,
      "resident",
    );
    check(
      "outer replica transfer mutation control remains honored",
      honoredTransfer === undefined
        ? null
        : control.quarantine.includes(honoredTransfer.id),
      false,
    );

    if (genesis !== undefined) {
      const forgedReplica = `${genesis.replica}:foreign`;
      const evidenceFreeWrite = structuredClone(genesis);
      evidenceFreeWrite.id = "0000000000000000000000000000000000000000000";
      evidenceFreeWrite.hash = "0000000000000000000000000000000000000000000";
      evidenceFreeWrite.replica = forgedReplica;
      evidenceFreeWrite.deps = [];
      evidenceFreeWrite.author = "mallory";
      evidenceFreeWrite.value = "mallory";
      delete evidenceFreeWrite.authority;
      const mixedReplicaOps = [genesis, evidenceFreeWrite];
      let unpinnedError = "";
      try {
        materialize(vec.schema, mixedReplicaOps);
      } catch (error) {
        unpinnedError = error instanceof Error ? error.name : String(error);
      }
      const pinned = materialize(
        vec.schema,
        mixedReplicaOps,
        undefined,
        null,
        genesis.replica,
      );

      check(
        "unpinned mixed-replica authority history fails closed",
        unpinnedError,
        "V01UnvalidatedAuthorityError",
      );
      check(
        "pinned mixed-replica authority history keeps genuine holder",
        pinned.state.clerk,
        "clerk",
      );
      check(
        "pinned mixed-replica authority history quarantines foreign write",
        pinned.quarantineReasons.get(evidenceFreeWrite.id),
        "wrong_replica",
      );
    }

    for (const replicaMutation of ["missing", "mismatched"] as const) {
      const mutatedOps = structuredClone(controlOps);
      const transfer = mutatedOps.find((op) => op.authority?.type === "transfer");
      if (transfer !== undefined) {
        if (replicaMutation === "missing") delete transfer.replica;
        else transfer.replica = `${transfer.replica}:sibling`;
      }
      const mutated = materialize(
        vec.schema,
        mutatedOps,
        undefined,
        null,
        genesis?.replica,
      );

      check(
        `${replicaMutation} outer replica cannot move holder by transfer`,
        mutated.state.clerk,
        "clerk",
      );
      check(
        `${replicaMutation} outer replica transfer is quarantined`,
        honoredTransfer === undefined
          ? null
          : mutated.quarantine.includes(honoredTransfer.id),
        true,
      );
      check(
        `${replicaMutation} outer replica transfer reason`,
        honoredTransfer === undefined
          ? null
          : mutated.quarantineReasons.get(honoredTransfer.id),
        "wrong_replica",
      );
    }
  }

  if (vec.scenario === "township_succession_unproven_tick") {
    const genesis = ops.find((op) => op.authority?.type === "genesis");
    const succession = ops.find((op) => op.authority?.type === "succeed");
    const expectedReplica = genesis?.replica;

    check(
      "outer replica succession mutation control moves holder",
      full.state.clerk,
      "resident",
    );
    check(
      "outer replica succession mutation control remains honored",
      succession === undefined ? null : full.quarantine.includes(succession.id),
      false,
    );

    for (const replicaMutation of ["missing", "mismatched"] as const) {
      const mutatedOps = structuredClone(ops);
      const mutatedSuccession = mutatedOps.find(
        (op) => op.authority?.type === "succeed",
      );
      if (mutatedSuccession !== undefined) {
        if (replicaMutation === "missing") delete mutatedSuccession.replica;
        else mutatedSuccession.replica = `${mutatedSuccession.replica}:sibling`;
      }
      const mutated = materialize(
        vec.schema,
        mutatedOps,
        undefined,
        null,
        expectedReplica,
      );

      check(
        `${replicaMutation} outer replica cannot move holder by succession`,
        mutated.state.clerk,
        "clerk",
      );
      check(
        `${replicaMutation} outer replica succession is quarantined`,
        succession === undefined ? null : mutated.quarantine.includes(succession.id),
        true,
      );
      check(
        `${replicaMutation} outer replica succession reason`,
        succession === undefined
          ? null
          : mutated.quarantineReasons.get(succession.id),
        "wrong_replica",
      );
    }

    for (const replicaMutation of ["missing", "mismatched"] as const) {
      const mutatedOps = structuredClone(ops);
      const mutatedGenesis = mutatedOps.find(
        (op) => op.authority?.type === "genesis",
      );
      if (mutatedGenesis !== undefined) {
        if (replicaMutation === "missing") delete mutatedGenesis.replica;
        else mutatedGenesis.replica = "replica:matter:unbound-policy-poison";
      }
      const mutated = materialize(
        vec.schema,
        mutatedOps,
        undefined,
        null,
        expectedReplica,
      );
      const authority = authorityFor(vec.schema, mutatedOps, expectedReplica);

      check(
        `${replicaMutation} outer replica genesis cannot install succession policy`,
        authority.policiesByRole.has("clerk"),
        false,
      );
      check(
        `${replicaMutation} outer replica genesis cannot enable succession`,
        mutated.state.clerk === "resident",
        false,
      );
      check(
        `${replicaMutation} outer replica genesis reason`,
        genesis === undefined ? null : mutated.quarantineReasons.get(genesis.id),
        "wrong_replica",
      );
    }
  }

  for (const [field, want] of Object.entries(exp.state)) {
    check(`state.${field}`, full.state[field], want);
  }
  check("quarantine set", [...full.quarantine].sort(), [...exp.quarantine].sort());
  if (vec.scenario === "township_link_election") {
    const linkOperationId = vec.capabilityCase?.linkOperationId;
    const withoutLink =
      typeof linkOperationId === "string"
        ? materialize(
            vec.schema,
            ops.filter((op) => op.id !== linkOperationId),
          )
        : null;
    const linkOperation =
      typeof linkOperationId === "string"
        ? ops.find((op) => op.id === linkOperationId)
        : undefined;

    check(
      "link_election carries its real command name",
      linkOperation?.command,
      "link_election",
    );
    check(
      "link_election zero-mutation state is byte-identical",
      JSON.stringify(full.state),
      withoutLink === null ? null : JSON.stringify(withoutLink.state),
    );
  }
  if (vec.capabilityCase?.legacyMigration !== undefined) {
    const migration = vec.capabilityCase.legacyMigration as {
      oracleCarrierOps: CarrierOpFrame[]; realmByPubkey: Record<string, string>;
      state: Record<string, unknown>; legacyReasonPairs: [string, string][];
      auditDeltaOperationId: string; authorityQuarantine: [string, string][];
    };
    const historicalOps = carrierOpsToSemanticOps(migration.oracleCarrierOps, migration.realmByPubkey);
    const migrated = materialize(vec.schema, historicalOps);
    check("legacy beacon history preserves state and holders", stableComparisonValue(migrated.state), stableComparisonValue(migration.state));
    check("legacy beacon history has exactly the authorized audit delta", sortedPairs([...migrated.quarantineReasons]), sortedPairs([...migration.legacyReasonPairs, [migration.auditDeltaOperationId, "unauthorized_beacon"]]));
  }
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

  // Plan 158 Wave A2: causal application-policy context + full-frontier
  // conflicts. Mirrors the `capabilityCase` reason-pairs check above, then
  // pins each `township_policy_*` scenario's specific mechanism.
  if (vec.applicationPolicyCase !== undefined) {
    const reasonPairs = sortedPairs([...full.quarantineReasons]);
    check(
      "application policy quarantine reason pairs",
      reasonPairs,
      sortedPairs(exp.authorityQuarantine ?? []),
    );
    check(
      "application policy quarantine reason ids",
      reasonPairs.map(([id]) => id),
      [...full.quarantine].sort(),
    );

    const policyCase = vec.applicationPolicyCase;

    if (policyCase.referenceOperationId !== undefined) {
      check(
        "application policy reference verdict",
        full.quarantineReasons.get(policyCase.referenceOperationId) ?? null,
        policyCase.expectedReason ?? null,
      );
    }

    if (vec.scenario === "township_policy_application_denied_excluded_from_state") {
      check(
        "application-denied command verdict",
        policyCase.targetOperationId === undefined
          ? null
          : (full.quarantineReasons.get(policyCase.targetOperationId) ?? null),
        policyCase.expectedReason ?? null,
      );
      check(
        "application-denied command excluded from state",
        full.state.events,
        policyCase.honoredEvent === undefined ? null : [policyCase.honoredEvent],
      );
    }

    if (vec.scenario === "township_policy_target_reason_taxonomy") {
      const tiers: [string, PolicyTaxonomyEntry | undefined][] = [
        ["honored", policyCase.honored],
        ["structural", policyCase.structural],
        ["authority", policyCase.authority],
        ["capabilityBeforeApplication", policyCase.capabilityBeforeApplication],
        ["application", policyCase.application],
        ["wrongKind", policyCase.wrongKind],
      ];
      for (const [tier, entry] of tiers) {
        if (entry === undefined) continue;
        check(
          `target-reason-taxonomy[${tier}] target verdict`,
          full.quarantineReasons.get(entry.targetOperationId) ?? null,
          entry.targetReason,
        );
        check(
          `target-reason-taxonomy[${tier}] reference verdict`,
          full.quarantineReasons.get(entry.referenceOperationId) ?? null,
          entry.referenceReason,
        );
      }
    }

    if (vec.scenario === "township_policy_full_frontier_conflict_delivery_order") {
      const candidateIds = policyCase.candidateOperationIds ?? [];
      const conflictWinnerId = policyCase.winnerOperationId;
      const conflictLoserIds = policyCase.loserOperationIds ?? [];
      const expectedLoserReason = policyCase.expectedLoserReason ?? null;
      const fixedOps = ops.filter((op) => !candidateIds.includes(op.id));
      const candidateOps = candidateIds
        .map((id) => ops.find((op) => op.id === id))
        .filter((op): op is Op => op !== undefined);

      let permutationsChecked = 0;
      for (const permutation of permutations(candidateOps)) {
        permutationsChecked++;
        const permuted = materialize(vec.schema, [...fixedOps, ...permutation]);
        check(
          `delivery-order permutation ${permutationsChecked} winner honored`,
          conflictWinnerId === undefined
            ? null
            : (permuted.quarantineReasons.get(conflictWinnerId) ?? null),
          null,
        );
        check(
          `delivery-order permutation ${permutationsChecked} loser reasons`,
          conflictLoserIds.map((id) => permuted.quarantineReasons.get(id) ?? null),
          conflictLoserIds.map(() => expectedLoserReason),
        );
        check(
          `delivery-order permutation ${permutationsChecked} state is delivery-order independent`,
          JSON.stringify(permuted.state),
          JSON.stringify(full.state),
        );
      }
      check(
        "delivery-order permutations checked matches vector",
        permutationsChecked,
        policyCase.deliveryOrderPermutationsChecked,
      );
    }

    if (vec.scenario === "township_policy_partial_frontier_reclassification") {
      const partialPeerIds = policyCase.peerPartialFrontierOperationIds;
      const partialRootIds = policyCase.rootPartialFrontierOperationIds;
      const provisionalId = policyCase.provisionallyHonoredOperationId;
      const canonicalWinnerId = policyCase.canonicalWinnerOperationId;

      const peerPartial =
        partialPeerIds === undefined ? null : materialize(vec.schema, ops, new Set(partialPeerIds));
      const rootPartial =
        partialRootIds === undefined ? null : materialize(vec.schema, ops, new Set(partialRootIds));

      check(
        "peer partial frontier provisionally honors its own claim",
        peerPartial === null || provisionalId === undefined
          ? null
          : (peerPartial.quarantineReasons.get(provisionalId) ?? null),
        null,
      );
      check(
        "root partial frontier provisionally honors the canonical winner",
        rootPartial === null || canonicalWinnerId === undefined
          ? null
          : (rootPartial.quarantineReasons.get(canonicalWinnerId) ?? null),
        null,
      );
      check(
        "full frontier reclassifies the provisionally honored claim",
        provisionalId === undefined ? null : (full.quarantineReasons.get(provisionalId) ?? null),
        policyCase.reclassifiedReason ?? null,
      );
      check(
        "full frontier keeps the canonical winner honored",
        canonicalWinnerId === undefined
          ? null
          : (full.quarantineReasons.get(canonicalWinnerId) ?? null),
        null,
      );
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
          }).sort(([left], [right]) => compareCodePoints(left, right)),
      projection === undefined
        ? undefined
        : Object.entries({
            ...projection.effectivePolicy,
            witnessPubkeys: [...projection.effectivePolicy.witnessPubkeys].sort(),
          }).sort(([left], [right]) => compareCodePoints(left, right)),
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

  if (vec.scenario === "township_succession_w3") {
    const disguisedOps = structuredClone(ops);
    const disguisedSuccession = disguisedOps.find(
      (op) => op.authority?.type === "succeed",
    );

    if (disguisedSuccession !== undefined) {
      disguisedSuccession.kind = "command";
    }

    const disguisedById = index(disguisedOps);
    const disguisedAuthority = analyzeAuthority(
      vec.schema,
      disguisedOps,
      new Set(disguisedOps.map((op) => op.id)),
      canonicalOrder(disguisedOps, disguisedById),
      disguisedById,
    );
    const disguisedDelegationId =
      disguisedSuccession?.authority?.type === "succeed"
        ? disguisedSuccession.authority.delegation.id
        : "";

    check(
      "non-authority evidence cannot introduce a succession delegation",
      disguisedAuthority.security.delegations.has(disguisedDelegationId),
      false,
    );
    check(
      "non-authority succession evidence cannot acquire a role",
      disguisedSuccession === undefined
        ? null
        : disguisedAuthority.honoredWrites.has(disguisedSuccession.id),
      false,
    );

    const boundaryOps = structuredClone(ops);
    const boundaryHeartbeat = boundaryOps.find(
      (op) => op.authority?.type === "heartbeat",
    );
    const boundarySuccession = boundaryOps.find(
      (op) => op.authority?.type === "succeed",
    );
    const boundaryGenesis = boundaryOps.find(
      (op) => op.authority?.type === "genesis",
    );
    const boundaryPolicy =
      boundaryGenesis?.authority?.type === "genesis"
        ? boundaryGenesis.authority.policies?.clerk
        : undefined;

    if (
      boundaryHeartbeat?.authority?.type === "heartbeat" &&
      boundarySuccession?.authority?.type === "succeed" &&
      boundaryGenesis !== undefined &&
      boundarySuccession.authority.proof.mode === "legacy" &&
      boundaryPolicy?.mode === "legacy"
    ) {
      testedBoundaryHeartbeat = true;
      boundaryHeartbeat.kind = "command";
      boundaryHeartbeat.authority.atTick =
        boundarySuccession.authority.proof.atTick - boundaryPolicy.dormantTicks + 1;

      const scrubbedBoundaryOps = structuredClone(boundaryOps);
      const scrubbedHeartbeat = scrubbedBoundaryOps.find(
        (op) => op.id === boundaryHeartbeat.id,
      );
      if (scrubbedHeartbeat !== undefined) delete scrubbedHeartbeat.authority;

      const boundaryById = index(boundaryOps);
      const scrubbedBoundaryById = index(scrubbedBoundaryOps);
      const boundaryAuthority = analyzeAuthority(
        vec.schema,
        boundaryOps,
        new Set(boundaryOps.map((op) => op.id)),
        canonicalOrder(boundaryOps, boundaryById),
        boundaryById,
      );
      const scrubbedBoundaryAuthority = analyzeAuthority(
        vec.schema,
        scrubbedBoundaryOps,
        new Set(scrubbedBoundaryOps.map((op) => op.id)),
        canonicalOrder(scrubbedBoundaryOps, scrubbedBoundaryById),
        scrubbedBoundaryById,
      );

      check(
        "non-authority heartbeat cannot postpone a boundary succession",
        stableComparisonValue(boundaryAuthority),
        stableComparisonValue(scrubbedBoundaryAuthority),
      );

      const localBoundaryOps = structuredClone(ops);
      const localBoundaryHeartbeat = localBoundaryOps.find(
        (op) => op.authority?.type === "heartbeat",
      );
      const localBoundarySuccession = localBoundaryOps.find(
        (op) => op.authority?.type === "succeed",
      );
      if (
        localBoundaryHeartbeat?.authority?.type === "heartbeat" &&
        localBoundarySuccession !== undefined
      ) {
        localBoundaryHeartbeat.authority.atTick =
          boundarySuccession.authority.proof.atTick - boundaryPolicy.dormantTicks + 1;
        const localBoundaryAuthority = authorityFor(
          vec.schema,
          localBoundaryOps,
          boundaryGenesis.replica,
        );
        const foreignHeartbeatOps = structuredClone(localBoundaryOps);
        const foreignHeartbeat = foreignHeartbeatOps.find(
          (op) => op.authority?.type === "heartbeat",
        );
        if (foreignHeartbeat !== undefined) {
          foreignHeartbeat.replica = `${foreignHeartbeat.replica}:sibling`;
        }
        const foreignHeartbeatAuthority = authorityFor(
          vec.schema,
          foreignHeartbeatOps,
          boundaryGenesis.replica,
        );

        check(
          "local boundary heartbeat postpones succession control",
          localBoundaryAuthority.quarantineReasons.get(localBoundarySuccession.id),
          "premature_succession",
        );
        check(
          "foreign outer replica heartbeat cannot postpone succession",
          foreignHeartbeatAuthority.honoredWrites.has(localBoundarySuccession.id),
          true,
        );
        check(
          "foreign outer replica heartbeat reason",
          foreignHeartbeat === undefined
            ? null
            : foreignHeartbeatAuthority.quarantineReasons.get(foreignHeartbeat.id),
          "wrong_replica",
        );
      }
    }
  }

  if (vec.scenario === "township_carrier_w1") {
    checkForeignReplicaEvidence(
      "grant",
      vec.schema,
      ops,
      (op) => op.authority?.type === "grant",
      (analysis, target) => {
        const delegationId =
          target?.authority?.type === "grant" ? target.authority.delegation.id : null;
        return delegationId === null
          ? false
          : analysis.security.delegations.has(delegationId);
      },
    );
  }

  if (vec.scenario === "township_capability_revoked_causal") {
    checkForeignReplicaEvidence(
      "revoke",
      vec.schema,
      ops,
      (op) => op.authority?.type === "revoke",
      (analysis, target) =>
        analysis.security.effectiveRevokes.some((item) => item.opId === target?.id),
    );
  }

  if (vec.scenario === "township_lease_expired") {
    checkForeignReplicaEvidence(
      "beacon",
      vec.schema,
      ops,
      (op) => op.authority?.type === "beacon",
      (analysis, target) =>
        analysis.security.validBeacons.some((item) => item.opId === target?.id),
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
          }).sort(([left], [right]) => compareCodePoints(left, right)),
      recovery === undefined
        ? undefined
        : Object.entries(recovery.claim).sort(([left], [right]) =>
            compareCodePoints(left, right),
          ),
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

check(
  "non-authority evidence coverage includes every authority evidence type",
  [...testedDisguisedEvidenceTypes].sort(),
  ["beacon", "genesis", "grant", "heartbeat", "revoke", "succeed", "transfer"],
);
check("boundary heartbeat mutation coverage executed", testedBoundaryHeartbeat, true);
check(
  "Township command decoder drift coverage executed",
  testedTownshipCommandDrift,
  true,
);
check(
  "Toolshed command decoder drift coverage executed",
  testedToolshedCommandDrift,
  true,
);

console.log("\n▸ carrier authority report is diagnostic only");
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
  const localResult = materialize(schema, [accepted, quarantined]);
  check("omitting a carrier report preserves locally honored state", localResult.state.posts, [
    "accepted",
    "quarantined",
  ]);
  check("omitting a carrier report preserves local quarantine", localResult.quarantine, []);
  check("omitting a carrier report preserves canonical order", localResult.order, [
    accepted.id,
    quarantined.id,
  ]);
  const matchingEmptyReport = materialize(
    schema,
    [accepted, quarantined],
    undefined,
    {
      opIds: new Set([accepted.id, quarantined.id]),
      quarantinedIds: new Set(),
    },
  );
  check(
    "an honest empty carrier report preserves locally honored state",
    matchingEmptyReport.state.posts,
    ["accepted", "quarantined"],
  );

  let divergence: unknown;
  try {
    materialize(
      schema,
      [accepted, quarantined],
      undefined,
      {
        opIds: new Set([accepted.id, quarantined.id]),
        quarantinedIds: new Set([quarantined.id]),
      },
    );
  } catch (error) {
    divergence = error;
  }

  check(
    "carrier report divergence has a stable error class name",
    divergence instanceof Error && divergence.name === "CarrierAuthorityReportDivergenceError",
    true,
  );
  check(
    "carrier report divergence has a stable machine-readable name",
    divergence instanceof Error && divergence.message.includes("carrier_authority_report_divergence"),
    true,
  );
  check(
    "carrier report divergence carries sorted local ids",
    divergence instanceof Error && "localIds" in divergence ? divergence.localIds : null,
    [],
  );
  check(
    "carrier report divergence carries sorted reported ids",
    divergence instanceof Error && "reportedIds" in divergence ? divergence.reportedIds : null,
    [quarantined.id],
  );
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
