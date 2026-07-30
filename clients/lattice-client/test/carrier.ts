import { readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, createHash, sign as edSign } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  carrierChallenge,
  carrierOpsToSemanticOps,
  carrierTranscriptHex,
  integrate,
  materialize,
  signCarrierChallenge,
  syncCarrierOnce,
  townshipCarrierCommandNames,
  toRequest,
  toSend,
} from "../src/index";
import type {
  CarrierChallenge,
  CarrierOpFrame,
  CarrierPushReport,
  CarrierTerm,
  Op,
  ReplicaSchema,
} from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const vecDir = join(here, "vectors");

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

interface CarrierVector {
  scenario: string;
  replica: string;
  schema: ReplicaSchema;
  realmByPubkey: Record<string, string>;
  client: { realm: string; sessionSeed: string; sessionPubkey: string };
  peer: { realm: string; sessionPubkey: string };
  clientBaseCarrierOps: unknown[];
  clientDivergedCarrierOps: CarrierOpFrame[];
  peerDivergedCarrierOps: unknown[];
  expectAfterSync: {
    state: Record<string, unknown>;
    opIds: string[];
    authorityQuarantine: [string, string][];
  };
}

const vector = JSON.parse(readFileSync(join(vecDir, "township_carrier_w1.json"), "utf8")) as CarrierVector;

interface ForeignReplicaVector {
  scenario: string;
  replica: string;
  schema: ReplicaSchema;
  realmByPubkey: Record<string, string>;
  oracleCarrierOps: unknown[];
  capabilityCase: {
    foreignReplica: string;
    foreignCarrierOp: unknown;
    genuineGenesisOperationId: string;
  };
}

const foreignReplicaVector = JSON.parse(
  readFileSync(join(vecDir, "township_foreign_replica_injection.json"), "utf8"),
) as ForeignReplicaVector;

interface ToolshedVector {
  replica: string;
  schema: ReplicaSchema;
  realmByPubkey: Record<string, string>;
  oracleCarrierOps: CarrierOpFrame[];
  expectAtFullFrontier: {
    winners: { holder: string };
  };
}

const toolshedVector: ToolshedVector = JSON.parse(
  readFileSync(join(vecDir, "toolshed_custody_consent.json"), "utf8"),
);

console.log(`\n▸ ${vector.scenario} carrier vector`);

const identity = seededEd25519Identity(vector.client.sessionSeed);
check("session public key", identity.publicKeyBase64, vector.client.sessionPubkey);

const serverNonce = Buffer.alloc(32, 7).toString("base64url");
const v2Options = { nonce: "fixed-client-nonce", serverNonce };
const v2Challenge = carrierChallenge(vector.client.realm, "replica:matter:township-g1", v2Options) as CarrierChallenge & {
  server_nonce?: string;
  session_version?: number;
};
check("session challenge binds server nonce", v2Challenge.server_nonce, serverNonce);
check("session challenge version", v2Challenge.session_version, 2);
check("operation wire version remains v1", v2Challenge.wire_version, 1);

const challenge = {
  type: "carrier_challenge",
  local_realm: vector.client.realm,
  replica: "replica:matter:township-g1",
  nonce: "fixed-nonce",
  server_nonce: serverNonce,
  wire_version: 1,
  session_version: 2,
} satisfies CarrierChallenge;

check(
  "carrier transcript",
  carrierTranscriptHex(challenge, vector.client.realm, identity.publicKey),
  "8952636172726965722d73657373696f6e2d7632487265736964656e74581a7265706c6963613a6d61747465723a746f776e736869702d67314b66697865642d6e6f6e6365582b427763484277634842776348427763484277634842776348427763484277634842776348427763484277630102487265736964656e74582065ed56fb80e79cae9aa096391a25280d5c99561ab9fcf08bed4c1000b5d440d9",
);

