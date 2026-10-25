import { ed25519 } from "@noble/curves/ed25519.js";
import { carrierOpsToSemanticOps, decodeCarrierOpFrame } from "./carrier";
import type { CarrierOpFrame } from "./carrier";
import { resolveContinuationProfileFromFrames } from "./authority";
import { reviewTreehouseInvitation } from "./treehouse_enrollment";
import { treehouseCatalogBootstrapsFromFrames, treehouseCommandDecoders, observeTreehouse, treehouseSpaceInitialization } from "./treehouse";
import { treehouseSpaceFamily } from "./treehouse_bounded";
import { verifyCarrierOp } from "./codec";
import { buildSpaceFramesExport } from "./treehouse_public_frames";

export const OFFLINE_INVITATION_FORMAT = "treehouse-offline-invitation-v1";
export const OFFLINE_EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;
const fields = ["bootstrapId", "format", "invitationId", "product", "profiles", "recipient", "space", "spaceRoot"];
const frameFields = ["author", "body", "cap", "deps", "id", "kind", "replica", "sig", "v"];
const encoder = new TextEncoder();
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
const closed = (value: unknown, names: string[]): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify(names);
const refuse = (): never => { throw new Error("invalid_offline_invitation"); };
const verifier = { verify: async (pub: string, bytes: Uint8Array, sig: Uint8Array) =>
  ed25519.verify(sig, bytes, Uint8Array.from(atob(pub), c => c.charCodeAt(0)), { zip215: false }) };

/** Candidate evidence only. A successful decode installs no profile, route, catalog pin or trust receipt. */
export interface OfflineInvitationReview {
  space: string;
  spaceRoot: string;
  name: string;
  threadTitles: { replica: string; title: string }[];
  bootstrapId: string;
  invitationId: string;
  recipient: string;
  threads: string[];
  fingerprint: string;
  frames: CarrierOpFrame[];
  text: string;
}

/** Rebuild public frames through the established canonical wire encoder, never export retained app state. */
export async function buildOfflineInvitation(input: {
  space: string; frames: readonly CarrierOpFrame[]; invitationId: string; recipient: string;
}): Promise<string> {
  const profile = await resolveContinuationProfileFromFrames({ replica: input.space, frames: input.frames });
  if (!profile.ok || treehouseSpaceFamily(input.space) !== "bounded") return refuse();
  const bootstraps = await treehouseCatalogBootstrapsFromFrames({ replica: input.space, frames: input.frames });
  if (!bootstraps.ok || bootstraps.bootstraps.length !== 1) return refuse();
  const bootstrap = bootstraps.bootstraps[0]!;
  const exported = JSON.parse(await buildSpaceFramesExport({ space: input.space,
    rootPublicKey: profile.root, frames: input.frames,
    verify: async frame => (await verifyCarrierOp(frame, verifier)).valid }));
  const text = canonical({ format: OFFLINE_INVITATION_FORMAT, product: "treehouse",
    space: input.space, spaceRoot: profile.root, bootstrapId: bootstrap.id,
    invitationId: input.invitationId, recipient: input.recipient,
    profiles: [{ product: "Treehouse.Space", replica: input.space, frames: exported.frames }] });
  await reviewOfflineInvitation(encoder.encode(text), input.recipient);
  return text;
}

