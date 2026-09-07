import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {semanticCorpus, verifySemanticCorpus} from "./support/export_member_continuity_semantics";
import {observeMemberContinuityFromFrames} from "../src/treehouse_member_continuity";

const vector = (producer: string) => fileURLToPath(new URL(`./vectors/member_continuity_semantics/${producer}_semantics.json`, import.meta.url));
for (const producer of ["beam", "ts"]) {
  test(`${producer} independently authored signed histories replay and assemble with exact bytes`, async () => {
    assert.ok(await verifySemanticCorpus(vector(producer)) >= 9);
  });
  test(`${producer} forged signature, partial closure and wrong replica cannot supply accepted evidence`, async () => {
    const corpus = JSON.parse(await readFile(vector(producer), "utf8"));
    const source = corpus.cases[0];
    const forged = source.frames.map((frame: {id:string}) => frame.id === corpus.authoring.frame.id ?
      {...frame, sig: Buffer.alloc(64).toString("base64")} : frame);
    for (const input of [{replica: source.replica, frames: forged},
      {replica: source.replica, frames: [corpus.authoring.frame]},
      {replica: "wrong-replica", frames: source.frames}]) {
      assert.deepEqual(await observeMemberContinuityFromFrames(input), {ok: false, reason: "invalid_verified_history"});
    }
  });
}
test("TypeScript regenerates its independent new semantic corpus exactly", async () => {
  assert.equal(JSON.stringify(await semanticCorpus(), null, 2) + "\n", await readFile(vector("ts"), "utf8"));
});