const signed = await signCarrierChallenge(challenge, identity);
check("carrier challenge signature", signed.signature, "l2T5s/NuXIiW9o3siFeSOkaZnpfaRLHb7xqtryKORd/gRuF8jxbEa//emnbxUvlDIZEc6nrMZD75o4wiDDtoDQ==");

const clientBase = carrierOpsToSemanticOps(vector.clientBaseCarrierOps, vector.realmByPubkey);
const clientDiverged = carrierOpsToSemanticOps(vector.clientDivergedCarrierOps, vector.realmByPubkey);
const peerDiverged = carrierOpsToSemanticOps(vector.peerDivergedCarrierOps, vector.realmByPubkey);

check("base op count", clientBase.length, vector.clientBaseCarrierOps.length);
check("client sends two offline ops", toSend(clientDiverged, new Set(peerDiverged.map((o: Op) => o.id))).length, 2);
check("client pulls five peer ops", toRequest(clientDiverged, peerDiverged.map((o: Op) => o.id)).length, 5);

const pulled = peerDiverged.filter((op) => toRequest(clientDiverged, [op.id]).includes(op.id));
const merged = integrate(clientDiverged, pulled);
const materialized = materialize(vector.schema, merged);

for (const [field, want] of Object.entries(vector.expectAfterSync.state)) {
  check(`state.${field}`, materialized.state[field], want);
}

check("merged op ids", merged.map((o) => o.id).sort(), vector.expectAfterSync.opIds);
check(
  "authority quarantine",
  materialized.quarantine.sort(),
  vector.expectAfterSync.authorityQuarantine.map(([id]) => id).sort(),
);

const commandFrame = vector.clientDivergedCarrierOps.find(
  (candidate) => candidate.kind === "command",
);
if (commandFrame === undefined) throw new Error("missing command frame fixture");
const commandFrameFixture = commandFrame;

function commandError(op: Op | undefined): unknown {
  return op === undefined ? undefined : Reflect.get(op, "commandError");
}

function commandFrameNamed(
  name: string,
  args: CarrierTerm[],
  suffix: string,
): CarrierOpFrame {
  return commandFrameWithBody(
    ["tuple", [["atom", name], ["list", args]]],
    suffix,
  );
}

function commandFrameWithBody(
  body: CarrierTerm,
  suffix: string,
): CarrierOpFrame {
  return {
    ...structuredClone(commandFrameFixture),
    id: `${commandFrameFixture.id}-${suffix}`,
    body,
  };
}

const unknownCommandFrame = commandFrameNamed(
  "future_unmapped_command",
  [],
  "unknown",
);
let unknownCommandOps: Op[] = [];
let unknownCommandFailure = "";
try {
  unknownCommandOps = carrierOpsToSemanticOps(
    [unknownCommandFrame, commandFrameFixture],
    vector.realmByPubkey,
  );
} catch (error) {
  unknownCommandFailure =
    error instanceof Error ? error.message : String(error);
}
check(
  "unknown command does not abort the ingest batch",
  unknownCommandFailure,
  "",
);
check(
  "unknown command carries the BEAM-compatible quarantine reason",
  commandError(unknownCommandOps[0]),
  "unknown_command",
);
const unknownCommandOp = unknownCommandOps[0];
if (unknownCommandOp !== undefined) {
  const withUnknown = materialize(
    vector.schema,
    [...clientDiverged, unknownCommandOp],
  );
  const withoutUnknown = materialize(vector.schema, clientDiverged);
  check(
    "unknown command is quarantined without changing valid state",
    {
      quarantined: withUnknown.quarantine.includes(unknownCommandOp.id),
      reason: withUnknown.quarantineReasons.get(unknownCommandOp.id),
      state: withUnknown.state,
    },
    {
      quarantined: true,
      reason: "unknown_command",
      state: withoutUnknown.state,
    },
  );
}

