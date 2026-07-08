import { isAuthorityField } from "./schema";
import { index, depth, canonicalOrder } from "./dag";
import { isQuarantined } from "./quarantine";
import { lww, orSet, causalList } from "./crdt/reducers";
/**
 * Materialize a replica from ops. `included` optionally bounds the visible set
 * (a frontier); default is all ops. This is a pure function of (schema, ops,
 * frontier) — the same inputs that `Lattice.Sim` reduces in Elixir, which is
 * why Sim can serve as the conformance oracle: for any scenario, this must
 * reproduce Sim's state, quarantine set, and order exactly.
 */
export function materialize(schema, ops, included) {
    const byId = index(ops);
    const inc = included ?? new Set(ops.map((o) => o.id));
    const order = canonicalOrder(ops.filter((o) => inc.has(o.id)), byId);
    const orderSet = new Set(order);
    const depthCache = new Map();
    const depthOf = (id) => depth(id, byId, depthCache);
    const concCache = new Map();
    // 1. quarantine pass (deps-decidable, over the included set)
    const quarantine = [];
    const quarantined = new Set();
    for (const id of order) {
        const op = byId.get(id);
        const q = isQuarantined(op, schema, orderSet, byId, concCache);
        if (q.quarantined) {
            quarantine.push(id);
            quarantined.add(id);
        }
    }
    // 2. per-field reduction over included, non-quarantined ops
    const state = {};
    const winners = {};
    const live = order.filter((id) => !quarantined.has(id)).map((id) => byId.get(id));
    for (const [field, spec] of Object.entries(schema.fields)) {
        const fieldOps = live.filter((o) => o.field === field);
        if (isAuthorityField(spec)) {
            // holder = last authority op in canonical order
            let holder = spec.default;
            let winner = null;
            for (const o of fieldOps) {
                holder = o.value;
                winner = o.id;
            }
            state[field] = holder;
            winners[field] = winner;
        }
        else if (spec.merge === "lww") {
            const r = lww(fieldOps, depthOf);
            state[field] = r.winner ? r.value : spec.default;
            winners[field] = r.winner;
        }
        else if (spec.merge === "or_set") {
            state[field] = orSet(fieldOps, byId);
        }
        else if (spec.merge === "causal_list") {
            state[field] = causalList(fieldOps, order);
        }
    }
    return { state, quarantine, order, winners };
}
