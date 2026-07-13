// Conformance harness: the TS reducer MUST reproduce Lattice.Sim's output.
//
// Sim (Elixir) is the oracle. For each vector (exported by the mix task, or
// hand-authored from a verified scenario), we materialize with the TS reducer
// and assert equality of state, quarantine set, and the partial-frontier LWW
// behaviour. Any drift here is exactly the two-implementations bug V-01 exists
// to prevent — so this file is the guardrail that lets a second (TS)
// implementation of the reducer exist at all.
//
// Run:  npx tsx test/conformance.ts   (from lattice-client/)
// Tier B (byte-identical op hashes) is added here once ADR-P08 / CBOR lands and
// vectors carry `encoding`.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { carrierOpsToSemanticOps, materialize, V01UnvalidatedAuthorityError, } from "../src/index";
// Scenarios that change an authority role (a transfer or succession) after
// genesis. The TS reducer cannot yet validate those (it honored ANY signed
// transfer/succeed — the V-01 authority-drift defect), so until Plan 140 ports
// real validation, `materialize` fails CLOSED and refuses them. We assert the
// refusal here instead of asserting a (currently unsafe) state. Plan 140 removes
// each name from this set as it restores validated reduction for that shape.
const REFUSED_PENDING_PLAN_140 = new Set([
    "township_zoning_variance_24",
    "township_succession_w3",
]);
const here = dirname(fileURLToPath(import.meta.url));
const vecDir = join(here, "vectors");
let failures = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, got, want) {
    const ok = eq(got, want);
    if (!ok)
        failures++;
    const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(`  ${tag} ${name}`);
    if (!ok) {
        console.log(`       got : ${JSON.stringify(got)}`);
        console.log(`       want: ${JSON.stringify(want)}`);
    }
}
for (const file of readdirSync(vecDir).filter((f) => f.endsWith(".json"))) {
    const vec = JSON.parse(readFileSync(join(vecDir, file), "utf8"));
    console.log(`\n▸ ${vec.scenario}  (${file})`);
    const ops = vec.scenario === "township_carrier_w1" &&
        vec.oracleCarrierOps !== undefined &&
        vec.realmByPubkey !== undefined
        ? carrierOpsToSemanticOps(vec.oracleCarrierOps, vec.realmByPubkey)
        : vec.ops;
    if (REFUSED_PENDING_PLAN_140.has(vec.scenario)) {
        let threw = null;
        try {
            materialize(vec.schema, ops);
        }
        catch (e) {
            threw = e;
        }
        check("refuses authority-role change (fail-closed, pending Plan 140)", threw instanceof V01UnvalidatedAuthorityError, true);
        continue;
    }
    // full-frontier materialization
    const full = materialize(vec.schema, ops);
    const exp = vec.expectAtFullFrontier;
    for (const [field, want] of Object.entries(exp.state)) {
        check(`state.${field}`, full.state[field], want);
    }
    check("quarantine set", [...full.quarantine].sort(), [...exp.quarantine].sort());
    if (exp.winners) {
        for (const [field, want] of Object.entries(exp.winners)) {
            check(`winner.${field}`, full.winners[field], want);
        }
    }
    // partial-frontier assertions (the LWW flip, perspective, etc.)
    for (const fr of vec.expectAtFrontier ?? []) {
        const m = materialize(vec.schema, ops, new Set(fr.include));
        for (const [field, want] of Object.entries(fr.state)) {
            check(`@frontier[${fr.include.length}] state.${field}${fr.note ? ` (${fr.note})` : ""}`, m.state[field], want);
        }
    }
}
console.log(`\n${failures === 0 ? "\x1b[32m✓ all conformance checks passed\x1b[0m" : `\x1b[31m✗ ${failures} check(s) failed\x1b[0m`}`);
process.exit(failures === 0 ? 0 : 1);