const prototypeCommandOps: Op[] = [];
const prototypeCommandFailures: string[] = [];
for (const name of ["constructor", "toString", "__proto__", "valueOf"]) {
  try {
    const [op] = carrierOpsToSemanticOps(
      [commandFrameNamed(name, [], `prototype-${name}`)],
      vector.realmByPubkey,
    );
    if (op !== undefined) prototypeCommandOps.push(op);
  } catch (error) {
    prototypeCommandFailures.push(
      error instanceof Error ? error.message : String(error),
    );
  }
}
check(
  "prototype command names cannot bypass fail-closed decode",
  {
    failures: prototypeCommandFailures,
    reasons: prototypeCommandOps.map(commandError),
  },
  {
    failures: [],
    reasons: [
      "unknown_command",
      "unknown_command",
      "unknown_command",
      "unknown_command",
    ],
  },
);

const badLinkArityOps = [
  commandFrameNamed("link_election", [], "link-no-args"),
  commandFrameNamed("link_election", [["nil"], ["nil"]], "link-extra-arg"),
].flatMap((frame) =>
  carrierOpsToSemanticOps([frame], vector.realmByPubkey),
);
check(
  "link_election rejects every non-DSL arity",
  badLinkArityOps.map(commandError),
  ["bad_command_arity", "bad_command_arity"],
);

const malformedCommandFrames = [
  commandFrameWithBody(["bin", Buffer.from("post").toString("base64")], "body-not-tuple"),
  commandFrameWithBody(
    ["tuple", [["atom", "post"], ["atom", "not_a_list"]]],
    "args-not-list",
  ),
];
let malformedCommandOps: Op[] = [];
let malformedCommandFailure = "";
try {
  malformedCommandOps = carrierOpsToSemanticOps(
    malformedCommandFrames,
    vector.realmByPubkey,
  );
} catch (error) {
  malformedCommandFailure =
    error instanceof Error ? error.message : String(error);
}
check(
  "malformed command shapes do not abort the ingest batch",
  {
    failure: malformedCommandFailure,
    reasons: malformedCommandOps.map(commandError),
  },
  {
    failure: "",
    reasons: ["malformed_command", "malformed_command"],
  },
);

const nonAtomCommandFrames = [
  commandFrameWithBody(
    ["tuple", [["int", 42], ["list", []]]],
    "integer-command-name",
  ),
  commandFrameWithBody(
    [
      "tuple",
      [
        ["bin", Buffer.from("post").toString("base64")],
        ["list", []],
      ],
    ],
    "binary-command-name",
  ),
];
let nonAtomCommandOps: Op[] = [];
let nonAtomCommandFailure = "";
try {
  nonAtomCommandOps = carrierOpsToSemanticOps(
    nonAtomCommandFrames,
    vector.realmByPubkey,
  );
} catch (error) {
  nonAtomCommandFailure =
    error instanceof Error ? error.message : String(error);
}
check(
  "non-atom command names quarantine without aborting ingest",
  {
    failure: nonAtomCommandFailure,
    reasons: nonAtomCommandOps.map(commandError),
  },
  {
    failure: "",
    reasons: ["unknown_command", "unknown_command"],
  },
);

let scalarPost: Op | undefined;
let scalarPostFailure = "";
try {
  [scalarPost] = carrierOpsToSemanticOps(
    [commandFrameNamed("post", [["int", 42]], "integer-post")],
    vector.realmByPubkey,
  );
} catch (error) {
  scalarPostFailure = error instanceof Error ? error.message : String(error);
}
check(
  "BEAM-accepted scalar command arguments remain ingestible",
  {
    failure: scalarPostFailure,
    reason: commandError(scalarPost),
    value: scalarPost?.value,
  },
  { failure: "", value: 42 },
);

const inheritedRealmFrame: CarrierOpFrame = {
  ...structuredClone(commandFrameFixture),
  id: `${commandFrameFixture.id}-inherited-realm`,
  author: "toString",
};
const [inheritedRealmOp] = carrierOpsToSemanticOps([inheritedRealmFrame], {});
check(
  "inherited realm-map keys cannot replace an unmapped pubkey",
  inheritedRealmOp?.author,
  "toString",
);

