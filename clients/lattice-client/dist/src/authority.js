import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalBytesForCarrierDelegation } from "./codec";
import { ancestors } from "./dag";
import { isAuthorityField } from "./schema";
/**
 * Decide which role-holder writes are honored from their causal position.
 * Multi-write histories without complete authority evidence remain fail-closed.
 */
export function analyzeAuthority(schema, ops, included, order, byId) {
    const visible = order.map((id) => byId.get(id));
    const writesPerRole = new Map();
    for (const op of visible) {
        if (!authorityRoleWrite(schema, op))
            continue;
        writesPerRole.set(op.field, (writesPerRole.get(op.field) ?? 0) + 1);
    }
    const delegations = collectDelegations(visible);
    const delegationValidity = new Map();
    const states = new Map();
    const honoredWrites = new Set();
    const quarantinedWrites = new Set();
    for (const op of visible) {
        if (!authorityRoleWrite(schema, op))
            continue;
        const writeCount = writesPerRole.get(op.field) ?? 0;
        if (op.authority === undefined) {
            if (writeCount > 1)
                throw new Error(`missing authority evidence for ${op.id}`);
            honoredWrites.add(op.id);
            continue;
        }
        const state = states.get(op.field) ?? { holder: null, acquires: [] };
        const honored = authorityWriteHonored(op, op.authority, state, delegations, delegationValidity, byId);
        if (honored) {
            const holder = op.authority.delegation.audienceRealm;
            state.holder = holder;
            state.acquires.push({ opId: op.id, holder });
            states.set(op.field, state);
            honoredWrites.add(op.id);
        }
        else {
            quarantinedWrites.add(op.id);
        }
    }
    for (const op of ops) {
        if (!included.has(op.id))
            continue;
        if (!authorityRoleWrite(schema, op))
            continue;
        if (!honoredWrites.has(op.id) && !quarantinedWrites.has(op.id)) {
            throw new Error(`authority write ${op.id} was not decided`);
        }
    }
    return { honoredWrites, quarantinedWrites };
}
function authorityRoleWrite(schema, op) {
    if (op.kind !== "authority" || op.mutation !== "write")
        return false;
    const spec = schema.fields[op.field];
    return spec !== undefined && isAuthorityField(spec);
}
function authorityWriteHonored(op, evidence, state, delegations, delegationValidity, byId) {
    const delegation = evidence.delegation;
    if (delegation.audienceRealm !== op.value ||
        !delegation.roles.includes(op.field) ||
        !validDelegation(delegation, delegations, delegationValidity, new Set())) {
        return false;
    }
    if (evidence.type === "genesis") {
        return (state.holder === null &&
            delegation.parentId === null &&
            delegation.issuer === delegation.audience &&
            delegation.issuerRealm === op.author &&
            op.replica !== undefined &&
            replicaRootMatches(op.replica, delegation.audience));
    }
    if (evidence.type !== "transfer" || evidence.role !== op.field) {
        throw new Error(`unsupported authority event ${evidence.type} for ${op.id}`);
    }
    const visible = ancestors(op.id, byId);
    const holderAtDeps = [...state.acquires]
        .reverse()
        .find((acquire) => visible.has(acquire.opId))?.holder;
    return (delegation.issuerRealm === op.author &&
        holderAtDeps === op.author &&
        state.holder === op.author);
}
function collectDelegations(ops) {
    const delegations = new Map();
    for (const op of ops) {
        const delegation = op.authority?.delegation;
        if (!delegation)
            continue;
        const existing = delegations.get(delegation.id);
        if (existing === undefined) {
            delegations.set(delegation.id, delegation);
        }
        else if (existing === null || delegationKey(existing) !== delegationKey(delegation)) {
            delegations.set(delegation.id, null);
        }
    }
    return delegations;
}
function validDelegation(delegation, delegations, cache, visiting) {
    if (!delegationSelfConsistent(delegation)) {
        cache.set(delegation.id, false);
        return false;
    }
    const cached = cache.get(delegation.id);
    if (cached !== undefined)
        return cached;
    const collected = delegations.get(delegation.id);
    if (collected === undefined || collected === null || delegationKey(collected) !== delegationKey(delegation)) {
        cache.set(delegation.id, false);
        return false;
    }
    if (visiting.has(delegation.id))
        return false;
    visiting.add(delegation.id);
    let valid;
    if (delegation.parentId === null) {
        valid = delegation.issuer === delegation.audience;
    }
    else {
        const parent = delegations.get(delegation.parentId);
        valid =
            parent !== undefined &&
                parent !== null &&
                validDelegation(parent, delegations, cache, visiting) &&
                delegation.issuer === parent.audience &&
                delegation.replica === parent.replica &&
                subset(delegation.ops, parent.ops) &&
                subset(delegation.roles, parent.roles) &&
                (!delegation.live || parent.live);
    }
    visiting.delete(delegation.id);
    cache.set(delegation.id, valid);
    return valid;
}
function delegationSelfConsistent(delegation) {
    if (delegation.sig === undefined)
        return false;
    try {
        const canonicalBytes = canonicalBytesForCarrierDelegation({
            replica: delegation.replica,
            issuer: delegation.issuer,
            audience: delegation.audience,
            parent_id: delegation.parentId,
            ops: delegation.ops,
            roles: delegation.roles,
            live: delegation.live,
        });
        return (bytesToBase64Url(sha256(canonicalBytes)) === delegation.id &&
            ed25519.verify(base64ToBytes(delegation.sig), canonicalBytes, base64ToBytes(delegation.issuer), { zip215: false }));
    }
    catch {
        return false;
    }
}
function subset(child, parent) {
    const parentSet = new Set(parent);
    return child.every((value) => parentSet.has(value));
}
function replicaRootMatches(replica, audience) {
    const commitment = replicaRootCommitment(replica);
    return commitment === null || bytesToBase64Url(sha256(base64ToBytes(audience))) === commitment;
}
function replicaRootCommitment(replica) {
    const marker = "#root:";
    const offset = replica.indexOf(marker);
    if (offset === -1)
        return null;
    const commitment = replica.slice(offset + marker.length);
    return commitment.length > 0 ? commitment : null;
}
function base64ToBytes(value) {
    if (typeof Buffer !== "undefined")
        return new Uint8Array(Buffer.from(value, "base64"));
    const atobFn = globalThis.atob;
    if (!atobFn)
        throw new Error("base64 decoding unavailable");
    return Uint8Array.from(atobFn(value), (char) => char.charCodeAt(0));
}
function bytesToBase64Url(value) {
    const base64 = typeof Buffer !== "undefined"
        ? Buffer.from(value).toString("base64")
        : browserBase64(value);
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function browserBase64(value) {
    const btoaFn = globalThis.btoa;
    if (!btoaFn)
        throw new Error("base64 encoding unavailable");
    return btoaFn(String.fromCharCode(...value));
}
function delegationKey(delegation) {
    return JSON.stringify({
        ...delegation,
        ops: [...delegation.ops].sort(),
        roles: [...delegation.roles].sort(),
    });
}
