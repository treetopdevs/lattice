import { ancestors } from "./dag";
import { gatedBy } from "./schema";
/**
 * The ONE quarantine predicate (V-01).
 *
 * An authority-gated command is quarantined iff, judged against the honored
 * acquire timeline for the gating role (the oracle's `holder_from_acquires`):
 *
 *   1. the last acquire visible from the command's deps does not name the
 *      command's author as holder (`:not_holder`), or
 *   2. the acquire immediately after the author's last visible acquire never
 *      saw the command — a concurrent away-move (`:stale_holder`).
 *
 * This is purely deps-decidable over the honored timeline, so it yields
 * identical quarantine sets on every realm (property d), and it is the SAME
 * function that answers both "stale holder" and "revocation" — there is no
 * second implementation to drift from it.
 */
export function isQuarantined(op, schema, byId, acquiresByRole, ancCache = new Map()) {
    const role = gatedBy(schema, op.field);
    if (!role)
        return { quarantined: false };
    const acquires = acquiresByRole.get(role) ?? [];
    const visible = ancestors(op.id, byId, ancCache);
    let holderAtDeps;
    let lastOwnIndex = -1;
    for (let i = 0; i < acquires.length; i++) {
        const acquire = acquires[i];
        if (!visible.has(acquire.opId))
            continue;
        holderAtDeps = acquire.holder;
        if (acquire.holder === op.author)
            lastOwnIndex = i;
    }
    if (holderAtDeps !== op.author) {
        return {
            quarantined: true,
            reason: `author ${op.author} is not current ${role} holder (${String(holderAtDeps)})`,
        };
    }
    const next = lastOwnIndex >= 0 ? acquires[lastOwnIndex + 1] : undefined;
    if (next !== undefined && !ancestors(next.opId, byId, ancCache).has(op.id)) {
        return {
            quarantined: true,
            reason: `author ${op.author} did not observe ${next.opId} — stale ${role} holder (now ${next.holder})`,
        };
    }
    return { quarantined: false };
}
