import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  authorCarrierOp,
  frontier,
  materialize,
  decodeCarrierOpFrame,
  authorAndPersistTownshipCommand,
  authorAndPersistTownshipDelegation,
  canonicalBytesForCarrierDelegation,
  canonicalBytesForCarrierOp,
  canonicalBytesForWitnessedBeaconClaim,
  authorCarrierDelegation,
  authorTownshipGenesis,
  authorTownshipDelegation,
  authorTownshipCommand,
  authorTownshipCommandFromLog,
  authorTownshipRevocation,
  bindTownshipReplica,
  carrierDelegationsFromFrames,
  carrierOpsToSemanticOps,
  createJsonCarrierFrameStore,
  createJsonLocalOpLogStore,
  selectTownshipCapId,
  townshipCapTerm,
  townshipCommandBody,
  townshipRevokeBody,
} from "../src/index";
import type { CarrierOpFrame, CarrierTerm, ReplicaSchema, WitnessedBeaconClaimEvidence } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(join(here, "vectors", "township_carrier_w1.json"), "utf8"),
) as TownshipCarrierVector;

let failures = 0;

function check(name: string, got: unknown, want: unknown) {
  const ok = isDeepStrictEqual(got, want);
  if (!ok) failures++;
  const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag} ${name}`);
  if (!ok) {
    console.log(`       got : ${JSON.stringify(got)}`);
    console.log(`       want: ${JSON.stringify(want)}`);
  }
}

interface TownshipCarrierVector {
  scenario: string;
  replica: string;
  realmByPubkey: Record<string, string>;
  client: { realm: string; sessionSeed: string };
  clientBaseCarrierOps: CarrierOpFrame[];
  clientDivergedCarrierOps: CarrierOpFrame[];
  authorityRevocation: {
    delegationId: string;
    preRevokeCommandId: string;
    revokeOp: CarrierOpFrame;
    revokedCommandOp: CarrierOpFrame;
    authorityQuarantine: [string, string][];
    stateB64: string;
    opIds: string[];
  };
  authorityBadRevocation: {
    delegationId: string;
    revokeOp: CarrierOpFrame;
    postRevokeCommandOp: CarrierOpFrame;
    authorityQuarantine: [string, string][];
    stateB64: string;
    opIds: string[];
  };
}

class MemoryKeyValueStore {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

console.log(`\n▸ ${vector.scenario} Township command authoring`);

for (const rootKey of [
  `${vector.clientBaseCarrierOps[0]!.author}\n`,
  vector.clientBaseCarrierOps[0]!.author.replace(/=+$/, ""),
  Buffer.alloc(31, 1).toString("base64"),
  new Uint8Array(33),
]) {
  let refused = false;
  try {
    await bindTownshipReplica("replica:matter:strict-root", rootKey);
  } catch {
    refused = true;
  }
  check("replica binding refuses non-canonical or incorrectly sized root keys", refused, true);
}

check("set_title body", townshipCommandBody({ command: "set_title", text: "Road diet" }), commandBody("set_title", "Road diet"));
check(
  "set_summary body",
  townshipCommandBody({ command: "set_summary", text: "Needs traffic study" }),
  commandBody("set_summary", "Needs traffic study"),
);
check("post body", townshipCommandBody({ command: "post", text: "resident: posted while offline" }), commandBody("post", "resident: posted while offline"));
check("admit body", townshipCommandBody({ command: "admit", member: "resident" }), commandBody("admit", "resident"));
check(
  "remove_member body",
  townshipCommandBody({ command: "remove_member", member: "resident" }),
  commandBody("remove_member", "resident"),
);
check("close_matter body", townshipCommandBody({ command: "close_matter" }), commandBody("close_matter"));
check("reopen_matter body", townshipCommandBody({ command: "reopen_matter" }), commandBody("reopen_matter"));

const residentAuthor = seededEd25519Identity(`${vector.client.sessionSeed}:${vector.client.realm}`);
const clerkAuthor = seededEd25519Identity(`${vector.client.sessionSeed}:clerk`);
const evilAuthor = seededEd25519Identity(`${vector.client.sessionSeed}:evil`);
const delegations = carrierDelegationsFromFrames(vector.clientDivergedCarrierOps);

const genesisFixture = vector.clientBaseCarrierOps.find((frame) => authorityCommandName(frame) === "genesis");
if (!genesisFixture) throw new Error("missing genesis fixture frame");
const genesisDelegation = carrierDelegationsFromFrames([genesisFixture])[0];
if (!genesisDelegation) throw new Error("missing genesis fixture delegation");
const unboundReplica = genesisFixture.replica.split("#root:")[0]!;
check("bound Township replica id", await bindTownshipReplica(unboundReplica, clerkAuthor.publicKey), genesisFixture.replica);

const authoredGenesis = await authorTownshipGenesis({
  replica: unboundReplica,
  ops: genesisDelegation.ops,
  roles: genesisDelegation.roles,
  live: genesisDelegation.live,
  policies: {
    clerk: {
      successorPubkey: residentAuthor.publicKey,
      dormantTicks: 3,
    },
  },
  signer: clerkAuthor,
});
check("authored root-bound genesis frame", authoredGenesis, genesisFixture);

const forgedGenesis = await authorTownshipGenesis({
  replica: genesisFixture.replica,
  ops: ["post"],
  roles: ["clerk"],
  live: true,
  signer: evilAuthor,
});
const forgedDelegation = carrierDelegationsFromFrames([forgedGenesis])[0];
if (!forgedDelegation) throw new Error("missing forged genesis delegation");
check("forged genesis keeps honest root-bound replica", forgedGenesis.replica, genesisFixture.replica);
check("forged genesis is self-issued", forgedDelegation.issuer, forgedDelegation.audience);
check("forged genesis root differs from bound root", forgedDelegation.audience === genesisDelegation.audience, false);

const grantFixture = vector.clientDivergedCarrierOps.find((frame) => authorityCommandName(frame) === "grant");
if (!grantFixture) throw new Error("missing resident grant fixture frame");
const grantDelegation = carrierDelegationsFromFrames([grantFixture])[0];
if (!grantDelegation) throw new Error("missing resident grant fixture delegation");
const capId = grantDelegation.id;

check("delegation cap term", townshipCapTerm(capId), ["bin", textBase64(capId)]);
check("missing cap term", townshipCapTerm(null), ["nil"]);
check("carrier delegation ids from frames", delegations.map((delegation) => delegation.id), [
  genesisDelegation.id,
  grantDelegation.id,
]);

const authoredResidentDelegation = await authorCarrierDelegation({
  replica: grantDelegation.replica,
  audiencePubkey: residentAuthor.publicKey,
  parentId: grantDelegation.parent_id,
  ops: grantDelegation.ops,
  roles: grantDelegation.roles,
  live: grantDelegation.live,
  signer: clerkAuthor,
});
check("authored resident delegation", authoredResidentDelegation, grantDelegation);

const authoredResidentGrant = await authorTownshipDelegation({
  replica: grantFixture.replica,
  deps: grantFixture.deps,
  audiencePubkey: residentAuthor.publicKey,
  parentId: grantDelegation.parent_id,
  ops: grantDelegation.ops,
  roles: grantDelegation.roles,
  live: grantDelegation.live,
  signer: clerkAuthor,
});
check("authored resident grant frame", authoredResidentGrant, grantFixture);

check(
  "resident post cap id",
  selectTownshipCapId({ command: "post", text: "resident: posted while offline" }, delegations, residentAuthor.publicKeyBase64),
  capId,
);
check(
  "resident close_matter cap id",
  selectTownshipCapId({ command: "close_matter" }, delegations, residentAuthor.publicKeyBase64),
  null,
);
check(
  "clerk close_matter cap id",
  selectTownshipCapId({ command: "close_matter" }, delegations, clerkAuthor.publicKeyBase64),
  genesisDelegation.id,
);

const residentPostCommand = { command: "post", text: "resident: posted while offline" } as const;
const postFixture = vector.clientDivergedCarrierOps.find(
  (frame) =>
    frame.kind === "command" &&
    frame.author === residentAuthor.publicKeyBase64 &&
    isDeepStrictEqual(frame.body, townshipCommandBody(residentPostCommand)),
);
if (!postFixture) throw new Error("missing resident post fixture frame");
const issuedResidentPostCapId = selectTownshipCapId(
  residentPostCommand,
  carrierDelegationsFromFrames([authoredResidentGrant]),
  residentAuthor.publicKeyBase64,
);
check("issued resident post cap id", issuedResidentPostCapId, capId);

const authoredPostWithIssuedCap = await authorTownshipCommand({
  replica: postFixture.replica,
  deps: postFixture.deps,
  command: residentPostCommand,
  capId: issuedResidentPostCapId,
  signer: residentAuthor,
});
check("authored resident post frame with issued cap", authoredPostWithIssuedCap, postFixture);

const authoredPostFrame = await authorTownshipCommand({
  replica: postFixture.replica,
  deps: postFixture.deps,
  command: residentPostCommand,
  capId,
  signer: residentAuthor,
});
check("authored resident post frame", authoredPostFrame, postFixture);

const localOpsBeforePost = carrierOpsToSemanticOps(
  vector.clientDivergedCarrierOps.filter((frame) => frame.id !== postFixture.id),
  vector.realmByPubkey,
);
const authoredPostFrameFromLog = await authorTownshipCommandFromLog({
  replica: postFixture.replica,
  localOps: localOpsBeforePost,
  command: residentPostCommand,
  capId,
  signer: residentAuthor,
});
check("authored resident post frame from local log", authoredPostFrameFromLog, postFixture);

check(
  "revoke body",
  townshipRevokeBody(vector.authorityRevocation.delegationId),
  vector.authorityRevocation.revokeOp.body,
);
check("revocation delegates target resident grant", vector.authorityRevocation.delegationId, capId);
check(
  "pre-revoke command stays authorized",
  vector.authorityRevocation.preRevokeCommandId,
  postFixture.id,
);

const authoredRevokeFrame = await authorTownshipRevocation({
  replica: vector.authorityRevocation.revokeOp.replica,
  deps: vector.authorityRevocation.revokeOp.deps,
  delegationId: vector.authorityRevocation.delegationId,
  signer: clerkAuthor,
});
check("authored revocation frame", authoredRevokeFrame, vector.authorityRevocation.revokeOp);

const [authoredRevokeOp] = carrierOpsToSemanticOps([authoredRevokeFrame], vector.realmByPubkey);
if (!authoredRevokeOp) throw new Error("authored revocation did not decode to a semantic op");
check("authored revocation semantic command", authoredRevokeOp.command, `revoke ${vector.authorityRevocation.delegationId}`);

const revokedResidentPostCommand = { command: "post", text: "resident: attempted after revocation" } as const;
const authoredRevokedPostFrame = await authorTownshipCommand({
  replica: vector.authorityRevocation.revokedCommandOp.replica,
  deps: vector.authorityRevocation.revokedCommandOp.deps,
  command: revokedResidentPostCommand,
  capId: vector.authorityRevocation.delegationId,
  signer: residentAuthor,
});
check("authored revoked-cap post frame", authoredRevokedPostFrame, vector.authorityRevocation.revokedCommandOp);
check(
  "revoked-cap post authority quarantine member",
  vector.authorityRevocation.authorityQuarantine.some(
    ([id, reason]) => id === authoredRevokedPostFrame.id && reason === "revoked_capability",
  ),
  true,
);

check(
  "bad revoke body",
  townshipRevokeBody(vector.authorityBadRevocation.delegationId),
  vector.authorityBadRevocation.revokeOp.body,
);
check("bad revocation targets resident grant", vector.authorityBadRevocation.delegationId, capId);

const authoredBadRevokeFrame = await authorTownshipRevocation({
  replica: vector.authorityBadRevocation.revokeOp.replica,
  deps: vector.authorityBadRevocation.revokeOp.deps,
  delegationId: vector.authorityBadRevocation.delegationId,
  signer: residentAuthor,
});
check("authored bad revocation frame", authoredBadRevokeFrame, vector.authorityBadRevocation.revokeOp);

const [authoredBadRevokeOp] = carrierOpsToSemanticOps([authoredBadRevokeFrame], vector.realmByPubkey);
if (!authoredBadRevokeOp) throw new Error("authored bad revocation did not decode to a semantic op");
check("authored bad revocation semantic command", authoredBadRevokeOp.command, `revoke ${vector.authorityBadRevocation.delegationId}`);

const postAfterBadRevokeCommand = { command: "post", text: "resident: post after unauthorized revoke" } as const;
const authoredPostAfterBadRevokeFrame = await authorTownshipCommand({
  replica: vector.authorityBadRevocation.postRevokeCommandOp.replica,
  deps: vector.authorityBadRevocation.postRevokeCommandOp.deps,
  command: postAfterBadRevokeCommand,
  capId: vector.authorityBadRevocation.delegationId,
  signer: residentAuthor,
});
check(
  "authored post after bad revoke frame",
  authoredPostAfterBadRevokeFrame,
  vector.authorityBadRevocation.postRevokeCommandOp,
);
check(
  "bad revoke authority quarantine member",
  vector.authorityBadRevocation.authorityQuarantine.some(
    ([id, reason]) => id === authoredBadRevokeFrame.id && reason === "unauthorized_revoke",
  ),
  true,
);
check(
  "post after bad revoke stays authorized",
  vector.authorityBadRevocation.authorityQuarantine.some(([id]) => id === authoredPostAfterBadRevokeFrame.id),
  false,
);

const persistedStore = createJsonLocalOpLogStore(new MemoryKeyValueStore(), "township:resident");
await persistedStore.save(localOpsBeforePost);
check("persisted local log roundtrip", await persistedStore.load(), localOpsBeforePost);

const authoredPostFrameFromPersistedLog = await authorTownshipCommandFromLog({
  replica: postFixture.replica,
  localOps: await persistedStore.load(),
  command: residentPostCommand,
  capId,
  signer: residentAuthor,
});
check("authored resident post frame from persisted local log", authoredPostFrameFromPersistedLog, postFixture);

const carrierFrameStore = createJsonCarrierFrameStore(new MemoryKeyValueStore(), "township:resident:frames");
await carrierFrameStore.save(vector.clientDivergedCarrierOps.filter((frame) => frame.id !== postFixture.id));
await carrierFrameStore.append(authoredPostFrameFromPersistedLog);
await carrierFrameStore.append(authoredPostFrameFromPersistedLog);
check("persisted carrier frame outbox is idempotent", await carrierFrameStore.load(), vector.clientDivergedCarrierOps);

const workflowLocalLog = createJsonLocalOpLogStore(new MemoryKeyValueStore(), "township:workflow:ops");
await workflowLocalLog.save(localOpsBeforePost);
const workflowFrameStore = createJsonCarrierFrameStore(new MemoryKeyValueStore(), "township:workflow:frames");
await workflowFrameStore.save(vector.clientDivergedCarrierOps.filter((frame) => frame.id !== postFixture.id));
const workflowPost = await authorAndPersistTownshipCommand({
  replica: postFixture.replica,
  command: residentPostCommand,
  signer: residentAuthor,
  localLog: workflowLocalLog,
  carrierFrames: workflowFrameStore,
  realmByPubkey: vector.realmByPubkey,
});
check("author-and-persist cap id", workflowPost.capId, capId);
check("author-and-persist frame", workflowPost.frame, postFixture);
check("author-and-persist op id", workflowPost.op.id, postFixture.id);
check("author-and-persist local log ids", (await workflowLocalLog.load()).map((op) => op.id), vector.clientDivergedCarrierOps.map((frame) => frame.id));
check("author-and-persist frame outbox", await workflowFrameStore.load(), vector.clientDivergedCarrierOps);

let rejectedMissingCap = false;
try {
  await authorAndPersistTownshipCommand({
    replica: postFixture.replica,
    command: { command: "close_matter" },
    signer: residentAuthor,
    localLog: workflowLocalLog,
    carrierFrames: workflowFrameStore,
    realmByPubkey: vector.realmByPubkey,
  });
} catch (error) {
  rejectedMissingCap = error instanceof Error && error.message === "no local delegation authorizes close_matter";
}
check("author-and-persist rejects missing cap", rejectedMissingCap, true);

await persistedStore.append(carrierOpsToSemanticOps([postFixture], vector.realmByPubkey)[0]!);
await persistedStore.append(carrierOpsToSemanticOps([postFixture], vector.realmByPubkey)[0]!);
check("persisted local log append is idempotent", (await persistedStore.load()).map((op) => op.id), vector.clientDivergedCarrierOps.map((frame) => frame.id));

// Plan 179: authoring must reproduce BEAM bytes, not merely replay its frames.
const beaconVector = JSON.parse(
  readFileSync(
    join(here, "vectors", "township_beacon_witnessed_advance.json"),
    "utf8",
  ),
) as {
  schema: ReplicaSchema;
  replica: string;
  realmByPubkey: Record<string, string>;
  oracleCarrierOps: CarrierOpFrame[];
  capabilityCase: {
    founderSeed: string;
    genesisOperationId: string;
    beaconOperationId: string;
    claimPreimageHex: string;
    genesisCanonicalHex: string;
  };
};
const beaconFounder = seededEd25519Identity(
  beaconVector.capabilityCase.founderSeed,
);
const beaconGenesis = beaconVector.oracleCarrierOps.find(
  (frame) => frame.id === beaconVector.capabilityCase.genesisOperationId,
)!;
const beaconGenesisDelegation = carrierDelegationsFromFrames([
  beaconGenesis,
])[0]!;
const witnessKeys = ["w0", "w1", "w2", "w3"].map(
  (realm) =>
    Object.entries(beaconVector.realmByPubkey).find(
      ([, value]) => value === realm,
    )![0],
);
const authoredBeaconGenesis = await authorTownshipGenesis({
  replica: beaconVector.replica,
  ops: beaconGenesisDelegation.ops,
  roles: beaconGenesisDelegation.roles,
  live: beaconGenesisDelegation.live,
  signer: beaconFounder,
  policies: {
    __beacon__: {
      mode: "witnessed",
      version: 1,
      witnesses: witnessKeys,
      threshold: 2,
      maxEpochStep: 10,
    },
  },
});
check(
  "beacon policy genesis canonical bytes equal BEAM",
  Buffer.from(canonicalBytesForCarrierOp(authoredBeaconGenesis)).toString(
    "hex",
  ),
  beaconVector.capabilityCase.genesisCanonicalHex,
);
check(
  "beacon policy genesis id and signature equal BEAM",
  [authoredBeaconGenesis.id, authoredBeaconGenesis.sig],
  [beaconGenesis.id, beaconGenesis.sig],
);
const beaconOp = carrierOpsToSemanticOps(
  beaconVector.oracleCarrierOps,
  beaconVector.realmByPubkey,
).find((op) => op.id === beaconVector.capabilityCase.beaconOperationId)!;
if (beaconOp.authority?.type !== "beacon" || !beaconOp.authority.certificate)
  throw new Error("missing beacon claim");
check(
  "witnessed beacon claim preimage equals BEAM",
  Buffer.from(
    canonicalBytesForWitnessedBeaconClaim(beaconOp.authority.certificate.claim),
  ).toString("hex"),
  beaconVector.capabilityCase.claimPreimageHex,
);
const leasedFrame = beaconVector.oracleCarrierOps.find(
  (frame) => authorityCommandName(frame) === "grant",
)!;
const leasedDelegation = carrierDelegationsFromFrames([leasedFrame])[0]!;
const authoredLeased = await authorCarrierDelegation({
  replica: leasedDelegation.replica,
  audiencePubkey: leasedDelegation.audience,
  parentId: leasedDelegation.parent_id,
  ops: leasedDelegation.ops,
  roles: leasedDelegation.roles,
  live: leasedDelegation.live,
  expiresEpoch: 3,
  signer: beaconFounder,
});
check(
  "leased authoring preserves the v3 epoch",
  authoredLeased.expires_epoch,
  3,
);
check(
  "leased authoring canonical bytes equal BEAM",
  Buffer.from(canonicalBytesForCarrierDelegation(authoredLeased)).toString(
    "hex",
  ),
  Buffer.from(canonicalBytesForCarrierDelegation(leasedDelegation)).toString(
    "hex",
  ),
);
check(
  "leased authoring id and signature equal BEAM",
  [authoredLeased.id, authoredLeased.sig],
  [leasedDelegation.id, leasedDelegation.sig],
);
const leaseStorage = new MemoryKeyValueStore();
const leaseLocalLog = createJsonLocalOpLogStore(leaseStorage, "lease-local");
const leaseFrames = createJsonCarrierFrameStore(leaseStorage, "lease-frames");
await leaseFrames.save([beaconGenesis]);
await leaseLocalLog.save(
  carrierOpsToSemanticOps([beaconGenesis], beaconVector.realmByPubkey),
);
const persistedLease = await authorAndPersistTownshipDelegation({
  replica: beaconVector.replica,
  audiencePubkey: leasedDelegation.audience,
  parentId: leasedDelegation.parent_id,
  ops: leasedDelegation.ops,
  roles: leasedDelegation.roles,
  live: leasedDelegation.live,
  expiresEpoch: 3,
  signer: beaconFounder,
  localLog: leaseLocalLog,
  carrierFrames: leaseFrames,
  realmByPubkey: beaconVector.realmByPubkey,
});
const restoredLease = carrierDelegationsFromFrames(
  await createJsonCarrierFrameStore(leaseStorage, "lease-frames").load(),
).find((delegation) => delegation.id === persistedLease.delegation.id);
check(
  "leased authoring persistence retains expiresEpoch",
  restoredLease?.expires_epoch,
  3,
);
check(
  "omitted lease preserves existing unleased bytes and signature",
  authoredResidentDelegation,
  grantDelegation,
);

// Hosted R03: automatic parent selection must cover the requested lease.
const leaseIssuer = seededEd25519Identity("township:beacon:resident");
const longerParent = await authorTownshipDelegation({ replica: beaconVector.replica,
  deps: [leasedFrame.id], audiencePubkey: leaseIssuer.publicKey, parentId: leasedDelegation.parent_id,
  ops: ["post"], expiresEpoch: 9, signer: beaconFounder });
const longerDelegation = carrierDelegationsFromFrames([longerParent])[0]!;
async function reviewLeaseStores(frames: CarrierOpFrame[]) {
  const storage = new MemoryKeyValueStore();
  const localLog = createJsonLocalOpLogStore(storage, "local");
  const carrierFrames = createJsonCarrierFrameStore(storage, "frames");
  await localLog.save(carrierOpsToSemanticOps(frames, beaconVector.realmByPubkey));
  await carrierFrames.save(frames);
  return { localLog, carrierFrames };
}
const parentFrames = [beaconGenesis, leasedFrame, longerParent];
const parentStores = await reviewLeaseStores(parentFrames);
const selectedLease = await authorAndPersistTownshipDelegation({ replica: beaconVector.replica,
  audiencePubkey: witnessKeys[0]!, ops: ["post"], expiresEpoch: 8, signer: leaseIssuer,
  ...parentStores, realmByPubkey: beaconVector.realmByPubkey });
check("automatic lease parent skips an earlier inadequate lease", selectedLease.parentId, longerDelegation.id);
check("automatically selected lease remains semantically valid", materialize(beaconVector.schema,
  await parentStores.localLog.load()).quarantine.includes(selectedLease.op.id), false);
for (const expiry of [4, undefined]) {
  const stores = await reviewLeaseStores([beaconGenesis, leasedFrame]);
  let refused = false;
  try {
    await authorAndPersistTownshipDelegation({ replica: beaconVector.replica,
      audiencePubkey: witnessKeys[0]!, ops: ["post"], signer: leaseIssuer,
      ...(expiry === undefined ? {} : { expiresEpoch: expiry }), ...stores });
  } catch (error) { refused = error instanceof Error && error.message === "no local delegation authorizes grant"; }
  check("automatic selection refuses uncovered or unbounded child lease", refused, true);
  check("missing suitable lease parent appends no frame", isDeepStrictEqual(await stores.carrierFrames.load(), [beaconGenesis, leasedFrame]), true);
}
const explicitStores = await reviewLeaseStores([beaconGenesis, leasedFrame]);
const explicitLease = await authorAndPersistTownshipDelegation({ replica: beaconVector.replica,
  audiencePubkey: witnessKeys[0]!, ops: ["post"], expiresEpoch: 8, parentId: leasedDelegation.id,
  signer: leaseIssuer, ...explicitStores, realmByPubkey: beaconVector.realmByPubkey });
check("explicit inadequate parent still reaches the existing judge refusal", materialize(beaconVector.schema,
  await explicitStores.localLog.load()).quarantineReasons.get(explicitLease.op.id), "not_attenuated");

// A two-tip frontier retains delivery order. Witnesses must sign the same sorted
// dependency list that is carried by the final ordinary operation.
const claimWitness = seededEd25519Identity("township:beacon:w0");
const claimWitness2 = seededEd25519Identity("township:beacon:w1");
const tips: CarrierOpFrame[] = [];
for (const text of ["left tip", "right tip"]) tips.push(await authorTownshipCommand({
  replica: beaconVector.replica, deps: [beaconGenesis.id], command: { command: "post", text },
  capId: beaconGenesisDelegation.id, signer: beaconFounder }));
tips.sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const claimFrames = [beaconGenesis, ...tips];
const deliveredDeps = frontier(carrierOpsToSemanticOps(claimFrames, beaconVector.realmByPubkey));
const claim: WitnessedBeaconClaimEvidence = { version: 1, replica: beaconVector.replica, epoch: 4,
  author: claimWitness.publicKeyBase64, deps: deliveredDeps };
const claimPayload = canonicalBytesForWitnessedBeaconClaim(claim);
const entries = [claimWitness, claimWitness2].sort((a, b) => Buffer.compare(a.publicKey, b.publicKey));
const finalBeacon = await authorCarrierOp({ replica: beaconVector.replica, deps: claim.deps,
  kind: "authority", cap: ["nil"], signer: claimWitness,
  body: beaconClaimBody(claim, entries.map((entry) => ({ witness: entry.publicKeyBase64,
    signature: Buffer.from(entry.sign(claimPayload)).toString("base64") }))) });
check("authored beacon claim uses final canonical dependencies", claim.deps, finalBeacon.deps);
check("witnessed beacon authored from a two-tip frontier is honored", materialize(beaconVector.schema,
  carrierOpsToSemanticOps([...claimFrames, finalBeacon], beaconVector.realmByPubkey)).quarantine.includes(finalBeacon.id), false);

function beaconClaimBody(claim: WitnessedBeaconClaimEvidence,
  signatures: { witness: string; signature: string }[]): CarrierTerm {
  const fields: [CarrierTerm, CarrierTerm][] = [
    [["atom", "version"], ["int", claim.version]], [["atom", "replica"], ["bin", textBase64(claim.replica)]],
    [["atom", "epoch"], ["int", claim.epoch]], [["atom", "author"], ["bin", claim.author]],
    [["atom", "deps"], ["list", claim.deps.map((id) => ["bin", textBase64(id)])]],
  ];
  return ["tuple", [["atom", "beacon"], ["int", claim.epoch], ["map", [
    [["atom", "claim"], ["map", fields]], [["atom", "signatures"], ["list", signatures.map((entry) =>
      ["map", [[["atom", "witness"], ["bin", entry.witness]], [["atom", "signature"], ["bin", entry.signature]]]])]],
  ]]]];
}


console.log(
  `\n${failures === 0 ? "\x1b[32m✓ Township authoring checks passed\x1b[0m" : `\x1b[31m✗ ${failures} check(s) failed\x1b[0m`}`,
);
process.exit(failures === 0 ? 0 : 1);

function commandBody(command: string, arg?: string): CarrierTerm {
  const args: CarrierTerm[] = arg === undefined ? [] : [["bin", textBase64(arg)]];
  return ["tuple", [["atom", command], ["list", args]]];
}

function authorityCommandName(frame: CarrierOpFrame): string | null {
  const body = frame.body;
  return frame.kind === "authority" && body[0] === "tuple" && body[1][0]?.[0] === "atom"
    ? body[1][0][1]
    : null;
}

function textBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function seededEd25519Identity(seed: string) {
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
    publicKeyBase64: Buffer.from(publicKey).toString("base64"),
    sign(bytes: Uint8Array): Uint8Array {
      return new Uint8Array(edSign(null, Buffer.from(bytes), privateKey));
    },
  };
}
