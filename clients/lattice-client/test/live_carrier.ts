import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  authorAndPersistTownshipCommand,
  authorTownshipCommand,
  authorTownshipDelegation,
  authorTownshipGenesis,
  authorTownshipRevocation,
  carrierDelegationsFromFrames,
  carrierOpsToSemanticOps,
  connectCarrierWebSocket,
  createJsonCarrierFrameStore,
  createJsonLocalOpLogStore,
  frontier,
  materialize,
  selectTownshipCapId,
  syncCarrierOnce,
} from "../src/index";
import type { CarrierOpFrame, CarrierVerifier, Op, ReplicaSchema } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const vecDir = join(here, "vectors");

let failures = 0;
const eq = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);

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

type AuthorityQuarantinePair = [string, string];

function sortedAuthorityQuarantine(pairs: AuthorityQuarantinePair[]): AuthorityQuarantinePair[] {
  return pairs
    .map(([id, reason]) => [id, reason] as AuthorityQuarantinePair)
    .sort(([leftId, leftReason], [rightId, rightReason]) =>
      `${leftId}\0${leftReason}`.localeCompare(`${rightId}\0${rightReason}`),
    );
}

function checkAuthorityQuarantine(name: string, got: AuthorityQuarantinePair[], want: AuthorityQuarantinePair[]) {
  check(name, sortedAuthorityQuarantine(got), sortedAuthorityQuarantine(want));
}

function hasAuthorityQuarantinePair(pairs: AuthorityQuarantinePair[], want: AuthorityQuarantinePair): boolean {
  return pairs.some(([id, reason]) => id === want[0] && reason === want[1]);
}

