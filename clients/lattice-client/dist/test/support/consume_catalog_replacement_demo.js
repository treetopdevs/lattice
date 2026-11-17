import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { treehouseCatalogBootstrapsFromFrames } from "../../src/treehouse";
import { verifyCatalogEnvelope } from "../../src/treehouse_catalog_codec";
import { catalogEnvelopeFromCarrierTerm } from "../../src/treehouse_catalog_codec";
import { parseCatalogArtifactJson } from "../../src/treehouse_catalog_json";
import { compareUtf8 } from "../../src/op";
import { evaluateReplacementTrust, prepareReplacementTrustInstallation, wrapReplacementTrust } from "../../src/treehouse_catalog_replacement_trust";
import { evaluateTreehouseCatalogTrust } from "../../src/treehouse_catalog_trust";
const doc = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(doc.format, "lattice-replacement-demo-v1");
async function bootstrapOf(history) {
    const observed = await treehouseCatalogBootstrapsFromFrames(history);
    assert.ok(observed.ok && observed.bootstraps.length === 1);
    return observed.bootstraps[0];
}
let bootstrap = await bootstrapOf(doc.history);
const expected = { trustRevision: 0, historyGeneration: 0 };
function signedBy(json, key) {
    const parsed = parseCatalogArtifactJson(json);
    const envelope = parsed.ok ? catalogEnvelopeFromCarrierTerm(parsed.value) : null;
    return envelope !== null && verifyCatalogEnvelope(envelope, key);
}
function view(result) {
    const label = (id) => doc.labels[id] ?? `?${id}`;
    const accepted = result.next.binding.accepted;
    return {
        kind: result.kind, reason: result.reason, refused: Object.values(result.refused).sort(compareUtf8),
        accepted: accepted === null ? null : `${label(accepted.binding)}/${label(accepted.catalog)}`,
        origin: result.servedOrigin, routes: result.routes.length, urls: result.routes.map((r) => r.url).sort(compareUtf8),
        frozen: result.next.binding.frozen, sidecar: result.next.extra.catalogs.length,
        old_key_used: result.next.extra.catalogs.some((json) => signedBy(json, bootstrap.record.catalogKey)),
    };
}
function line(title, v) {
    const head = title.padEnd(19);
    if (v.refused.length > 0)
        return `${head}refused ${v.refused.join(",")}  kept ${v.accepted}  origin ${v.origin}  frozen ${v.frozen}`;
    const note = v.sidecar > 0 ? `  old catalog key used: ${v.old_key_used ? "yes" : "no"}` : "";
    return `${head}accepted ${(v.accepted ?? "").padEnd(7)} origin ${(v.origin ?? "").padEnd(26)} routes ${v.routes}${note}`;
}
const views = {};
for (const run of doc.runs) {
    const history = run.history ?? doc.history;
    bootstrap = await bootstrapOf(history);
    const prepared = await prepareReplacementTrustInstallation({
        review: { version: 1, product: "treehouse", space: history.replica, spaceRoot: bootstrap.record.spaceRoot,
            bootstrapId: bootstrap.id, observedBootstrapIds: [bootstrap.id], disposition: "pin_exact_observed_bootstrap" },
        history, store: { kind: "verified_fresh", expected },
    });
    assert.ok(prepared.next !== null);
    let state = prepared.next;
    views[run.name] = [];
    for (const step of run.steps) {
        if (step.mode === "trust") {
            const decision = await evaluateTreehouseCatalogTrust({ installed: state.trust, expected, incoming: step.page });
            assert.notEqual(decision.kind, "reject", `${run.name} ${step.title}`);
            if (decision.kind === "reject")
                continue;
            state = wrapReplacementTrust(decision.next);
            views[run.name].push(null);
            continue;
        }
        const result = await evaluateReplacementTrust({ installed: state, expected, incoming: step.page });
        assert.notEqual(result.kind, "reject", `${run.name} ${step.title}: ${result.kind === "reject" ? result.reason : ""}`);
        if (result.kind === "reject")
            continue;
        state = result.next;
        const v = view(result);
        views[run.name].push(v);
        if (step.print)
            console.log(`[ts]   ${line(step.title, v)}`);
    }
}
console.log(`VIEWS ${JSON.stringify(views)}`);
