import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  authorTownshipGenesis,
  authorTreehouseAdmitAndGrant,
  authorTreehouseCommand,
  authorTreehouseIssueInvitation,
  carrierDelegationsFromFrames,
  memberCapability,
  prepareTreehouseSpaceCreation,
  signTreehouseAcceptance,
  treehouseCommandDecoders,
} from "@treetopdevs/lattice-client";
import type { CarrierOpFrame, CarrierOpSigner } from "@treetopdevs/lattice-client";

// One Space and one legacy-rooted Thread, authored with lattice-client's helpers in the same order
// as clients/treehouse-tauri-shell (root-only Space preparation, Thread genesis and title, the Space's
// create_thread reference, then issue_invitation, acceptance and admit-and-grant per member).
//
// Test identities are seeded per process from a random namespace. The seed stays inside the signer
// closure: a TestIdentity exposes its realm, public key and signer only, so no seed can reach an
// assertion diff, a log line or a manifest.

export interface TestIdentity {
  realm: string;
  /** Standard base64 Ed25519 public key. */
  pubkey: string;
  signer: CarrierOpSigner;
  /** Author a signed post on top of `frames` (a Thread view) with this identity's honored grant. */
  post(frames: readonly CarrierOpFrame[], text: string): Promise<CarrierOpFrame>;
}

export interface Group {
  admin: TestIdentity;
  members: TestIdentity[];
  space: { replica: string; frames: CarrierOpFrame[] };
  thread: { replica: string; frames: CarrierOpFrame[] };
}

const NAMESPACE = randomBytes(16).toString("hex");

export function testIdentity(realm: string): TestIdentity {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(realm)) throw new Error(`invalid test realm: ${realm}`);
  return identityFromSeed(realm, createHash("sha256").update(`treehouse-mobile-test:${NAMESPACE}:${realm}`).digest());
}

/**
 * A TestIdentity over a seed the caller holds (the loopback demo server, which must serve demo seeds as the
 * public demo relay does). The seed stays in the signer closure and in the caller; it is never returned.
 */
export function identityFromSeed(realm: string, seed: Uint8Array): TestIdentity {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(realm)) throw new Error(`invalid test realm: ${realm}`);
  const publicKey = ed25519.getPublicKey(seed);
  const signer: CarrierOpSigner = { publicKey, sign: (bytes: Uint8Array) => ed25519.sign(bytes, seed) };
  const pubkey = Buffer.from(publicKey).toString("base64");
  return {
    realm,
    pubkey,
    signer,
    async post(frames, text) {
      const replica = frames[0]?.replica;
      if (!replica) throw new Error("post needs a Thread view");
      const cap = memberCapability(frames, pubkey, replica, { product: "Treehouse.Thread", command: "post" });
      if (!cap) throw new Error(`${realm} holds no honored post grant`);
      return authorTreehouseCommand({
        product: "Treehouse.Thread",
        replica,
        deps: heads(frames),
        signer,
        capId: cap.id,
        command: { command: "post", text },
      });
    },
  };
}

/** Frame ids no other frame depends on, sorted. */
export function heads(frames: readonly CarrierOpFrame[]): string[] {
  const referenced = new Set(frames.flatMap((f) => f.deps));
  return frames.filter((f) => !referenced.has(f.id)).map((f) => f.id).sort();
}

export async function buildGroup(
  opts: { members?: number; identities?: { admin: TestIdentity; members: TestIdentity[] } } = {},
): Promise<Group> {
  const count = opts.members ?? 2;
  const admin = opts.identities?.admin ?? testIdentity("admin");
  const members = opts.identities?.members ?? Array.from({ length: count }, (_, i) => testIdentity(`member-${i + 1}`));
  const nonce = () => randomBytes(12).toString("base64url");

  const prepared = await prepareTreehouseSpaceCreation({
    replica: `replica:treehouse:space:${nonce()}`,
    name: "Canopy",
    signer: admin.signer,
  });
  const space = { replica: prepared.replica, frames: [...prepared.pending] };
  const spaceCap = carrierDelegationsFromFrames([space.frames[0]!])[0]!.id;

  const genesis = await authorTownshipGenesis({
    replica: `replica:treehouse:thread:${nonce()}`,
    signer: admin.signer,
    ops: [...treehouseCommandDecoders("Treehouse.Thread").keys()],
    roles: ["moderator"],
    policies: {},
  });
  const threadCap = carrierDelegationsFromFrames([genesis])[0]!.id;
  const title = await authorTreehouseCommand({
    product: "Treehouse.Thread",
    replica: genesis.replica,
    deps: [genesis.id],
    signer: admin.signer,
    capId: threadCap,
    command: { command: "create_thread", title: "General" },
  });
  const thread = { replica: genesis.replica, frames: [genesis, title] };

  space.frames.push(
    await authorTreehouseCommand({
      product: "Treehouse.Space",
      replica: space.replica,
      deps: heads(space.frames),
      signer: admin.signer,
      capId: spaceCap,
      command: { command: "create_thread", title: "General", threadReplica: thread.replica },
    }),
  );

  for (const member of members) {
    const threadFrames = { [thread.replica]: thread.frames };
    const issued = await authorTreehouseIssueInvitation({
      signer: admin.signer,
      replica: space.replica,
      frames: space.frames,
      threadFrames,
      routes: [{ replica: thread.replica }],
      recipient: member.pubkey,
    });
    space.frames.push(issued.frame);
    const acceptance = await signTreehouseAcceptance({
      replica: space.replica,
      frames: space.frames,
      invitationId: issued.frame.id,
      signer: member.signer,
    });
    const authored = await authorTreehouseAdmitAndGrant({
      signer: admin.signer,
      replica: space.replica,
      frames: space.frames,
      threadFrames,
      acceptance,
    });
    if (!authored.admit) throw new Error(`${member.realm} was not admitted`);
    space.frames.push(authored.admit);
    for (const grant of authored.grants) {
      if (grant.replica !== thread.replica) throw new Error("grant for an unknown Thread");
      thread.frames.push(grant.frame);
    }
  }
  return { admin, members, space, thread };
}
