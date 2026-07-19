import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  carrierOpsToSemanticOps,
  canonicalOrder,
  decodeCarrierOpFrame,
  deriveWitnessedSuccessionReview,
  frontier,
  index,
} from "../src/index";
import type {
  Op,
  ReplicaSchema,
  WitnessedSuccessionReview,
} from "../src/index";

interface ProjectionVector {
  replica: string;
  schema: ReplicaSchema;
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
  };
}

let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  const actual = JSON.stringify(got);
  const expected = JSON.stringify(want);
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}`);
  if (!ok) {
    console.log(`       got : ${actual}`);
    console.log(`       want: ${expected}`);
  }
}

function reason(result: ReturnType<typeof deriveWitnessedSuccessionReview>): string | null {
  return result.ok ? null : result.reason;
}

function cloneOps(ops: Op[]): Op[] {
  return structuredClone(ops);
}

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(join(here, "vectors", "township_genesis_projection_parity.json"), "utf8"),
) as ProjectionVector;
const projection = vector.genesisProjection;
const ops = carrierOpsToSemanticOps(
  vector.oracleCarrierOps.map(decodeCarrierOpFrame),
  vector.realmByPubkey,
);
const byId = index(ops);
const orderedOps = canonicalOrder(ops, byId).map((id) => byId.get(id)!);
const selector = {
  replica: vector.replica,
  role: projection.role,
  witness: projection.effectivePolicy.witnessPubkeys[0]!,
} as const;

const derived = deriveWitnessedSuccessionReview(vector.schema, ops, selector, null);
const expectedReview: WitnessedSuccessionReview = {
  claim: {
    version: 1,
    replica: vector.replica,
    role: projection.role,
    holder: projection.holderPubkey,
    holderEpoch: projection.holderEpochOperationId,
    successor: projection.effectivePolicy.successorPubkey,
    policyId: projection.policyId,
  },
  policyGenesisOperationId: projection.winningPolicyGenesisOperationId,
  witness: selector.witness,
  threshold: projection.effectivePolicy.threshold,
  verifiedFrontier: frontier(orderedOps),
};

check("public helper has no relay-authority input", deriveWitnessedSuccessionReview.length, 4);
check("BEAM-pinned holder and policy derive the exact review", derived, {
  ok: true,
  review: expectedReview,
});
check(
  "unchanged prior review passes the pre-sign recheck",
  deriveWitnessedSuccessionReview(vector.schema, ops, selector, expectedReview),
  { ok: true, review: expectedReview },
);

const legacyOps = cloneOps(ops);
const legacyGenesis = legacyOps.find(
  (op) => op.id === projection.winningPolicyGenesisOperationId,
)!;
if (legacyGenesis.authority?.type === "genesis") {
  legacyGenesis.authority.policies = {
    clerk: {
      mode: "legacy",
      successorRealm: "successor",
      successor: projection.effectivePolicy.successorPubkey,
      dormantTicks: 10,
    },
  };
}
check(
  "legacy recovery policy fails closed",
  reason(deriveWitnessedSuccessionReview(vector.schema, legacyOps, selector, null)),
  "recovery_policy_unavailable",
);

const malformedPolicyOps = cloneOps(ops);
const malformedGenesis = malformedPolicyOps.find(
  (op) => op.id === projection.winningPolicyGenesisOperationId,
)!;
if (
  malformedGenesis.authority?.type === "genesis" &&
  malformedGenesis.authority.policies?.clerk?.mode === "witnessed"
) {
  malformedGenesis.authority.policies.clerk.recovery.threshold = 0;
}
check(
  "malformed witnessed policy fails closed",
  reason(deriveWitnessedSuccessionReview(vector.schema, malformedPolicyOps, selector, null)),
  "invalid_recovery_policy",
);

check(
  "missing current holder fails closed",
  reason(deriveWitnessedSuccessionReview(vector.schema, [], selector, null)),
  "no_current_holder",
);

const unpinnedSelector = {
  ...selector,
  witness: Buffer.alloc(32, 9).toString("base64"),
};
check(
  "unpinned governance witness fails closed",
  reason(deriveWitnessedSuccessionReview(vector.schema, ops, unpinnedSelector, null)),
  "witness_not_pinned",
);

const staleReview: WitnessedSuccessionReview = {
  ...expectedReview,
  claim: {
    ...expectedReview.claim,
    holderEpoch: projection.acquisitionOperationIds[0]!,
  },
};
check(
  "BEAM vector has a changed holder epoch to detect",
  projection.acquisitionOperationIds[0] === projection.holderEpochOperationId,
  false,
);
check(
  "changed holder epoch fails the pre-sign recheck",
  reason(deriveWitnessedSuccessionReview(vector.schema, ops, selector, staleReview)),
  "stale_verified_state",
);

for (const [name, stale] of [
  [
    "changed successor",
    {
      ...expectedReview,
      claim: {
        ...expectedReview.claim,
        successor: Buffer.alloc(32, 7).toString("base64"),
      },
    },
  ],
  [
    "changed policy id",
    {
      ...expectedReview,
      claim: { ...expectedReview.claim, policyId: "A".repeat(43) },
    },
  ],
  ["changed threshold", { ...expectedReview, threshold: expectedReview.threshold + 1 }],
  ["changed verified frontier", { ...expectedReview, verifiedFrontier: ["stale-frontier"] }],
] satisfies [string, WitnessedSuccessionReview][]) {
  check(
    `${name} fails the pre-sign recheck`,
    reason(deriveWitnessedSuccessionReview(vector.schema, ops, selector, stale)),
    "stale_verified_state",
  );
}

check(
  "paired replica mismatch fails closed",
  reason(
    deriveWitnessedSuccessionReview(
      vector.schema,
      ops,
      { ...selector, replica: `${vector.replica}:other` },
      null,
    ),
  ),
  "replica_mismatch",
);

if (false) {
  const disagreeingRelayReport = {
    holder: "relay-selected-attacker",
    holderEpoch: "relay-selected-epoch",
    policyId: "relay-selected-policy",
  };
  // @ts-expect-error A relay authority report must never enter local claim derivation.
  deriveWitnessedSuccessionReview(vector.schema, ops, selector, null, disagreeingRelayReport);
}

console.log(
  `\n${
    failures === 0
      ? "\x1b[32m✓ witnessed succession review checks passed\x1b[0m"
      : `\x1b[31m✗ ${failures} check(s) failed\x1b[0m`
  }`,
);
process.exit(failures === 0 ? 0 : 1);
