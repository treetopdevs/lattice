import { verifyEd25519 } from "./signature";
import { carrierOpsToSemanticOps, decodeCarrierOpFrame } from "./carrier";
import { resolveContinuationProfileFromFrames, continuationFamily } from "./authority";
import { liveTreehouseDelegations, reviewTreehouseInvitation } from "./treehouse_enrollment";
import { treehouseCatalogBootstrapsFromFrames, treehouseCommandDecoders, observeTreehouse, treehouseSpaceInitialization } from "./treehouse";
import { treehouseSpaceFamily } from "./treehouse_bounded";
import { verifyCarrierOp } from "./codec";
import { buildSpaceFramesExport } from "./treehouse_public_frames";
export const OFFLINE_INVITATION_FORMAT = "treehouse-offline-invitation-v1";
export const OFFLINE_EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;
const fields = ["bootstrapId", "format", "invitationId", "product", "profiles", "recipient", "space", "spaceRoot"];
const frameFields = ["author", "body", "cap", "deps", "id", "kind", "replica", "sig", "v"];
const encoder = new TextEncoder();
const canonical = (value) => JSON.stringify(value, (_key, v) => v !== null && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
const closed = (value, names) => value !== null && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(names);
const refuse = () => { throw new Error("invalid_offline_invitation"); };
const verifier = { verify: async (pub, bytes, sig) => verifyEd25519(sig, bytes, Uint8Array.from(atob(pub), c => c.charCodeAt(0))) };
/** Stable group identity code; invitation scope is separately reviewed against the current signed Space. */
export async function treehouseGroupFingerprint(space, spaceRoot, bootstrapId) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonical([
        "treehouse-offline-group-fingerprint-v1", space, spaceRoot, bootstrapId,
    ]))));
    return Array.from(digest, n => n.toString(16).padStart(2, "0")).join("").match(/.{4}/g).join(" ");
}
export const normalizeTreehouseFingerprint = (value) => value.replace(/\s/g, "").toLowerCase();
async function verifiedBootstrapBinding(space, frames) {
    const profile = await resolveContinuationProfileFromFrames({ replica: space, frames });
    if (!profile.ok || treehouseSpaceFamily(space) !== "bounded" || profile.profile.kind !== "space" || profile.profile.role !== "admin")
        return refuse();
    const observed = await treehouseCatalogBootstrapsFromFrames({ replica: space, frames });
    if (!observed.ok || observed.bootstraps.length !== 1)
        return refuse();
    const bootstrap = observed.bootstraps[0];
    if (bootstrap.record.space !== space || bootstrap.record.spaceRoot !== profile.root ||
        bootstrap.record.profileGenesis !== profile.profileGenesis || bootstrap.record.profileId !== profile.profileId ||
        frames.find(frame => frame.id === bootstrap.id)?.author !== profile.root)
        return refuse();
    const ops = carrierOpsToSemanticOps([...frames], {}, treehouseCommandDecoders("Treehouse.Space"));
    if (treehouseSpaceInitialization(ops) !== "ready" || ops.some(op => op.kind === "tombstone" && op.authorPubkey === profile.root))
        return refuse();
    return { profile, bootstrap, ops, view: observeTreehouse("Treehouse.Space", ops) };
}
/** Rebuild public frames through the established canonical wire encoder, never export retained app state. */
export async function buildOfflineInvitation(input) {
    const { profile, bootstrap } = await verifiedBootstrapBinding(input.space, input.frames);
    const exported = JSON.parse(await buildSpaceFramesExport({ space: input.space,
        rootPublicKey: profile.root, frames: input.frames,
        verify: async (frame) => (await verifyCarrierOp(frame, verifier)).valid }));
    const text = canonical({ format: OFFLINE_INVITATION_FORMAT, product: "treehouse",
        space: input.space, spaceRoot: profile.root, bootstrapId: bootstrap.id,
        invitationId: input.invitationId, recipient: input.recipient,
        profiles: [{ product: "Treehouse.Space", replica: input.space, frames: exported.frames }] });
    await reviewOfflineInvitation(encoder.encode(text), input.recipient);
    return text;
}
/** Bound bytes before parsing; exact re-encoding rejects duplicate keys, extra fields and alternate spellings. */
export async function reviewOfflineInvitation(bytes, recipient) {
    try {
        if (bytes.byteLength > OFFLINE_EVIDENCE_MAX_BYTES)
            return refuse();
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const doc = JSON.parse(text);
        if (!closed(doc, fields) || doc.format !== OFFLINE_INVITATION_FORMAT || doc.product !== "treehouse" ||
            typeof doc.space !== "string" || typeof doc.spaceRoot !== "string" || typeof doc.bootstrapId !== "string" ||
            typeof doc.invitationId !== "string" || doc.recipient !== recipient ||
            !Array.isArray(doc.profiles) || doc.profiles.length !== 1 || canonical(doc) !== text)
            return refuse();
        const raw = doc.profiles[0];
        if (!closed(raw, ["frames", "product", "replica"]) || raw.product !== "Treehouse.Space" || raw.replica !== doc.space ||
            !Array.isArray(raw.frames) || raw.frames.length < 1 || raw.frames.length > 4000)
            return refuse();
        const frames = raw.frames.map((value) => {
            if (!closed(value, frameFields))
                return refuse();
            const frame = decodeCarrierOpFrame(value);
            if (frame.replica !== doc.space || canonical(frame.deps) !== canonical([...new Set(frame.deps)].sort()) ||
                encoder.encode(JSON.stringify({ type: "push", ops: [frame] })).length > 64000)
                return refuse();
            return frame;
        });
        const { profile, bootstrap, ops, view } = await verifiedBootstrapBinding(doc.space, frames);
        if (profile.root !== doc.spaceRoot || bootstrap.id !== doc.bootstrapId)
            return refuse();
        const invitation = reviewTreehouseInvitation({ replica: doc.space, frames, invitationId: doc.invitationId, recipient });
        if (!invitation.ok || invitation.threads.length !== 1 || frames.find(frame => frame.id === doc.invitationId)?.author !== profile.root)
            return refuse();
        // Rebuild terms/order as BEAM does. Authentic but noncanonical term spellings do not survive.
        const exported = JSON.parse(await buildSpaceFramesExport({ space: doc.space, rootPublicKey: profile.root, frames,
            verify: async (frame) => (await verifyCarrierOp(frame, verifier)).valid }));
        if (canonical(exported.frames) !== canonical(raw.frames))
            return refuse();
        const fingerprint = await treehouseGroupFingerprint(doc.space, doc.spaceRoot, doc.bootstrapId);
        const threadTitles = view.state.threads
            .filter(thread => invitation.threads.includes(thread.replica));
        return { space: doc.space, spaceRoot: doc.spaceRoot, name: String(view.state.name), threadTitles, bootstrapId: doc.bootstrapId,
            invitationId: doc.invitationId, recipient, threads: invitation.threads, fingerprint, frames, text };
    }
    catch {
        return refuse();
    }
}
/** Public provisioning candidate; the Linux importer independently verifies its ceremony and full staging policy. */
export async function buildInitialProvisioningBundle(input) {
    try {
        return await initialProvisioningBundle(input);
    }
    catch {
        throw new Error("invalid_initial_provisioning");
    }
}
async function initialProvisioningBundle(input) {
    const snapshot = structuredClone(input);
    const profiles = await Promise.all([
        { product: "Treehouse.Space", replica: snapshot.space, frames: snapshot.spaceFrames },
        { product: "Treehouse.Thread", replica: snapshot.thread, frames: snapshot.threadFrames },
    ].map(async (profile) => {
        const resolved = await resolveContinuationProfileFromFrames({ replica: profile.replica, frames: profile.frames });
        if (!resolved.ok)
            return refuse();
        const exported = JSON.parse(await buildSpaceFramesExport({ space: profile.replica, rootPublicKey: resolved.root,
            frames: profile.frames, verify: async (frame) => (await verifyCarrierOp(frame, verifier)).valid }));
        return { product: profile.product, replica: profile.replica, frames: exported.frames };
    }));
    if (profiles[0].frames.length + profiles[1].frames.length > 4000)
        return refuse();
    const { profile: spaceProfile, bootstrap, ops: spaceOps, view } = await verifiedBootstrapBinding(snapshot.space, profiles[0].frames);
    const references = spaceOps.filter(op => op.command === "create_thread" && !view.quarantineReasons.has(op.id));
    const members = view.state.members;
    if (references.length !== 1 || references[0].commandArgs?.[0] !== snapshot.thread ||
        members.length !== 2 || !members.includes(bootstrap.record.spaceRoot))
        return refuse();
    const threadOps = carrierOpsToSemanticOps(profiles[1].frames, {}, treehouseCommandDecoders("Treehouse.Thread"));
    const threadView = observeTreehouse("Treehouse.Thread", threadOps);
    if (threadView.quarantineReasons.size || threadOps.some(op => op.kind === "tombstone"))
        return refuse();
    const child = await resolveContinuationProfileFromFrames({ replica: snapshot.thread, frames: profiles[1].frames });
    if (!child.ok || continuationFamily(snapshot.thread) !== "thread" || child.profile.kind !== "thread" ||
        child.profile.role !== "moderator" || child.root === spaceProfile.root ||
        [child.root, spaceProfile.root, ...members].includes(bootstrap.record.serviceKey))
        return refuse();
    const genesis = threadOps.filter(op => op.authority?.type === "genesis" && op.deps.length === 0 && op.authorPubkey === child.root);
    const creation = threadOps.filter(op => op.command === "create_thread");
    if (genesis.length !== 1 || genesis[0].authority?.type !== "genesis" || creation.length !== 1 ||
        creation[0].commandArgs?.[0] !== references[0].commandArgs?.[1])
        return refuse();
    const rootGrant = genesis[0].authority.delegation.id;
    const rootFrame = profiles[1].frames.find(frame => frame.id === genesis[0].id);
    if (rootFrame.body[0] !== "tuple" || canonical(rootFrame.body[1][2]) !== canonical(["map", []]))
        return refuse();
    const grants = threadOps.filter(op => op.authority?.type === "grant");
    const live = new Map(liveTreehouseDelegations("Treehouse.Thread", profiles[1].frames, snapshot.thread).map(grant => [grant.id, grant]));
    const recipients = [];
    for (const op of grants) {
        if (op.authority?.type !== "grant")
            return refuse();
        const grant = live.get(op.authority.delegation.id);
        if (!grant || grant.issuer !== child.root || grant.parent_id !== rootGrant || grant.live || grant.roles.length ||
            canonical([...grant.ops].sort()) !== canonical(["author_edit", "author_tombstone", "post"]))
            return refuse();
        recipients.push(grant.audience);
    }
    if (canonical(recipients.sort()) !== canonical([...members].sort()))
        return refuse();
    const allowed = new Set([genesis[0].id, child.profileGenesis, ...grants.map(op => op.id)]);
    if (threadOps.some(op => op.kind === "authority" && !allowed.has(op.id)))
        return refuse();
    const pin = threadOps.find(op => op.id === child.profileGenesis);
    if (pin?.authority?.type !== "genesis" || canonical(pin.authority.beaconPolicy && { ...pin.authority.beaconPolicy, witnesses: [...pin.authority.beaconPolicy.witnesses].sort() }) !== canonical({ mode: "witnessed", version: 1,
        witnesses: [...child.profile.witnesses].sort(), threshold: child.profile.threshold, maxEpochStep: 1 }))
        return refuse();
    const text = canonical({ format: "treehouse-initial-provisioning-v1", product: "treehouse", space: snapshot.space,
        spaceRoot: bootstrap.record.spaceRoot, bootstrapId: bootstrap.id, referenceId: references[0].id, profiles });
    if (encoder.encode(text).length > OFFLINE_EVIDENCE_MAX_BYTES)
        return refuse();
    for (const participant of members) {
        const owned = participant === spaceProfile.root ? [participant, child.root] : [participant];
        const retained = profiles.map(profile => ({ ...profile, outbox: profile.frames.filter(frame => owned.includes(frame.author)).map(frame => frame.id), acked: [] }));
        const projected = { version: 2, product: "treehouse", revision: 0, publicKey: participant, profiles: retained,
            active: snapshot.thread, intent: null, clearedDrafts: {}, relay: null };
        if (encoder.encode(canonical(projected)).length > 1_048_576)
            return refuse();
    }
    return text;
}