interface CarrierVector {
  scenario: string;
  replica: string;
  schema: ReplicaSchema;
  realmByPubkey: Record<string, string>;
  client: { realm: string; sessionSeed: string; sessionPubkey: string };
  peer: { realm: string; sessionPubkey: string };
  clientDivergedCarrierOps: CarrierOpFrame[];
  authorityUnsoundGrant: {
    carrierOp: CarrierOpFrame;
    parentDelegationId: string;
    authorityQuarantine: AuthorityQuarantinePair[];
  };
  authorityRevocation: {
    delegationId: string;
    preRevokeCommandId: string;
    revokeOp: CarrierOpFrame;
    revokedCommandOp: CarrierOpFrame;
    authorityQuarantine: AuthorityQuarantinePair[];
    stateB64: string;
    opIds: string[];
  };
  authorityBadRevocation: {
    delegationId: string;
    revokeOp: CarrierOpFrame;
    postRevokeCommandOp: CarrierOpFrame;
    authorityQuarantine: AuthorityQuarantinePair[];
    stateB64: string;
    opIds: string[];
  };
  expectAfterSync: {
    state: Record<string, unknown>;
    stateB64: string;
    opIds: string[];
    authorityQuarantine: AuthorityQuarantinePair[];
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

const vector = JSON.parse(
  await import("node:fs").then((fs) => fs.readFileSync(join(vecDir, "township_carrier_w1.json"), "utf8")),
) as CarrierVector;

console.log(`\n▸ ${vector.scenario} live carrier`);

const identity = seededEd25519Identity(vector.client.sessionSeed);
const verifier: CarrierVerifier = {
  verify(pubkey, bytes, signature) {
    return edVerify(null, Buffer.from(bytes), publicKeyObject(pubkey), Buffer.from(signature));
  },
};

check("fixture public key", identity.publicKeyBase64, vector.client.sessionPubkey);

const residentAuthor = seededEd25519Identity(`${vector.client.sessionSeed}:${vector.client.realm}`);
check("resident author public key", residentAuthor.publicKeyBase64, pubkeyForRealm(vector.realmByPubkey, vector.client.realm));

const clerkAuthor = seededEd25519Identity(`${vector.client.sessionSeed}:${vector.peer.realm}`);
check("clerk author public key", clerkAuthor.publicKeyBase64, pubkeyForRealm(vector.realmByPubkey, vector.peer.realm));

const evilAuthor = seededEd25519Identity(`${vector.client.sessionSeed}:evil`);

const postFixture = vector.clientDivergedCarrierOps.find(
  (frame) => frame.author === residentAuthor.publicKeyBase64 && commandName(frame) === "post",
);
if (!postFixture) throw new Error("missing resident post fixture frame");

const postCommand = { command: "post", text: "resident: posted while offline" } as const;
const postCapId = selectTownshipCapId(
  postCommand,
  carrierDelegationsFromFrames(vector.clientDivergedCarrierOps),
  residentAuthor.publicKeyBase64,
);
check("resident post cap id", postCapId, "gN9aanNVZeHWsS1vU8KxjyqVrWdC0VwPIzilL_QX2n0");

const localOpsBeforePost = carrierOpsToSemanticOps(
  vector.clientDivergedCarrierOps.filter((frame) => frame.id !== postFixture.id),
  vector.realmByPubkey,
);
const authoredLocalLog = createJsonLocalOpLogStore(new MemoryKeyValueStore(), "township:resident:ops");
await authoredLocalLog.save(localOpsBeforePost);
const authoredFrameStore = createJsonCarrierFrameStore(new MemoryKeyValueStore(), "township:resident:frames");
await authoredFrameStore.save(vector.clientDivergedCarrierOps.filter((frame) => frame.id !== postFixture.id));
const authoredPost = await authorAndPersistTownshipCommand({
  replica: postFixture.replica,
  command: postCommand,
  signer: residentAuthor,
  localLog: authoredLocalLog,
  carrierFrames: authoredFrameStore,
  realmByPubkey: vector.realmByPubkey,
});
check("author-and-persist cap id", authoredPost.capId, postCapId);
check("authored resident post frame", authoredPost.frame, postFixture);
const authoredClientFrames = await authoredFrameStore.load();
check("persisted authored frame outbox", authoredClientFrames, vector.clientDivergedCarrierOps);

const peer = await spawnTownshipPeer(vector);

try {
  let conn = await connectCarrierWebSocket({
    url: `ws://127.0.0.1:${peer.port}/carrier`,
    localRealm: vector.client.realm,
    replica: vector.replica,
    signer: identity,
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: Buffer.from(vector.peer.sessionPubkey, "base64"),
    verifier,
  });

  check("initial peer status", await conn.status(), "base");
  conn.close();

  conn = await reconnectWhenDiverged(peer.port, vector, identity, verifier);

  const clientDiverged = await authoredLocalLog.load();
  const synced = await syncCarrierOnce(conn, clientDiverged, authoredClientFrames, vector.realmByPubkey);
  check("pulled peer op count", synced.pulledOps.length, 5);
  check("push frame count", synced.pushedFrames.length, 2);
  check("push accepted count", synced.pushReport.accepted.length, 2);
  check("acknowledged outbox ids", synced.acknowledgedFrameIds, authoredClientFrames.map((frame) => frame.id));
  check("push quarantined", synced.pushReport.quarantined, []);

  const merged = synced.ops;
  const materialized = materialize(vector.schema, merged);
  for (const [field, want] of Object.entries(vector.expectAfterSync.state)) {
    check(`state.${field}`, materialized.state[field], want);
  }
  check("authority quarantine", materialized.quarantine.sort(), vector.expectAfterSync.authorityQuarantine.map(([id]) => id).sort());
  check("merged op ids", merged.map((op: Op) => op.id).sort(), vector.expectAfterSync.opIds);

  const peerReport = await conn.stateReport();
  check("peer state bytes", peerReport.state_b64, vector.expectAfterSync.stateB64);
  check("peer op ids", peerReport.op_ids, vector.expectAfterSync.opIds);
  checkAuthorityQuarantine(
    "peer authority quarantine",
    peerReport.authority_quarantine,
    vector.expectAfterSync.authorityQuarantine,
  );

  const authorityUnsoundGrant = await authorTownshipDelegation({
    replica: vector.replica,
    deps: frontier(merged),
    audiencePubkey: pubkeyForRealm(vector.realmByPubkey, vector.peer.realm),
    parentId: vector.authorityUnsoundGrant.parentDelegationId,
    ops: ["close_matter"],
    roles: ["clerk"],
    signer: residentAuthor,
  });
  check("authored authority-unsound grant frame", authorityUnsoundGrant, vector.authorityUnsoundGrant.carrierOp);

  const [authorityUnsoundOp] = carrierOpsToSemanticOps([authorityUnsoundGrant], vector.realmByPubkey);
  if (!authorityUnsoundOp) throw new Error("authority-unsound grant did not decode to a semantic op");

  const unsoundSynced = await syncCarrierOnce(
    conn,
    [...merged, authorityUnsoundOp],
    [authorityUnsoundGrant],
    vector.realmByPubkey,
  );
  check("authority-unsound grant pushed", carrierFrameIds(unsoundSynced.pushedFrames), [authorityUnsoundGrant.id]);
  check("authority-unsound grant structurally accepted", unsoundSynced.pushReport.accepted, [authorityUnsoundGrant.id]);
  check("authority-unsound grant structural quarantine", unsoundSynced.pushReport.quarantined, []);

  const unsoundPeerReport = await conn.stateReport();
  check("authority-unsound grant leaves state bytes unchanged", unsoundPeerReport.state_b64, vector.expectAfterSync.stateB64);
  const expectedUnsoundQuarantine: AuthorityQuarantinePair = [authorityUnsoundGrant.id, "not_attenuated"];
  check(
    "authority-unsound grant quarantine member",
    hasAuthorityQuarantinePair(unsoundPeerReport.authority_quarantine, expectedUnsoundQuarantine),
    true,
  );
  // The Sim-exported full set also includes W1's pre-existing stale-clerk not_holder entry.
  checkAuthorityQuarantine(
    "authority-unsound grant peer authority quarantine",
    unsoundPeerReport.authority_quarantine,
    vector.authorityUnsoundGrant.authorityQuarantine,
  );

  const forgedGenesis = await authorTownshipGenesis({
    replica: vector.replica,
    ops: ["post"],
    roles: ["clerk"],
    live: true,
    signer: evilAuthor,
  });
  check("forged genesis command", commandName(forgedGenesis), "genesis");
  check("forged genesis uses honest bound replica", forgedGenesis.replica, vector.replica);

  const [forgedGenesisOp] = carrierOpsToSemanticOps([forgedGenesis], vector.realmByPubkey);
  if (!forgedGenesisOp) throw new Error("forged genesis did not decode to a semantic op");

  const forgedSynced = await syncCarrierOnce(
    conn,
    [...unsoundSynced.ops, forgedGenesisOp],
    [forgedGenesis],
    vector.realmByPubkey,
  );
  check("forged genesis pushed", carrierFrameIds(forgedSynced.pushedFrames), [forgedGenesis.id]);
  check("forged genesis structurally accepted", forgedSynced.pushReport.accepted, [forgedGenesis.id]);
  check("forged genesis structural quarantine", forgedSynced.pushReport.quarantined, []);

  const forgedPeerReport = await conn.stateReport();
  check("forged genesis leaves state bytes unchanged", forgedPeerReport.state_b64, vector.expectAfterSync.stateB64);
  const expectedForgedGenesisPair: AuthorityQuarantinePair = [forgedGenesis.id, "impostor_genesis"];
  check(
    "forged genesis authority quarantine member",
    hasAuthorityQuarantinePair(forgedPeerReport.authority_quarantine, expectedForgedGenesisPair),
    true,
  );

  await conn.shutdown();
  await peer.awaitExit();
} finally {
  peer.kill();
}

const revocationPeer = await spawnTownshipPeer(vector);

try {
  let conn = await connectCarrierWebSocket({
    url: `ws://127.0.0.1:${revocationPeer.port}/carrier`,
    localRealm: vector.client.realm,
    replica: vector.replica,
    signer: identity,
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: Buffer.from(vector.peer.sessionPubkey, "base64"),
    verifier,
  });

  check("revocation initial peer status", await conn.status(), "base");
  conn.close();

  conn = await reconnectWhenDiverged(revocationPeer.port, vector, identity, verifier);

  const clientDiverged = await authoredLocalLog.load();
  const synced = await syncCarrierOnce(conn, clientDiverged, authoredClientFrames, vector.realmByPubkey);
  const merged = synced.ops;

  const baselineReport = await conn.stateReport();
  check("revocation baseline state bytes", baselineReport.state_b64, vector.expectAfterSync.stateB64);
  check(
    "pre-revoke command is not authority-quarantined",
    baselineReport.authority_quarantine.some(([id]) => id === vector.authorityRevocation.preRevokeCommandId),
    false,
  );

  const revokeFrame = await authorTownshipRevocation({
    replica: vector.replica,
    deps: frontier(merged),
    delegationId: vector.authorityRevocation.delegationId,
    signer: clerkAuthor,
  });
  check("live authored revocation frame", revokeFrame, vector.authorityRevocation.revokeOp);

  const [revokeOp] = carrierOpsToSemanticOps([revokeFrame], vector.realmByPubkey);
  if (!revokeOp) throw new Error("revocation frame did not decode to a semantic op");

  const afterRevoke = await syncCarrierOnce(conn, [...merged, revokeOp], [revokeFrame], vector.realmByPubkey);
  check("revocation pushed", carrierFrameIds(afterRevoke.pushedFrames), [revokeFrame.id]);
  check("revocation structurally accepted", afterRevoke.pushReport.accepted, [revokeFrame.id]);
  check("revocation structural quarantine", afterRevoke.pushReport.quarantined, []);

  const revokedResidentPostCommand = { command: "post", text: "resident: attempted after revocation" } as const;
  const revokedPostFrame = await authorTownshipCommand({
    replica: vector.replica,
    deps: frontier(afterRevoke.ops),
    command: revokedResidentPostCommand,
    capId: vector.authorityRevocation.delegationId,
    signer: residentAuthor,
  });
  check("live authored revoked-cap post frame", revokedPostFrame, vector.authorityRevocation.revokedCommandOp);

  const [revokedPostOp] = carrierOpsToSemanticOps([revokedPostFrame], vector.realmByPubkey);
  if (!revokedPostOp) throw new Error("revoked-cap post frame did not decode to a semantic op");

  const afterRevokedPost = await syncCarrierOnce(
    conn,
    [...afterRevoke.ops, revokedPostOp],
    [revokedPostFrame],
    vector.realmByPubkey,
  );
  check("revoked-cap post pushed", carrierFrameIds(afterRevokedPost.pushedFrames), [revokedPostFrame.id]);
  check("revoked-cap post structurally accepted", afterRevokedPost.pushReport.accepted, [revokedPostFrame.id]);
  check("revoked-cap post structural quarantine", afterRevokedPost.pushReport.quarantined, []);

  const revocationReport = await conn.stateReport();
  check("revocation lifecycle state bytes", revocationReport.state_b64, vector.authorityRevocation.stateB64);
  check("revocation lifecycle op ids", revocationReport.op_ids, vector.authorityRevocation.opIds);
  const expectedRevokedPair: AuthorityQuarantinePair = [revokedPostFrame.id, "revoked_capability"];
  check(
    "revoked-cap post authority quarantine member",
    hasAuthorityQuarantinePair(revocationReport.authority_quarantine, expectedRevokedPair),
    true,
  );
  checkAuthorityQuarantine(
    "revocation lifecycle peer authority quarantine",
    revocationReport.authority_quarantine,
    vector.authorityRevocation.authorityQuarantine,
  );

  await conn.shutdown();
  await revocationPeer.awaitExit();
} finally {
  revocationPeer.kill();
}

const badRevocationPeer = await spawnTownshipPeer(vector);

try {
  let conn = await connectCarrierWebSocket({
    url: `ws://127.0.0.1:${badRevocationPeer.port}/carrier`,
    localRealm: vector.client.realm,
    replica: vector.replica,
    signer: identity,
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: Buffer.from(vector.peer.sessionPubkey, "base64"),
    verifier,
  });

  check("bad revocation initial peer status", await conn.status(), "base");
  conn.close();

  conn = await reconnectWhenDiverged(badRevocationPeer.port, vector, identity, verifier);

  const clientDiverged = await authoredLocalLog.load();
  const synced = await syncCarrierOnce(conn, clientDiverged, authoredClientFrames, vector.realmByPubkey);
  const merged = synced.ops;

  const badRevokeFrame = await authorTownshipRevocation({
    replica: vector.replica,
    deps: frontier(merged),
    delegationId: vector.authorityBadRevocation.delegationId,
    signer: residentAuthor,
  });
  check("live authored bad revocation frame", badRevokeFrame, vector.authorityBadRevocation.revokeOp);

  const [badRevokeOp] = carrierOpsToSemanticOps([badRevokeFrame], vector.realmByPubkey);
  if (!badRevokeOp) throw new Error("bad revocation frame did not decode to a semantic op");

  const afterBadRevoke = await syncCarrierOnce(conn, [...merged, badRevokeOp], [badRevokeFrame], vector.realmByPubkey);
  check("bad revocation pushed", carrierFrameIds(afterBadRevoke.pushedFrames), [badRevokeFrame.id]);
  check("bad revocation structurally accepted", afterBadRevoke.pushReport.accepted, [badRevokeFrame.id]);
  check("bad revocation structural quarantine", afterBadRevoke.pushReport.quarantined, []);

  const postAfterBadRevokeCommand = { command: "post", text: "resident: post after unauthorized revoke" } as const;
  const postAfterBadRevokeFrame = await authorTownshipCommand({
    replica: vector.replica,
    deps: frontier(afterBadRevoke.ops),
    command: postAfterBadRevokeCommand,
    capId: vector.authorityBadRevocation.delegationId,
    signer: residentAuthor,
  });
  check(
    "live authored post after bad revoke frame",
    postAfterBadRevokeFrame,
    vector.authorityBadRevocation.postRevokeCommandOp,
  );

  const [postAfterBadRevokeOp] = carrierOpsToSemanticOps([postAfterBadRevokeFrame], vector.realmByPubkey);
  if (!postAfterBadRevokeOp) throw new Error("post after bad revoke frame did not decode to a semantic op");

  const afterPostBadRevoke = await syncCarrierOnce(
    conn,
    [...afterBadRevoke.ops, postAfterBadRevokeOp],
    [postAfterBadRevokeFrame],
    vector.realmByPubkey,
  );
  check("post after bad revoke pushed", carrierFrameIds(afterPostBadRevoke.pushedFrames), [postAfterBadRevokeFrame.id]);
  check("post after bad revoke structurally accepted", afterPostBadRevoke.pushReport.accepted, [postAfterBadRevokeFrame.id]);
  check("post after bad revoke structural quarantine", afterPostBadRevoke.pushReport.quarantined, []);

  const badRevocationReport = await conn.stateReport();
  check("bad revocation state bytes changed by honored post", badRevocationReport.state_b64 === vector.expectAfterSync.stateB64, false);
  check("bad revocation lifecycle state bytes", badRevocationReport.state_b64, vector.authorityBadRevocation.stateB64);
  check("bad revocation lifecycle op ids", badRevocationReport.op_ids, vector.authorityBadRevocation.opIds);
  const expectedBadRevokePair: AuthorityQuarantinePair = [badRevokeFrame.id, "unauthorized_revoke"];
  check(
    "bad revocation authority quarantine member",
    hasAuthorityQuarantinePair(badRevocationReport.authority_quarantine, expectedBadRevokePair),
    true,
  );
  check(
    "post after bad revoke stays authority-honored",
    badRevocationReport.authority_quarantine.some(([id]) => id === postAfterBadRevokeFrame.id),
    false,
  );
  checkAuthorityQuarantine(
    "bad revocation peer authority quarantine",
    badRevocationReport.authority_quarantine,
    vector.authorityBadRevocation.authorityQuarantine,
  );

  await conn.shutdown();
  await badRevocationPeer.awaitExit();
} finally {
  badRevocationPeer.kill();
}

console.log(`\n${failures === 0 ? "\x1b[32m✓ live carrier checks passed\x1b[0m" : `\x1b[31m✗ ${failures} check(s) failed\x1b[0m`}`);
process.exit(failures === 0 ? 0 : 1);

async function reconnectWhenDiverged(
  port: number,
  vector: CarrierVector,
  identity: ReturnType<typeof seededEd25519Identity>,
  verifier: CarrierVerifier,
) {
  for (let i = 0; i < 50; i++) {
    const conn = await connectCarrierWebSocket({
      url: `ws://127.0.0.1:${port}/carrier`,
      localRealm: vector.client.realm,
      replica: vector.replica,
      signer: identity,
      expectedPeerRealm: vector.peer.realm,
      expectedPeerPubkey: Buffer.from(vector.peer.sessionPubkey, "base64"),
      verifier,
    });

  if ((await conn.status()) === "diverged") return conn;
    conn.close();
    await delay(20);
  }
  throw new Error("peer never diverged after socket close");
}

async function spawnTownshipPeer(vector: CarrierVector) {
  const child = spawn(elixirBin(), [
    ...codePathArgs(),
    "apps/lattice_node_spike/priv/peer_node.exs",
    vector.peer.realm,
    vector.client.realm,
    vector.client.sessionPubkey,
    "LatticeNodeSpike.TownshipScenario",
  ], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
  const port = await awaitReady(child, lines);

  return {
    port,
    awaitExit: () => awaitExit(child, lines),
    kill: () => {
      if (!child.killed && child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

function awaitReady(child: ChildProcessWithoutNullStreams, lines: string[]): Promise<number> {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`peer OS process never became ready:\n${lines.join("")}`)), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line) continue;
        lines.push(`${line}\n`);
        if (line.startsWith("PEER_READY ")) {
          clearTimeout(timeout);
          resolveReady(Number.parseInt(line.slice("PEER_READY ".length), 10));
        }
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(new Error(`peer OS process exited (${code}) before READY:\n${lines.join("")}`));
    });
  });
}

function awaitExit(child: ChildProcessWithoutNullStreams, lines: string[]): Promise<void> {
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error(`peer OS process did not exit:\n${lines.join("")}`)), 10_000);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else rejectExit(new Error(`peer OS process exited with ${code}:\n${lines.join("")}`));
    });
  });
}

