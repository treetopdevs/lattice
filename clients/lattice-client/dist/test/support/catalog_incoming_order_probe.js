// Fresh public input and actual TS installation results; no saved verdict fallback.
import { trustFixture, fixtureId } from './export_treehouse_catalog_trust';
import { authorCarrierOpUnchecked } from './unchecked_author';
import { prepareTreehouseCatalogInstallation } from '../../src/treehouse_catalog_trust';
const f = await trustFixture(0);
const frame = await authorCarrierOpUnchecked({ replica: f.space.replica, signer: f.root, deps: [fixtureId('incoming-missing')], kind: 'command', body: ['atom', 'outside_wire_vocabulary'], cap: ['nil'] });
const cases = [];
for (const [name, frames] of [['fresh-complete', f.histories[0].frames], ['signed-unknown-and-missing', [frame]], ['forged-unknown-and-missing', [{ ...frame, sig: Buffer.alloc(64).toString('base64') }]]]) {
    const history = { replica: f.space.replica, frames, rejected: [] };
    const result = await prepareTreehouseCatalogInstallation({ review: f.review, history, store: { kind: 'verified_fresh', expected: { trustRevision: 0, historyGeneration: 0 } } });
    cases.push({ name, history, ts: { kind: result.kind, reason: result.reason, detail: result.detail } });
}
console.log(JSON.stringify({ review: f.review, cases }));
