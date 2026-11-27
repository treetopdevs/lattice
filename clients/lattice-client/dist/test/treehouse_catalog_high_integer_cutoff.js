// Row 336 pin: admitting high uint64 command arguments for the Space/Thread judge must not change any
// catalog-trust outcome. A signed history holding a wire uint64 above 2^53 - 1 in any command's
// argument list keeps origin/main's result: unsupported_cutoff for every command name except
// replace_catalog_v1, which the generic frame reader already admitted before row 336 (the BEAM
// product reader refuses that one too; that pre-existing divergence is a recorded follow-up).
import assert from "node:assert/strict";
import { test } from "node:test";
import { trustFixture, fixtureSigner } from "./support/export_treehouse_catalog_trust";
import { authorCarrierOpUnchecked } from "./support/unchecked_author";
import { prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust } from "../src/treehouse_catalog_trust";
import { treehouseCommandDecoders } from "../src/treehouse";
const expected = { trustRevision: 0, historyGeneration: 0 };
const none = { catalogs: [], rotations: [], cutoffProofs: [], histories: [] };
test("high uint64 command arguments keep every pre-row-336 catalog-trust outcome", async () => {
    const f = await trustFixture();
    const prepared = await prepareTreehouseCatalogInstallation({ review: f.review, history: f.histories[0], store: { kind: "verified_fresh", expected } });
    assert.equal(prepared.kind, "propose");
    const foreign = fixtureSigner("row-336-foreign");
    let checked = 0;
    for (const product of ["Treehouse.Space", "Treehouse.Thread"]) {
        const space = product === "Treehouse.Space";
        const h = space ? f.space : f.threads[0], history = space ? f.histories[0] : f.histories[1];
        for (const name of treehouseCommandDecoders(product).keys()) {
            for (const value of ["9007199254740992", "18446744073709551615"]) {
                for (const rooted of [false, true]) {
                    const frame = await authorCarrierOpUnchecked({ replica: h.replica, signer: rooted ? h.signer : foreign,
                        deps: rooted ? [h.frames.at(-1).id] : [], kind: "command",
                        cap: rooted ? ["bin", Buffer.from(h.delegation.id).toString("base64")] : ["nil"],
                        body: ["tuple", [["atom", name], ["list", [["int", value]]]]] });
                    const raw = { ...history, frames: [...history.frames, frame] };
                    const histories = space ? [raw, ...f.histories.slice(1)] : [f.histories[0], raw];
                    const label = `${product} ${name} ${value} ${rooted ? "root" : "foreign"}`;
                    const decision = await evaluateTreehouseCatalogTrust({ installed: prepared.next, expected,
                        incoming: { catalogs: [f.catalogJson], rotations: [], cutoffProofs: [], histories } });
                    const outcomes = [decision];
                    if (space)
                        outcomes.push(await prepareTreehouseCatalogInstallation({ review: f.review, history: raw, store: { kind: "verified_fresh", expected } }));
                    for (const outcome of outcomes) {
                        if (name === "replace_catalog_v1")
                            assert.equal(outcome.kind, "propose", label);
                        else
                            assert.deepEqual([outcome.kind, outcome.reason], ["reject", "unsupported_cutoff"], label);
                    }
                    if (decision.kind === "propose") {
                        assert.equal((await evaluateTreehouseCatalogTrust({ installed: decision.next, expected, incoming: none })).kind, "unchanged", label);
                    }
                    checked += 1;
                }
            }
        }
    }
    assert.equal(checked, 60);
});