function codePathArgs(): string[] {
  const libRoot = join(repoRoot, "_build/test/lib");
  if (!existsSync(libRoot)) throw new Error(`missing BEAM test build at ${libRoot}; run mix test first`);

  return readdirSync(libRoot)
    .map((app) => join(libRoot, app, "ebin"))
    .filter(existsSync)
    .flatMap((path) => ["-pa", path]);
}

function elixirBin(): string {
  const asdf = join(process.env.HOME ?? "", ".asdf/shims/elixir");
  if (existsSync(asdf)) return asdf;
  return "elixir";
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

function publicKeyObject(pubkey: Uint8Array) {
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pubkey)]),
    format: "der",
    type: "spki",
  });
}

function pubkeyForRealm(realmByPubkey: Record<string, string>, realm: string): string {
  const entry = Object.entries(realmByPubkey).find(([, candidateRealm]) => candidateRealm === realm);
  if (!entry) throw new Error(`missing pubkey for realm ${realm}`);
  return entry[0];
}

function commandName(frame: CarrierOpFrame): string | undefined {
  const { body } = frame;
  if (body[0] !== "tuple") return undefined;

  const [command] = body[1];
  if (!command || command[0] !== "atom") return undefined;

  return command[1];
}

function carrierFrameIds(frames: unknown[]): string[] {
  return frames.map((frame) => {
    if (frame && typeof frame === "object" && typeof (frame as { id?: unknown }).id === "string") {
      return (frame as { id: string }).id;
    }

    throw new Error("carrier frame missing id");
  });
}

function delay(ms: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