/** Bound bytes before parsing; exact re-encoding rejects duplicate keys, extra fields and alternate spellings. */
export async function reviewOfflineInvitation(bytes: Uint8Array, recipient: string): Promise<OfflineInvitationReview> {
  try {
    if (bytes.byteLength > OFFLINE_EVIDENCE_MAX_BYTES) return refuse();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const doc: unknown = JSON.parse(text);
    if (!closed(doc, fields) || doc.format !== OFFLINE_INVITATION_FORMAT || doc.product !== "treehouse" ||
      typeof doc.space !== "string" || typeof doc.spaceRoot !== "string" || typeof doc.bootstrapId !== "string" ||
      typeof doc.invitationId !== "string" || doc.recipient !== recipient ||
      !Array.isArray(doc.profiles) || doc.profiles.length !== 1 || canonical(doc) !== text) return refuse();
    const raw: unknown = doc.profiles[0];
    if (!closed(raw, ["frames", "product", "replica"]) || raw.product !== "Treehouse.Space" || raw.replica !== doc.space ||
      !Array.isArray(raw.frames) || raw.frames.length < 1 || raw.frames.length > 4000) return refuse();
    const frames = raw.frames.map((value: unknown) => {
      if (!closed(value, frameFields)) return refuse();
      const frame = decodeCarrierOpFrame(value);
      if (frame.replica !== doc.space || canonical(frame.deps) !== canonical([...new Set(frame.deps)].sort()) ||
        encoder.encode(JSON.stringify({ type: "push", ops: [frame] })).length > 64000) return refuse();
      return frame;
    });
    const profile = await resolveContinuationProfileFromFrames({ replica: doc.space, frames });
    if (!profile.ok || treehouseSpaceFamily(doc.space) !== "bounded" || profile.root !== doc.spaceRoot ||
      profile.profile.kind !== "space" || profile.profile.role !== "admin") return refuse();
    const observed = await treehouseCatalogBootstrapsFromFrames({ replica: doc.space, frames });
    if (!observed.ok || observed.bootstraps.length !== 1) return refuse();
    const bootstrap = observed.bootstraps[0]!;
    if (bootstrap.id !== doc.bootstrapId || bootstrap.record.space !== doc.space ||
      bootstrap.record.spaceRoot !== doc.spaceRoot || bootstrap.record.profileGenesis !== profile.profileGenesis ||
      bootstrap.record.profileId !== profile.profileId || frames.find(f => f.id === bootstrap.id)?.author !== profile.root) return refuse();
    const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"));
    if (treehouseSpaceInitialization(ops) !== "ready" || ops.some(op => op.kind === "tombstone" && op.authorPubkey === profile.root)) return refuse();
    const invitation = reviewTreehouseInvitation({ replica: doc.space, frames, invitationId: doc.invitationId, recipient });
    if (!invitation.ok || invitation.threads.length > 3) return refuse();
    // Rebuild terms/order as BEAM does. Authentic but noncanonical term spellings do not survive.
    const exported = JSON.parse(await buildSpaceFramesExport({ space: doc.space, rootPublicKey: profile.root, frames,
      verify: async frame => (await verifyCarrierOp(frame, verifier)).valid }));
    if (canonical(exported.frames) !== canonical(raw.frames)) return refuse();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonical([
      "treehouse-offline-group-fingerprint-v1", doc.space, doc.spaceRoot, doc.bootstrapId,
    ]))));
    const fingerprint = Array.from(digest, n => n.toString(16).padStart(2, "0")).join("").match(/.{4}/g)!.join(" ");
    const view = observeTreehouse("Treehouse.Space", ops);
    const threadTitles = (view.state.threads as { replica: string; title: string }[])
      .filter(thread => invitation.threads.includes(thread.replica));
    return { space: doc.space, spaceRoot: doc.spaceRoot, name: String(view.state.name), threadTitles, bootstrapId: doc.bootstrapId,
      invitationId: doc.invitationId, recipient, threads: invitation.threads, fingerprint, frames, text };
  } catch { return refuse(); }
}

/** Public provisioning candidate; the Linux importer independently verifies its ceremony and full staging policy. */
export async function buildInitialProvisioningBundle(input: {
  space: string; spaceFrames: readonly CarrierOpFrame[]; thread: string; threadFrames: readonly CarrierOpFrame[];
}): Promise<string> {
  const snapshot = structuredClone(input);
  const profiles = await Promise.all([
    { product: "Treehouse.Space", replica: snapshot.space, frames: snapshot.spaceFrames },
    { product: "Treehouse.Thread", replica: snapshot.thread, frames: snapshot.threadFrames },
  ].map(async profile => {
    const resolved = await resolveContinuationProfileFromFrames({ replica: profile.replica, frames: profile.frames });
    if (!resolved.ok) return refuse();
    const exported = JSON.parse(await buildSpaceFramesExport({ space: profile.replica, rootPublicKey: resolved.root,
      frames: profile.frames, verify: async frame => (await verifyCarrierOp(frame, verifier)).valid }));
    return { product: profile.product, replica: profile.replica, frames: exported.frames as CarrierOpFrame[] };
  }));
  if (profiles[0]!.frames.length + profiles[1]!.frames.length > 4000) return refuse();
  const observed = await treehouseCatalogBootstrapsFromFrames({ replica: snapshot.space, frames: profiles[0]!.frames });
  if (!observed.ok || observed.bootstraps.length !== 1) return refuse();
  const bootstrap = observed.bootstraps[0]!;
  const spaceOps = carrierOpsToSemanticOps(profiles[0]!.frames, {}, treehouseCommandDecoders("Treehouse.Space"));
  const view = observeTreehouse("Treehouse.Space", spaceOps);
  const references = spaceOps.filter(op => op.command === "create_thread" && !view.quarantineReasons.has(op.id));
  const members = view.state.members as string[];
  if (references.length !== 1 || references[0]!.commandArgs?.[0] !== snapshot.thread ||
    members.length !== 2 || !members.includes(bootstrap.record.spaceRoot)) return refuse();
  const threadOps = carrierOpsToSemanticOps(profiles[1]!.frames, {}, treehouseCommandDecoders("Treehouse.Thread"));
  const threadView = observeTreehouse("Treehouse.Thread", threadOps);
  if (threadView.quarantineReasons.size || threadOps.some(op => op.kind === "tombstone")) return refuse();
  const text = canonical({ format: "treehouse-initial-provisioning-v1", product: "treehouse", space: snapshot.space,
    spaceRoot: bootstrap.record.spaceRoot, bootstrapId: bootstrap.id, referenceId: references[0]!.id, profiles });
  if (encoder.encode(text).length > OFFLINE_EVIDENCE_MAX_BYTES) return refuse();
  return text;
}
