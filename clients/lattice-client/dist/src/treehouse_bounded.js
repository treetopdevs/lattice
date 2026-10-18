// Bounded-family Treehouse Space creation, the root's empty-delegation continuation pin,
// and the catalog bootstrap binding. Reuses the existing authority arms only (decision D4):
// nothing here adds a TypeScript authority rule. A "pinned" continuation is only that.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { authorCarrierDelegation, authorCarrierOp, canonicalBase64Bytes, canonicalBytesForCarrierTerm, verifyCarrierOp } from "./codec";
import { base64ToBytes, carrierDelegationsFromFrames, carrierOpsToSemanticOps, decodeCarrierOpFrame } from "./carrier";
import { canonicalOrder, index } from "./dag";
import { compareUtf8 } from "./op";
import { frontier } from "./sync";
import { materialize } from "./materialize";
import { bindTownshipReplica, authorTownshipGenesis } from "./township";
import { continuationFamily, continuationProfileBindingMatches, resolveContinuationProfileFromFrames } from "./authority";
import { continuationProfileId, continuationProfileToCarrierTerm, normalizeContinuationProfile } from "./continuation";
import { authorTreehouseCommand, treehouseCatalogBootstrapsFromFrames, treehouseCommandDecoders, treehouseSpaceInitialization, treehouseSpaceSchema } from "./treehouse";
import { catalogBootstrapToCarrierTerm, normalizeCatalogBootstrap } from "./treehouse_catalog_codec";
const AUTHORITY_SEGMENT = "#authority:bounded-continuation-v1";
const NONCE_REPLICA = /^replica:treehouse:space:([A-Za-z0-9_-]{43})$/;
const PAYLOAD_FORMAT = "lattice-catalog-bootstrap-payload-v1";
/** The root's capability set is final at birth; the pin adds none. */
export const treehouseBoundedGenesisOps = [
    "create_space", "create_thread", "issue_invitation", "revoke_invitation", "admit_member", "remove_member",
    "catalog_bootstrap_v1", "attest_member_key_v1", "replace_catalog_v1",
];
const verifier = { verify: async (pub, bytes, sig) => ed25519.verify(sig, bytes, base64ToBytes(pub), { zip215: false }) };
// No Node Buffer: this module also runs in the webview.
const bytesToB64 = (bytes) => {
    let binary = "";
    for (const byte of bytes)
        binary += String.fromCharCode(byte);
    return btoa(binary);
};
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const keyB64 = (key) => typeof key === "string" ? key : bytesToB64(key);
/** Legacy replicas keep their old grammar; only the exact bounded Space grammar is "bounded". */
export function treehouseSpaceFamily(replica) {
    const family = continuationFamily(replica);
    if (family === "legacy")
        return "legacy";
    return family === "space" ? "bounded" : "unsupported";
}
/** Pure root-only preparation of a bounded-family Space. Returned pending frames are not persisted. */
export async function prepareTreehouseBoundedSpaceCreation(input) {
    const nonce = NONCE_REPLICA.exec(input.replica)?.[1];
    if (nonce === undefined || canonicalBase64Bytes(`${nonce.replaceAll("-", "+").replaceAll("_", "/")}=`, 32) === null) {
        throw new Error("invalid_replica");
    }
    const bound = await bindTownshipReplica(input.replica + AUTHORITY_SEGMENT, input.signer.publicKey);
    const genesis = await authorTownshipGenesis({ replica: bound, signer: input.signer,
        ops: [...treehouseBoundedGenesisOps], roles: ["admin", "moderator"], policies: {} });
    const delegation = carrierDelegationsFromFrames([genesis])[0];
    const created = await authorTreehouseCommand({ product: "Treehouse.Space", replica: genesis.replica, deps: [genesis.id],
        signer: input.signer, capId: delegation.id, command: { command: "create_space", name: input.name } });
    const retained = input.retained ?? [];
    for (const frame of retained) {
        if (frame.replica !== genesis.replica)
            throw new Error("wrong_replica");
        if (!(await verifyCarrierOp(frame, verifier)).valid)
            throw new Error("invalid_retained_log");
    }
    const ids = new Set(retained.map((frame) => frame.id));
    if (ids.size !== retained.length)
        throw new Error("invalid_retained_log");
    if (retained.some((frame) => frame.deps.some((id) => !ids.has(id))))
        throw new Error("invalid_retained_log");
    const ops = carrierOpsToSemanticOps(retained, {}, treehouseCommandDecoders("Treehouse.Space"));
    // A later root continuation pin (empty, non-live, parentless delegation with a valid profile) is not a competing initialization.
    const signer = bytesToB64(input.signer.publicKey);
    const pins = new Set(retained.filter((frame) => {
        const delegation = carrierDelegationsFromFrames([frame])[0];
        const op = ops.find((o) => o.id === frame.id);
        return frame.kind === "authority" && frame.author === signer && op?.authority?.type === "genesis" &&
            op.authority.continuationProfile !== null && delegation !== undefined && !delegation.live &&
            delegation.parent_id === null && delegation.ops.length === 0 && delegation.roles.length === 0;
    }).map((frame) => frame.id));
    if (ops.some((op) => (op.kind === "authority" && op.authority?.type === "genesis" && op.id !== genesis.id && !pins.has(op.id)) ||
        (op.kind === "command" && op.command === "create_space" && op.deps.length === 1 && op.deps[0] === genesis.id && op.id !== created.id))) {
        throw new Error("different_initialization");
    }
    return { replica: genesis.replica, profile: "bounded_root_only", status: treehouseSpaceInitialization(ops),
        pending: [genesis, created].filter((frame) => !ids.has(frame.id)) };
}
async function verifiedHistory(replica, input) {
    try {
        const frames = structuredClone([...input]).map(decodeCarrierOpFrame);
        const ids = new Set(frames.map((frame) => frame.id));
        if (ids.size !== frames.length || frames.some((frame) => frame.replica !== replica || frame.deps.some((dep) => !ids.has(dep)))) {
            throw new Error("invalid_verified_history");
        }
        for (const frame of frames)
            if (!(await verifyCarrierOp(frame, verifier)).valid)
                throw new Error("invalid_verified_history");
        const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"));
        const byId = index(ops);
        if (ops.length !== frames.length || canonicalOrder(ops, byId).length !== ops.length)
            throw new Error("invalid_verified_history");
        return { frames, ops, frontier: frontier(ops).sort(compareUtf8) };
    }
    catch {
        throw new Error("invalid_verified_history");
    }
}
function replicaOf(frames) {
    const replica = frames[0]?.replica;
    if (typeof replica !== "string")
        throw new Error("invalid_verified_history");
    return replica;
}
async function signerIsRoot(replica, signer) {
    return replica === await bindTownshipReplica(replica.slice(0, replica.indexOf("#root:")), signer.publicKey);
}
/**
 * The selected pin of a complete, already-authenticated Space history. This does not verify
 * signatures; callers that need authentication use the verified authoring and review functions.
 */
