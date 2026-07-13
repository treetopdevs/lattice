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
            delegation.issuerRealm === op.author);
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
function subset(child, parent) {
    const parentSet = new Set(parent);
    return child.every((value) => parentSet.has(value));
}
function delegationKey(delegation) {
    return JSON.stringify({
        ...delegation,
        ops: [...delegation.ops].sort(),
        roles: [...delegation.roles].sort(),
    });
}
