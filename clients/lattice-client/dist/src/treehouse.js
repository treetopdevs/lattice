import { ed25519 } from "@noble/curves/ed25519.js";
import { authorCarrierDelegation, authorCarrierOp, verifyCarrierOp } from "./codec";
import { base64ToBytes, canonicalTerm, carrierDelegationsFromFrames, carrierOpsToSemanticOps } from "./carrier";
import { compareUtf8 } from "./op";
import { authorTownshipGenesis, authorTownshipRevocation, townshipCapTerm } from "./township";
import { materialize } from "./materialize";
export const treehouseSpaceSchema = {
    name: "Treehouse.Space",
    fields: {
        name: { merge: "lww", default: "" }, members: { merge: "or_set" },
        threads: { merge: "or_set" }, invitations: { merge: "causal_list" },
        revoked_invitations: { merge: "or_set" }, membership_events: { merge: "causal_list" },
        admin_actions: { merge: "lww", gatedBy: "admin", default: null },
        moderator_actions: { merge: "lww", gatedBy: "moderator", default: null },
        admin: { authority: "admin" }, moderator: { authority: "moderator" },
    },
};
export const treehouseThreadSchema = {
    name: "Treehouse.Thread",
    fields: {
        title: { merge: "lww", default: "" }, posts: { merge: "causal_list" },
        moderation: { merge: "lww", gatedBy: "moderator", default: null },
        archived: { merge: "lww", gatedBy: "moderator", default: false },
        moderator: { authority: "moderator" },
    },
};
export function treehouseCommandBody(product, command) {
    let args;
    switch (command.command) {
        case "create_space":
            args = [command.name];
            break;
        case "create_thread":
            args = product === "Treehouse.Space" ? [command.threadReplica, command.title] : [command.title];
            break;
        case "issue_invitation":
            args = [command.recipient, command.threads];
            break;
        case "revoke_invitation":
            args = [command.invitationId];
            break;
        case "admit_member":
            args = [command.invitationId, command.recipient, command.level, command.acceptance];
            break;
        case "remove_member":
            args = [command.recipient];
            break;
        case "post":
            args = [command.text];
            break;
        case "author_edit":
            args = [command.postId, command.targetId, command.text];
            break;
        case "author_tombstone":
        case "moderator_tombstone":
            args = [command.postId, command.targetId];
            break;
        case "archive_thread":
            args = [];
            break;
    }
    // Authoring and decoding use exactly the same product command/argument table.
    if (!treehouseCommandDecoders(product).has(command.command))
        throw new Error("unknown Treehouse command");
    return ["tuple", [["atom", command.command], ["list", args.map(term)]]];
}
export function authorTreehouseCommand(input) {
    return authorCarrierOp({ replica: input.replica, deps: input.deps, signer: input.signer,
        kind: "command", cap: townshipCapTerm(input.capId), body: treehouseCommandBody(input.product, input.command) });
}
/** Observe retained semantic history; decoding must have used the Space product. */
export function treehouseSpaceInitialization(ops) {
    const projection = materialize(treehouseSpaceSchema, ops);
    const honored = ops.filter((op) => !projection.quarantineReasons.has(op.id));
    const roots = new Set(honored.filter((op) => op.kind === "authority" && op.authority?.type === "genesis").map((op) => op.id));
    if (honored.some((op) => op.kind === "command" && op.command === "create_space" && op.deps.length === 1 && roots.has(op.deps[0])))
        return "ready";
    return roots.size === 0 ? "uninitialized" : "incomplete";
}
/** Pure root-only preparation. Returned pending frames have not been persisted. */
export async function prepareTreehouseSpaceCreation(input) {
    const genesis = await authorTownshipGenesis({ replica: input.replica, signer: input.signer,
        ops: [...treehouseCommandDecoders("Treehouse.Space").keys()], roles: ["admin", "moderator"], policies: {} });
    const delegation = carrierDelegationsFromFrames([genesis])[0];
    const name = await authorTreehouseCommand({ product: "Treehouse.Space", replica: genesis.replica, deps: [genesis.id], signer: input.signer,
        capId: delegation.id, command: { command: "create_space", name: input.name } });
    const retained = input.retained ?? [];
    for (const frame of retained) {
        if (frame.replica !== genesis.replica)
            throw new Error("wrong_replica");
        const verified = await verifyCarrierOp(frame, { verify: async (pub, bytes, sig) => ed25519.verify(sig, bytes, base64ToBytes(pub), { zip215: false }) });
        if (!verified.valid)
            throw new Error("invalid_retained_frame");
    }
    const ids = new Set(retained.map((frame) => frame.id));
    if (retained.some((frame) => frame.deps.some((id) => !ids.has(id))))
        throw new Error("incomplete_retained_history");
    const ops = carrierOpsToSemanticOps(retained, {}, treehouseCommandDecoders("Treehouse.Space"));
    if (ops.some((op) => (op.kind === "authority" && op.authority?.type === "genesis" && op.id !== genesis.id) ||
        (op.kind === "command" && op.command === "create_space" && op.deps.length === 1 && op.deps[0] === genesis.id && op.id !== name.id)))
        throw new Error("different_initialization");
    return { replica: genesis.replica, profile: "legacy_root_only", status: treehouseSpaceInitialization(ops), pending: [genesis, name].filter((frame) => !ids.has(frame.id)) };
}
/** One existing authority transfer, preserving the parent's command/lease bounds. */
export async function authorTreehouseRoleTransfer(input) {
    const role = input.action === "transfer_admin" ? "admin" : "moderator";
    const delegation = await authorCarrierDelegation({ replica: input.replica, signer: input.signer, audiencePubkey: input.recipient,
        parentId: input.parent.id, ops: input.parent.ops, roles: [role],
        ...(input.parent.expires_epoch === undefined ? {} : { expiresEpoch: input.parent.expires_epoch }) });
    const frame = await authorCarrierOp({ replica: input.replica, deps: input.deps, signer: input.signer,
        kind: "authority", cap: ["nil"], body: ["tuple", [["atom", "transfer"], ["atom", role], ["delegation", delegation], ["int", 0]]] });
    return { frame, delegation };
}
/** Existing issuer-checked revocation, with no separate Treehouse grant primitive. */
export const authorTreehouseGrantRevocation = authorTownshipRevocation;
function term(value) {
    if (typeof value === "string")
        return ["bin", bytesBase64(new TextEncoder().encode(value))];
    if (Array.isArray(value))
        return ["list", value.map(term)];
    throw new Error("Treehouse arguments must be text or a text list");
}
function value(term) {
    if (term !== null && typeof term === "object" && term.type === "bin") {
        return new TextDecoder("utf-8", { fatal: true }).decode(term.bytes);
    }
    if (term !== null && typeof term === "object" && term.type === "list")
        return term.values.map(value);
    throw new Error("malformed Treehouse argument");
}
function text(value) {
    if (typeof value !== "string")
        throw new Error("Treehouse argument must be text");
    return value;
}
function texts(value) {
    if (!Array.isArray(value))
        throw new Error("Thread scope must be a text list");
    return value.map(text);
}
function reference(value) {
    if (text(value) === "")
        throw new Error("Thread reference is empty");
    return value;
}
function recipient(value) {
    if (canonicalBytes(value, 32) === null)
        throw new Error("recipient is not a canonical public key");
    return value;
}
function effect(field, mutation, value) {
    return { field, mutation, value };
}
function decoder(arity, command, effects) {
    return { arity, decode: (raw) => {
            const args = raw.map(value);
            const complete = effects(args);
            const first = complete[0] ?? effect("__authority", "write", null);
            return { ...first, command, effects: complete, commandArgs: args };
        } };
}
/** Explicit injection keeps Treehouse command names independent of Township. */
export function treehouseCommandDecoders(product) {
    if (product === "Treehouse.Thread")
        return Object.assign(new Map([
            ["create_thread", decoder(1, "create_thread", ([title]) => [effect("title", "write", text(title)), effect("moderation", "write", "create_thread")])],
            ["post", decoder(1, "post", ([body]) => [effect("posts", "append", text(body))])],
            ["author_edit", decoder(3, "author_edit", ([post, target, body]) => { text(target); return [effect("posts", "edit", { target: text(post), value: text(body) })]; })],
            ["author_tombstone", decoder(2, "author_tombstone", ([post, target]) => { text(target); return [effect("posts", "delete", text(post))]; })],
            ["moderator_tombstone", decoder(2, "moderator_tombstone", ([post, target]) => { text(target); return [effect("posts", "delete", text(post)), effect("moderation", "write", post)]; })],
            ["archive_thread", decoder(0, "archive_thread", () => [effect("archived", "write", true)])],
        ]), { product });
    if (product !== "Treehouse.Space")
        throw new Error("unknown Treehouse product");
    const admin = (command) => effect("admin_actions", "write", command);
    return Object.assign(new Map([
        ["create_space", decoder(1, "create_space", ([name]) => [effect("name", "write", text(name)), admin("create_space")])],
        ["create_thread", decoder(2, "create_thread", ([replica, title]) => [effect("threads", "add", { replica: reference(replica), title: text(title) }), admin("create_thread")])],
        ["issue_invitation", decoder(2, "issue_invitation", ([recipient, threads]) => [effect("invitations", "append", { recipient: text(recipient), threads: texts(threads) }), admin("issue_invitation")])],
        ["revoke_invitation", decoder(1, "revoke_invitation", ([id]) => [effect("revoked_invitations", "add", text(id)), admin("revoke_invitation")])],
        ["admit_member", decoder(4, "admit_member", ([invitation, recipient, level, acceptance]) => {
                [invitation, recipient, level, acceptance].forEach(text);
                return [effect("members", "add", recipient), effect("membership_events", "append", { action: "admit", invitation, level, recipient }), admin("admit_member")];
            })],
        ["remove_member", decoder(1, "remove_member", ([member]) => [effect("members", "remove", recipient(member)), effect("membership_events", "append", { action: "remove", recipient: member }), admin("remove_member")])],
    ]), { product });
}
export function treehouseInvitationAcceptanceBytes(replica, invitation) {
    if (invitation.command !== "issue_invitation" || invitation.commandArgs?.length !== 2)
        throw new Error("not an invitation");
    return canonicalTerm(["treehouse-invitation-acceptance-v1", replica, invitation.id, ...invitation.commandArgs]);
}
export async function acceptTreehouseInvitation(replica, invitation, signer) {
    return bytesBase64(await signer.sign(treehouseInvitationAcceptanceBytes(replica, invitation)));
}
const honored = (context, op) => context.verdicts.get(op.id) === "honored";
const refused = (reason) => ({ ok: false, reason });
const allowed = { ok: true };
export function treehouseCommandOpStatus(schema, op, visible, context) {
    if (op.kind !== "command")
        return allowed;
    return schema.name === "Treehouse.Thread" ? threadStatus(op, visible, context) : spaceStatus(op, visible, context);
}
function archiveStatus(context) {
    return [...context.visibleOps.values()].some((op) => op.kind === "command" && op.command === "archive_thread" && honored(context, op))
        ? refused("application_archived_thread") : allowed;
}
function threadStatus(op, visible, context) {
    if (op.command === "post")
        return archiveStatus(context);
    if (!["author_edit", "author_tombstone", "moderator_tombstone"].includes(op.command ?? ""))
        return allowed;
    const [post, target] = op.commandArgs;
    const targets = new Set([post]);
    let next = target;
    while (!targets.has(next)) {
        targets.add(next);
        const prior = context.visibleOps.get(next);
        if (prior?.kind !== "command" || prior.command !== "author_edit" || prior.commandArgs?.[0] !== post)
            break;
        next = prior.commandArgs[1];
    }
    if ([...targets].some((id) => !visible.has(id)))
        return refused("application_target_not_visible");
    if ([...targets].some((id) => context.verdicts.get(id) !== "honored"))
        return refused("application_target_quarantined");
    const original = context.visibleOps.get(post);
    if (original.replica !== op.replica || original.kind !== "command" || original.command !== "post" ||
        [...targets].some((id) => { const prior = context.visibleOps.get(id); return id !== post && (prior.replica !== op.replica || prior.kind !== "command" || prior.command !== "author_edit" || prior.commandArgs?.[0] !== post); }))
        return refused("application_wrong_target");
    if (op.command !== "moderator_tombstone" && (original.authorPubkey ?? original.author) !== (op.authorPubkey ?? op.author))
        return refused("application_wrong_author");
    if ([...context.visibleOps.values()].some((prior) => prior.kind === "command" && ["author_tombstone", "moderator_tombstone"].includes(prior.command ?? "") && prior.commandArgs?.[0] === post && honored(context, prior)))
        return refused("application_already_tombstoned");
    return op.command === "moderator_tombstone" ? allowed : archiveStatus(context);
}
function canonicalBytes(value, size) {
    try {
        if (typeof value !== "string")
            return null;
        const bytes = base64ToBytes(value);
        return bytes.length === size && bytesBase64(bytes) === value ? bytes : null;
    }
    catch {
        return null;
    }
}
function bytesBase64(bytes) {
    if (typeof Buffer !== "undefined")
        return Buffer.from(bytes).toString("base64");
    const encode = globalThis.btoa;
    if (encode === undefined)
        throw new Error("base64 encoding unavailable");
    return encode(String.fromCharCode(...bytes));
}
function spaceStatus(op, visible, context) {
    const threadScope = [...new Set([...context.visibleOps.values()].filter((prior) => prior.kind === "command" && prior.command === "create_thread" && honored(context, prior)).map((prior) => prior.commandArgs[0]))].sort(compareUtf8);
    const sameScope = (scope) => JSON.stringify(scope) === JSON.stringify(threadScope);
    if (op.command === "issue_invitation") {
        return canonicalBytes(op.commandArgs?.[0], 32) !== null && sameScope(op.commandArgs?.[1]) ? allowed : refused("application_invalid_invitation");
    }
    if (op.command !== "admit_member" && op.command !== "revoke_invitation")
        return allowed;
    const [id, recipient, level, signature] = op.commandArgs;
    if (!visible.has(id))
        return refused("application_target_not_visible");
    if (context.verdicts.get(id) !== "honored")
        return refused("application_target_quarantined");
    const invite = context.visibleOps.get(id);
    if (invite.replica !== op.replica || invite.kind !== "command" || invite.command !== "issue_invitation")
        return refused("application_wrong_target");
    if (op.command === "revoke_invitation")
        return allowed;
    if (invite.commandArgs?.[0] !== recipient || !["member", "moderator"].includes(level) || !sameScope(invite.commandArgs[1]) ||
        [...context.visibleOps.values()].some((prior) => prior.kind === "command" && prior.command === "revoke_invitation" && prior.commandArgs?.[0] === id && honored(context, prior)))
        return refused("application_invalid_invitation");
    const pub = canonicalBytes(recipient, 32);
    const sig = canonicalBytes(signature, 64);
    try {
        return pub !== null && sig !== null && ed25519.verify(sig, treehouseInvitationAcceptanceBytes(op.replica, invite), pub, { zip215: false }) ? allowed : refused("application_invalid_invitation");
    }
    catch {
        return refused("application_invalid_invitation");
    }
}
