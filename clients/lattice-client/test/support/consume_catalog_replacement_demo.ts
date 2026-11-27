import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { treehouseCatalogBootstrapsFromFrames } from "../../src/treehouse";
import { verifyCatalogEnvelope } from "../../src/treehouse_catalog_codec";
import { catalogEnvelopeFromCarrierTerm } from "../../src/treehouse_catalog_codec";
import { parseCatalogArtifactJson } from "../../src/treehouse_catalog_json";
import { compareUtf8 } from "../../src/op";
import { evaluateReplacementTrust, prepareReplacementTrustInstallation, wrapReplacementTrust } from "../../src/treehouse_catalog_replacement_trust";
import { evaluateTreehouseCatalogTrust } from "../../src/treehouse_catalog_trust";
import type { InstalledReplacementTrust, ReplacementTrustResult } from "../../src/treehouse_catalog_replacement_trust";
import type { TreehouseCatalogEvidencePage, TreehouseCatalogRawHistory } from "../../src/treehouse_catalog_trust";

// Plan 316 row 316: replay the BEAM-written replacement demo file through the TS composed evaluator and print the same
// narrated lines. Candidate state only; this installs no app trust and dials nothing.
// A step with mode "trust" goes through the trust evaluator alone and is wrapped with the public wrap (it has no view); a run
// may carry its own history (the review findings of the Codex round).
interface Step { title: string; print: boolean; mode?: "eval" | "trust"; page: TreehouseCatalogEvidencePage }
interface Doc { format: string; history: TreehouseCatalogRawHistory; labels: Record<string, string>; reject_runs: string[];
  runs: {name: string; history?: TreehouseCatalogRawHistory; steps: Step[]}[] }

const doc = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Doc;
assert.equal(doc.format, "lattice-replacement-demo-v1");
async function bootstrapOf(history: TreehouseCatalogRawHistory) {
  const observed = await treehouseCatalogBootstrapsFromFrames(history);
  assert.ok(observed.ok && observed.bootstraps.length === 1);
  return observed.bootstraps[0]!;
}
let bootstrap = await bootstrapOf(doc.history);
const expected = {trustRevision: 0, historyGeneration: 0};

function signedBy(json: string, key: string): boolean {
  const parsed = parseCatalogArtifactJson(json);
  const envelope = parsed.ok ? catalogEnvelopeFromCarrierTerm(parsed.value) : null;
  return envelope !== null && verifyCatalogEnvelope(envelope, key);
}

function view(result: Extract<ReplacementTrustResult, {next: InstalledReplacementTrust}>) {
  const label = (id: string) => doc.labels[id] ?? `?${id}`;
  const accepted = result.next.binding.accepted;
  return {
    kind: result.kind, reason: result.reason, refused: Object.values(result.refused).sort(compareUtf8),
    accepted: accepted === null ? null : `${label(accepted.binding)}/${label(accepted.catalog)}`,
    origin: result.servedOrigin, routes: result.routes.length, urls: result.routes.map((r) => r.url).sort(compareUtf8),
    frozen: result.next.binding.frozen, sidecar: result.next.extra.catalogs.length,
    sidecar_rotations: (result.next.extra.rotations ?? []).length,
    old_key_used: result.next.extra.catalogs.some((json) => signedBy(json, bootstrap.record.catalogKey)),
  };
}

function line(title: string, v: ReturnType<typeof view>): string {
  const head = title.padEnd(19);
  if (v.refused.length > 0) return `${head}refused ${v.refused.join(",")}  kept ${v.accepted}  origin ${v.origin}  frozen ${v.frozen}`;
  const note = v.sidecar > 0 ? `  old catalog key used: ${v.old_key_used ? "yes" : "no"}` : "";
  return `${head}accepted ${(v.accepted ?? "").padEnd(7)} origin ${(v.origin ?? "").padEnd(26)} routes ${v.routes}${note}`;
}

const views: Record<string, unknown[]> = {};
for (const run of doc.runs) {
  const history = run.history ?? doc.history;
  bootstrap = await bootstrapOf(history);
  const prepared = await prepareReplacementTrustInstallation({
    review: {version: 1, product: "treehouse", space: history.replica, spaceRoot: bootstrap.record.spaceRoot,
      bootstrapId: bootstrap.id, observedBootstrapIds: [bootstrap.id], disposition: "pin_exact_observed_bootstrap"},
    history, store: {kind: "verified_fresh", expected},
  });
  assert.ok(prepared.next !== null);
  let state: InstalledReplacementTrust = prepared.next;
  views[run.name] = [];
  for (const step of run.steps) {
    if (step.mode === "trust") {
      const decision = await evaluateTreehouseCatalogTrust({installed: state.trust, expected, incoming: step.page});
      assert.notEqual(decision.kind, "reject", `${run.name} ${step.title}`);
      if (decision.kind === "reject") continue;
      state = wrapReplacementTrust(decision.next);
      views[run.name]!.push(null);
      continue;
    }
    const result = await evaluateReplacementTrust({installed: state, expected, incoming: step.page});
    // A reject changes nothing; its view is its kind and reason only, as on BEAM. Only the listed runs may reject.
    if (result.kind === "reject") {
      assert.ok(doc.reject_runs.includes(run.name), `${run.name} ${step.title}: ${result.reason}`);
      views[run.name]!.push({kind: "reject", reason: result.reason});
      continue;
    }
    state = result.next;
    const v = view(result);
    views[run.name]!.push(v);
    if (step.print) console.log(`[ts]   ${line(step.title, v)}`);
  }
}
console.log(`VIEWS ${JSON.stringify(views)}`);
