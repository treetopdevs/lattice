import { boundaryCases } from "./catalog_incoming_boundary_cases";
import { readFileSync } from "node:fs";
// Fresh public input and actual TS installation results; no saved verdict fallback.
import { trustFixture, fixtureId } from './export_treehouse_catalog_trust';
import { authorCarrierOpUnchecked } from './unchecked_author';
import { prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust } from '../../src/treehouse_catalog_trust';
const f = await trustFixture(0);
const frame = await authorCarrierOpUnchecked({ replica: f.space.replica, signer: f.root, deps: [fixtureId('incoming-missing')], kind: 'command', body: ['atom', 'outside_wire_vocabulary'], cap: ['nil'] });
const known = await authorCarrierOpUnchecked({ replica: f.space.replica, signer: f.root, deps: [fixtureId('incoming-missing-2'), fixtureId('incoming-missing')], kind: 'command', body: ['atom', 'post'], cap: ['nil'] });
const completeUnknown = await authorCarrierOpUnchecked({ replica: f.space.replica, signer: f.root, deps: [], kind: 'command', body: ['atom', 'outside_wire_vocabulary'], cap: ['nil'] });
const nested = await authorCarrierOpUnchecked({ replica: f.space.replica, signer: f.root, deps: [fixtureId('incoming-missing')], kind: 'command', body: ['map', [[['atom', 'post'], ['tuple', [['atom', 'outside_wire_vocabulary']]]]]], cap: ['nil'] });
const mapped = await authorCarrierOpUnchecked({ replica: f.space.replica, signer: f.root, deps: [fixtureId('incoming-missing')], kind: 'command', body: ['map', [[['atom', 'post'], ['nil']]]], cap: ['nil'] });
const set = await authorCarrierOpUnchecked({ replica: f.space.replica, signer: f.root, deps: [fixtureId('incoming-missing')], kind: 'command', body: ['mapset', [['atom', 'post']]], cap: ['nil'] });
const integer = await authorCarrierOpUnchecked({ replica: f.space.replica, signer: f.root, deps: [fixtureId('incoming-missing')], kind: 'command', body: ['int', '1'], cap: ['nil'] });
const cases = [];
const inputs = [
    ['fresh-complete', f.histories[0].frames],
    ['extra-rejected-record-field', [known], [{ frame: completeUnknown, reason: 'bad_signature', extra: true }]],
    ['missing-rejected-frame', [known], [{ reason: 'bad_signature' }]],
    ['nonobject-rejected-record', [known], [null]],
    ['mixed-rejected-integrity', f.histories[0].frames, [{ frame: { ...completeUnknown, sig: Buffer.alloc(64).toString('base64') }, reason: 'bad_signature' }, { frame: f.histories[0].frames[0], reason: 'bad_signature' }]],
    ['genuine-unknown-mislabeled-rejected', f.histories[0].frames, [{ frame: completeUnknown, reason: 'bad_signature' }]],
    ['wrong-replica-unknown-rejected', f.histories[0].frames, [{ frame: { ...completeUnknown, replica: 'other-replica', sig: Buffer.alloc(64).toString('base64') }, reason: 'bad_signature' }]],
    ['empty-id-rejected', f.histories[0].frames, [{ frame: { ...completeUnknown, id: '', sig: Buffer.alloc(64).toString('base64') }, reason: 'bad_signature' }]],
    ['duplicate-rejected-id', f.histories[0].frames, [{ frame: { ...completeUnknown, sig: Buffer.alloc(64).toString('base64') }, reason: 'bad_signature' }, { frame: { ...completeUnknown, sig: Buffer.alloc(64).toString('base64') }, reason: 'bad_signature' }]],
    ['forged-unknown-rejected', f.histories[0].frames, [{ frame: { ...completeUnknown, sig: Buffer.alloc(64).toString('base64') }, reason: 'bad_signature' }]],
    ['genuine-known-mislabeled-rejected', f.histories[0].frames, [{ frame: f.histories[0].frames[0], reason: 'bad_signature' }]],
    ['forged-same-id-rejected', f.histories[0].frames, [{ frame: { ...f.histories[0].frames[0], sig: Buffer.alloc(64).toString('base64') }, reason: 'bad_signature' }]],
    ['partial-with-genuine-rejected', [known], [{ frame: completeUnknown, reason: 'bad_signature' }]],
    ['partial-with-bad-rejected-reason', [known], [{ frame: completeUnknown, reason: 'other' }]],
    ['extra-header-and-missing', [{ ...known, extra: true }]],
    ['wrong-version-and-missing', [{ ...known, v: 2 }]],
    ['missing-version-and-missing', [Object.fromEntries(Object.entries(known).filter(([k]) => k !== "v"))]],
    ['unique-map-control', [mapped]],
    ['unique-mapset-control', [set]],
    ['canonical-integer-control', [integer]],
    ['duplicate-map-key-and-missing', [{ ...mapped, body: ['map', [[['atom', 'post'], ['nil']], [['atom', 'post'], ['nil']]]] }]],
    ['duplicate-mapset-and-missing', [{ ...set, body: ['mapset', [['atom', 'post'], ['atom', 'post']]] }]],
    ['alternate-integer-and-missing', [{ ...integer, body: ['int', '01'] }]],
    ['signed-unknown-and-missing', [frame]],
    ['forged-unknown-and-missing', [{ ...frame, sig: Buffer.alloc(64).toString('base64') }]],
    ['signed-known-and-multiple-missing', [known]],
    ['forged-known-and-multiple-missing', [{ ...known, sig: Buffer.alloc(64).toString('base64') }]],
    ['signed-unknown-complete', [completeUnknown]],
    ['forged-unknown-complete', [{ ...completeUnknown, sig: Buffer.alloc(64).toString('base64') }]],
    ['nested-unknown-and-missing', [nested]],
    ['duplicate-unknown-id', [frame, frame]],
    ['partial-with-later-forgery', [known, { ...frame, sig: Buffer.alloc(64).toString('base64') }]],
    ['partial-with-earlier-forgery', [{ ...frame, sig: Buffer.alloc(64).toString('base64') }, known]],
    ['partial-wrong-replica', [{ ...frame, replica: 'other-replica' }]],
];
inputs.push(...await boundaryCases(f));
const input = process.argv[2] === "--consume" ? JSON.parse(readFileSync(process.argv[3], "utf8")) : { review: f.review, baselineHistory: f.histories[0], cases: inputs.map(([name, frames, rejected = []]) => ({ name, history: { replica: f.space.replica, frames, rejected } })) };
const baseline = await prepareTreehouseCatalogInstallation({ review: input.review, history: input.baselineHistory, store: { kind: 'verified_fresh', expected: { trustRevision: 0, historyGeneration: 0 } } });
if (baseline.kind !== "propose")
    throw new Error("actual valid installed baseline is required");
for (const { name, history } of input.cases) {
    const result = await prepareTreehouseCatalogInstallation({ review: input.review, history, store: { kind: 'verified_fresh', expected: { trustRevision: 0, historyGeneration: 0 } } });
    const evaluated = await evaluateTreehouseCatalogTrust({ installed: baseline.next, expected: { trustRevision: 0, historyGeneration: 0 }, incoming: { catalogs: [], rotations: [], histories: [history], cutoffProofs: [] } });
    cases.push({ name, history, ts: { kind: result.kind, reason: result.reason, detail: result.detail }, tsEvaluation: { kind: evaluated.kind, reason: evaluated.reason, detail: evaluated.detail } });
}
console.log(JSON.stringify({ review: input.review, baselineHistory: input.baselineHistory, cases }));