const malformedTermFrames: unknown[] = [
  ["list", 0],
  ["tuple", 5],
  ["map", [7]],
  ["bin", 5],
].map((body, index) => {
  const frame: object = structuredClone(commandFrameFixture);
  Reflect.set(frame, "id", `${commandFrameFixture.id}-malformed-term-${index}`);
  Reflect.set(frame, "body", body);
  return frame;
});
const malformedCapFrame: object = structuredClone(commandFrameFixture);
Reflect.set(
  malformedCapFrame,
  "id",
  `${commandFrameFixture.id}-malformed-cap`,
);
Reflect.set(malformedCapFrame, "cap", ["zzz", 1]);
malformedTermFrames.push(malformedCapFrame);
const malformedAtomFrame: object = structuredClone(commandFrameFixture);
Reflect.set(
  malformedAtomFrame,
  "id",
  `${commandFrameFixture.id}-malformed-atom`,
);
Reflect.set(malformedAtomFrame, "body", [
  "tuple",
  [["atom", 5], ["list", []]],
]);
malformedTermFrames.push(malformedAtomFrame);

let malformedTermOps: Op[] = [];
let malformedTermFailure = "";
try {
  malformedTermOps = carrierOpsToSemanticOps(
    malformedTermFrames,
    vector.realmByPubkey,
  );
} catch (error) {
  malformedTermFailure =
    error instanceof Error ? error.message : String(error);
}
check(
  "malformed raw command terms cannot wedge direct ingest",
  {
    failure: malformedTermFailure,
    reasons: malformedTermOps.map(commandError),
  },
  {
    failure: "",
    reasons: Array.from({ length: malformedTermFrames.length }, () =>
      "malformed_command"
    ),
  },
);

const validCustodyFrame = toolshedVector.oracleCarrierOps.find(
  (frame) => frame.id === toolshedVector.expectAtFullFrontier.winners.holder,
);
if (validCustodyFrame === undefined) {
  throw new Error("missing honored custody transfer fixture");
}
const invalidCustodyFrame: CarrierOpFrame = {
  ...structuredClone(validCustodyFrame),
  body: [
    "tuple",
    [
      ["atom", "custody_transfer"],
      [
        "list",
        [
          ["int", 42],
          ["bin", Buffer.from("missing-request").toString("base64")],
          ["bin", Buffer.alloc(64).toString("base64")],
        ],
      ],
    ],
  ],
};
const invalidCustodyFrames = toolshedVector.oracleCarrierOps.map((frame) =>
  frame.id === invalidCustodyFrame.id ? invalidCustodyFrame : frame
);
const invalidCustodyOps = carrierOpsToSemanticOps(
  invalidCustodyFrames,
  toolshedVector.realmByPubkey,
);
const invalidCustody = materialize(
  toolshedVector.schema,
  invalidCustodyOps,
  undefined,
  new Set(),
  toolshedVector.replica,
);
check(
  "ill-typed custody recipient reaches consent validation",
  {
    decodeReason: commandError(
      invalidCustodyOps.find((op) => op.id === invalidCustodyFrame.id),
    ),
    quarantineReason: invalidCustody.quarantineReasons.get(
      invalidCustodyFrame.id,
    ),
  },
  { quarantineReason: "invalid_consent" },
);

const noCapabilityCustodyFrame: CarrierOpFrame = {
  ...invalidCustodyFrame,
  cap: ["nil"],
};
const noCapabilityCustodyOps = carrierOpsToSemanticOps(
  toolshedVector.oracleCarrierOps.map((frame) =>
    frame.id === noCapabilityCustodyFrame.id
      ? noCapabilityCustodyFrame
      : frame
  ),
  toolshedVector.realmByPubkey,
);
const noCapabilityCustody = materialize(
  toolshedVector.schema,
  noCapabilityCustodyOps,
  undefined,
  new Set(),
  toolshedVector.replica,
);
check(
  "ill-typed custody recipient preserves capability reason precedence",
  noCapabilityCustody.quarantineReasons.get(noCapabilityCustodyFrame.id),
  "no_capability",
);
check(
  "Township decoder table includes link_election",
  townshipCarrierCommandNames().includes("link_election"),
  true,
);