export function treehouseContinuationPin(frames) {
    const none = { configured: false };
    try {
        const replica = replicaOf(frames);
        if (treehouseSpaceFamily(replica) !== "bounded")
            return none;
        const decoded = structuredClone(frames).map(decodeCarrierOpFrame);
        const ops = carrierOpsToSemanticOps(decoded, {}, treehouseCommandDecoders("Treehouse.Space"));
        const byId = index(ops), order = canonicalOrder(ops, byId);
        if (order.length !== ops.length)
            return none;
        for (const id of [...order].reverse()) {
            const op = byId.get(id);
            const profile = op.kind === "authority" && op.authority?.type === "genesis" ? normalizeContinuationProfile(op.authority.continuationProfile) : null;
            if (profile === null || op.authorPubkey === undefined)
                continue;
            const profileId = continuationProfileId(profile);
            if (profileId !== null && continuationProfileBindingMatches(replica, ops, op.authorPubkey, id, profileId)) {
                return { configured: true, profileGenesis: id, profileId, profile, root: op.authorPubkey };
            }
        }
        return none;
    }
    catch {
        return none;
    }
}
/** One root-signed pin: an empty, non-live delegation carrying the `__continuation__` profile. */
export async function authorTreehouseContinuationPin(input) {
    const replica = replicaOf(input.frames);
    if (treehouseSpaceFamily(replica) !== "bounded")
        throw new Error("not_bounded_space");
    const history = await verifiedHistory(replica, input.frames);
    if (treehouseSpaceInitialization(history.ops) !== "ready")
        throw new Error("space_not_ready");
    if (!(await signerIsRoot(replica, input.signer)))
        throw new Error("not_root");
    if (treehouseContinuationPin(history.frames).configured)
        throw new Error("continuation_already_pinned");
    const profile = normalizeContinuationProfile({ mode: "bounded_continuation", version: 1, product: "treehouse",
        kind: "space", role: "admin", nominee: keyB64(input.nominee), witnesses: input.witnesses.map(keyB64),
        threshold: input.threshold, maxLeaseEpochs: input.maxLeaseEpochs });
    const term = profile === null ? null : continuationProfileToCarrierTerm(profile);
    if (profile === null || term === null)
        throw new Error("invalid_continuation_profile");
    const root = bytesToB64(input.signer.publicKey);
    if (profile.nominee === root)
        throw new Error("nominee_is_root");
    if (profile.witnesses.includes(root))
        throw new Error("witness_is_root");
    if (profile.witnesses.includes(profile.nominee))
        throw new Error("witness_is_nominee");
    const delegation = await authorCarrierDelegation({ replica, audiencePubkey: input.signer.publicKey, parentId: null,
        ops: [], roles: [], live: false, signer: input.signer });
    return authorCarrierOp({ replica, deps: history.frontier, kind: "authority", signer: input.signer, cap: ["nil"],
        body: ["tuple", [["atom", "genesis"], ["delegation", delegation], ["map", [[["atom", "__continuation__"], term]]]]] });
}
const FIELDS = ["version", "product", "space", "space_root", "profile_genesis", "profile_id", "replacement_rule",
    "catalog_key", "service_id", "service_key", "origin", "nonce"];
const CAMEL = {
    version: "version", product: "product", space: "space", space_root: "spaceRoot", profile_genesis: "profileGenesis",
    profile_id: "profileId", replacement_rule: "replacementRule", catalog_key: "catalogKey", service_id: "serviceId",
    service_key: "serviceKey", origin: "origin", nonce: "nonce",
};
const BASE64_FIELDS = new Set(["space_root", "catalog_key", "service_key"]);
function decodePayload(text) {
    try {
        const payload = JSON.parse(text);
        if (payload === null || typeof payload !== "object" || Array.isArray(payload) || payload.format !== PAYLOAD_FORMAT ||
            Object.keys(payload).sort().join() !== ["canonical_base64", "format", "record", "record_encoding", "sha256"].join() ||
            typeof payload.canonical_base64 !== "string" || typeof payload.sha256 !== "string")
            return null;
        const json = payload.record;
        if (json === null || typeof json !== "object" || Array.isArray(json) ||
            Object.keys(json).sort().join() !== [...FIELDS].sort().join())
            return null;
        const out = {};
        for (const field of FIELDS) {
            const value = json[field];
            if (BASE64_FIELDS.has(field)) {
                if (canonicalBase64Bytes(value, 32) === null)
                    return null;
            }
            else if (field === "product") {
                if (value !== "treehouse")
                    return null;
            }
            else if (field === "replacement_rule") {
                if (value !== "bounded_space_admin_v1")
                    return null;
            }
            else if (field === "version") {
                if (value !== 1)
                    return null;
            }
            else if (typeof value !== "string")
                return null;
            out[CAMEL[field]] = value;
        }
        const record = normalizeCatalogBootstrap(out);
        return record === null ? null : { record, canonical: payload.canonical_base64, sha: payload.sha256 };
    }
    catch {
        return null;
    }
}
const encodeRecord = (record) => {
    const term = catalogBootstrapToCarrierTerm(record);
    if (term === null)
        return null;
    const bytes = canonicalBytesForCarrierTerm(term);
    return { canonical: bytesToB64(bytes), sha: hex(sha256(bytes)) };
};
/** Strict review of a ceremony `binding-payload.json` against the Space it will be signed into. */
export async function reviewTreehouseCatalogBindingPayload(input) {
    const refuse = (reason) => ({ ok: false, reason });
    const decoded = decodePayload(input.payloadText);
    if (decoded === null)
        return refuse("malformed_payload");
    const encoded = encodeRecord(decoded.record);
    if (encoded === null)
        return refuse("malformed_payload");
    if (encoded.canonical !== decoded.canonical || encoded.sha !== decoded.sha)
        return refuse("payload_digest_mismatch");
    const { record } = decoded;
    if (record.space !== input.replica)
        return refuse("wrong_space");
    if (record.spaceRoot !== input.rootPublicKey)
        return refuse("not_root");
    if (treehouseSpaceFamily(input.replica) !== "bounded")
        return refuse("not_bounded_space");
    if (record.catalogKey === record.spaceRoot || record.serviceKey === record.spaceRoot)
        return refuse("binding_key_reuse");
    const resolved = await resolveContinuationProfileFromFrames({ replica: input.replica, frames: input.frames });
    if (!resolved.ok)
        return refuse("continuation_not_configured");
    if (resolved.root !== record.spaceRoot)
        return refuse("not_root");
    let ops;
    try {
        ops = (await verifiedHistory(input.replica, input.frames)).ops;
    }
    catch {
        return refuse("continuation_not_configured");
    }
    if (resolved.profileGenesis !== record.profileGenesis || resolved.profileId !== record.profileId ||
        !continuationProfileBindingMatches(input.replica, ops, record.spaceRoot, record.profileGenesis, record.profileId)) {
        return refuse("binding_mismatch");
    }
    const existing = await treehouseCatalogBootstrapsFromFrames({ replica: input.replica, frames: input.frames });
    if (!existing.ok || existing.bootstraps.length > 0)
        return refuse(existing.ok ? "catalog_bootstrap_exists" : "continuation_not_configured");
    const lines = FIELDS.map((field) => ({ field, value: String(record[CAMEL[field]]) }));
    lines.push({ field: "canonical sha256", value: encoded.sha });
    return { ok: true, record, sha256: encoded.sha, lines };
}
/** The root's one-time catalog bootstrap command, depending on the sorted frontier (hence the pin). */
export async function authorTreehouseCatalogBootstrap(input) {
    const replica = replicaOf(input.frames);
    if (treehouseSpaceFamily(replica) !== "bounded")
        throw new Error("not_bounded_space");
    if (!(await signerIsRoot(replica, input.signer)))
        throw new Error("not_root");
    const resolved = await resolveContinuationProfileFromFrames({ replica, frames: input.frames });
    if (!resolved.ok)
        throw new Error(resolved.reason === "invalid_verified_history" ? "invalid_verified_history" : "continuation_not_configured");
    const record = normalizeCatalogBootstrap(input.record);
    if (record === null)
        throw new Error("invalid_catalog_bootstrap");
    if (record.space !== replica || record.spaceRoot !== bytesToB64(input.signer.publicKey) ||
        record.profileGenesis !== resolved.profileGenesis || record.profileId !== resolved.profileId)
        throw new Error("binding_mismatch");
    if (record.catalogKey === record.spaceRoot || record.serviceKey === record.spaceRoot)
        throw new Error("binding_key_reuse");
    const history = await verifiedHistory(replica, input.frames);
    const existing = await treehouseCatalogBootstrapsFromFrames({ replica, frames: input.frames });
    if (!existing.ok)
        throw new Error("invalid_verified_history");
    if (existing.bootstraps.length > 0)
        throw new Error("catalog_bootstrap_exists");
    const root = bytesToB64(input.signer.publicKey);
    // The first honored root admin genesis in canonical order, as `Treehouse.Space.root_capability/2` selects it.
    const byId = index(history.ops), quarantined = materialize(treehouseSpaceSchema, history.ops).quarantineReasons;
    let capId;
    for (const id of canonicalOrder(history.ops, byId)) {
        const frame = history.frames.find((f) => f.id === id);
        if (frame === undefined || frame.kind !== "authority" || frame.author !== root || quarantined.has(id))
            continue;
        // Genesis only, as Elixir matches `{:genesis, delegation, _}`: a grant or transfer carrying a root delegation is not the cap.
        const head = frame.body[0] === "tuple" ? frame.body[1][0] : undefined;
        if (head === undefined || head[0] !== "atom" || head[1] !== "genesis")
            continue;
        const found = carrierDelegationsFromFrames([frame]).find((d) => d.parent_id === null && d.issuer === root && d.roles.includes("admin") &&
            d.ops.includes("catalog_bootstrap_v1"));
        if (found !== undefined) {
            capId = found.id;
            break;
        }
    }
    if (capId === undefined)
        throw new Error("invalid_verified_history");
    return authorTreehouseCommand({ product: "Treehouse.Space", replica, deps: history.frontier, signer: input.signer,
        capId, command: { command: "catalog_bootstrap_v1", record } });
}