console.log(`\n▸ ${foreignReplicaVector.scenario} carrier ingest`);

const emptyPushReport = (): CarrierPushReport => ({
  accepted: [],
  quarantined: [],
  rejected: [],
  pending: [],
});
const foreignPeer = {
  async advertise(): Promise<string[]> {
    return [];
  },
  async pull(): Promise<unknown[]> {
    return [
      foreignReplicaVector.capabilityCase.foreignCarrierOp,
      ...foreignReplicaVector.oracleCarrierOps,
    ];
  },
  async push(): Promise<CarrierPushReport> {
    return emptyPushReport();
  },
};
const foreignSyncOptions = {
  verifier: {
    async verify(): Promise<boolean> {
      throw new Error("foreign replica frame reached signature verification");
    },
  },
  expectedReplica: foreignReplicaVector.replica,
};
const legitimateOps = carrierOpsToSemanticOps(
  foreignReplicaVector.oracleCarrierOps,
  foreignReplicaVector.realmByPubkey,
);
const legitimateMaterialized = materialize(foreignReplicaVector.schema, legitimateOps);
let foreignReplicaFailure = "";
try {
  await syncCarrierOnce(
    foreignPeer,
    [],
    [],
    foreignReplicaVector.realmByPubkey,
    foreignSyncOptions,
  );
} catch (error) {
  foreignReplicaFailure = error instanceof Error ? error.message : String(error);
}

check(
  "foreign replica frame hard-fails before semantic ingest",
  foreignReplicaFailure,
  `carrier served foreign replica ${foreignReplicaVector.capabilityCase.foreignReplica}; expected ${foreignReplicaVector.replica}`,
);

const foreignOp = carrierOpsToSemanticOps(
  [foreignReplicaVector.capabilityCase.foreignCarrierOp],
  foreignReplicaVector.realmByPubkey,
);
const explicitlyAnchored = materialize(
  foreignReplicaVector.schema,
  [...legitimateOps, ...foreignOp],
  undefined,
  new Set(),
  foreignReplicaVector.replica,
);
check(
  "explicit replica anchor ignores a foreign root claim",
  explicitlyAnchored.state,
  legitimateMaterialized.state,
);
check(
  "explicit replica anchor preserves legitimate quarantine",
  explicitlyAnchored.quarantine
    .filter((id) => id !== foreignOp[0]?.id)
    .sort(),
  [...legitimateMaterialized.quarantine].sort(),
);
check(
  "explicit replica anchor quarantines the foreign root claim",
  explicitlyAnchored.quarantine.includes(foreignOp[0]?.id ?? ""),
  true,
);
check(
  "foreign frame remains foreign under semantic decode",
  foreignOp[0]?.replica === foreignReplicaVector.replica,
  false,
);

console.log(`\n${failures === 0 ? "\x1b[32m✓ carrier checks passed\x1b[0m" : `\x1b[31m✗ ${failures} check(s) failed\x1b[0m`}`);
process.exit(failures === 0 ? 0 : 1);

function seededEd25519Identity(seed: string) {
  const privateSeed = createHash("sha256").update(seed).digest();
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const privateKey = createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, privateSeed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyDer = (createPublicKey as (key: unknown) => ReturnType<typeof createPublicKey>)(privateKey).export({
    format: "der",
    type: "spki",
  });
  const publicKey = new Uint8Array(Buffer.from(publicKeyDer).subarray(spkiPrefix.length));

  return {
    publicKey,
    publicKeyBase64: Buffer.from(publicKey).toString("base64"),
    sign(bytes: Uint8Array): Uint8Array {
      return new Uint8Array(edSign(null, Buffer.from(bytes), privateKey));
    },
  };
}
