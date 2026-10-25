import { WIRE_VOCABULARY } from "../../src/wire_vocabulary";
import assert from "node:assert/strict";
import {commandCases,judgeCommands,threadPolicyCases} from "./native_catalog_command_peer";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { trustFixture } from "./export_treehouse_catalog_trust";
import { carrierOpsToSemanticOps, decodeCarrierOpFrame } from "../../src/carrier";
import { verifyCarrierOp, canonicalBytesForCarrierTerm, authorCarrierOp } from "../../src/codec";
import { canonicalBase64Bytes } from "../../src/codec";
import { ed25519 } from "@noble/curves/ed25519.js";
import { analyzeAuthority } from "../../src/authority";
import { capabilityQuarantine, revokedAsOf } from "../../src/capability";
import { treehouseSpaceSchema, treehouseThreadSchema, observeTreehouse } from "../../src/treehouse";
import { canonicalOrder } from "../../src/dag";
import { treehouseCommandDecoders } from "../../src/treehouse";

import { cutoffFixture } from "./export_treehouse_catalog_cutoff";
import { authorCarrierOpUnchecked } from "./unchecked_author";
import { deriveTreehouseCatalogCutoff } from "../../src/treehouse_catalog_cutoff";
import type { CarrierTerm } from "../../src/carrier";

interface History { replica: string; frames: unknown[]; expiryQueries?: [string,boolean][]; order?: string[]; frontier?: string[]; }
async function graph(history: History) {
  for (const frame of history.frames) {
    const result = await verifyCarrierOp(decodeCarrierOpFrame(frame), {verify: async (key, bytes, signature) =>
      ed25519.verify(signature, bytes, canonicalBase64Bytes(key, 32)!, {zip215: false})});
    assert.equal(result.valid, true);
  }
  const product = history.replica.startsWith("replica:treehouse:space:") ? "Treehouse.Space" : "Treehouse.Thread";
  const ops = carrierOpsToSemanticOps(history.frames, {}, treehouseCommandDecoders(product));
  const ids = new Set(ops.map(op => op.id));
  assert.equal(ids.size, history.frames.length);
  assert.ok(ops.every(op => op.replica === history.replica && op.deps.every(id => ids.has(id))));
  const referenced = new Set(ops.flatMap(op => op.deps));
  const order = canonicalOrder(ops);
  assert.equal(order.length, ops.length);
  return {replica: history.replica, frames: history.frames, order,
    frontier: [...ids].filter(id => !referenced.has(id)).sort()};
}
interface CutoffCase { name: string; replica: string; frames: unknown[];
  rejected: {frame: unknown; reason: "bad_signature"}[]; }
async function cutoffCases() {
  const f = await cutoffFixture();
  const base: CutoffCase = {name: "ts-complete", replica: f.replica, frames: f.frames, rejected: []};
  const cases: CutoffCase[] = [base,
    {...base, name: "ts-rejected-same-id-and-arbitrary-header", rejected: [
      {frame: f.forged, reason: "bad_signature"}, {frame: f.supplied, reason: "bad_signature"}]},
    {...base, name: "ts-genuine-cannot-be-rejected", rejected: [{frame: f.genuine, reason: "bad_signature"}]},
    {...base, name: "ts-missing-closure", frames: f.frames.slice(1)},
    {...base, name: "ts-duplicate-accepted", frames: [...f.frames, f.genuine]},
    {...base, name: "ts-corrupt-accepted", frames: [...f.frames.slice(0,-1), f.forged]},
  ];
  const atoms = JSON.parse(readFileSync(new URL("../vectors/catalog/cutoff_atoms_with_member_continuity_v1.json", import.meta.url), "utf8")) as string[];
  const vocabulary = await authorCarrierOp({replica: f.replica, signer: f.signer, deps: [f.genuine.id], kind: "command", cap: ["nil"],
    body: ["list", atoms.map((name): CarrierTerm => ["atom", name])]});
  cases.push({...base, name: "ts-all-139-portable-atoms", frames: [...f.frames, vocabulary]});
  const unknown = await authorCarrierOpUnchecked({replica: f.replica, signer: f.signer, deps: [], kind: "command", cap: ["nil"],
    body: ["atom", "cutoff_unknown_evidence_v99"]});
  cases.push({...base, name: "ts-unknown-authentic", frames: [unknown]},
    {...base, name: "ts-unknown-forged", frames: [{...unknown, sig: ""}]},
    {...base, name: "ts-unknown-genuine-rejected", frames: [], rejected: [{frame: unknown, reason: "bad_signature"}]},
    {...base, name: "ts-unknown-forgery-unsupported", frames: [], rejected: [{frame: {...unknown, sig: ""}, reason: "bad_signature"}]});
  let deep: CarrierTerm = ["nil"];
  for (let i=0; i<64; i++) deep = ["list", [deep]];
  const depth64 = await authorCarrierOp({replica: f.replica, signer: f.signer, deps: [], kind: "command", cap: ["nil"], body: deep});
  const depth65 = await authorCarrierOp({replica: f.replica, signer: f.signer, deps: [], kind: "command", cap: ["nil"], body: ["list", [deep]]});
  cases.push({...base, name: "ts-depth64", frames: [depth64]}, {...base, name: "ts-depth65-unsupported", frames: [depth65]},
    {...base, name: "ts-bad-key-precedes-unsupported", frames: [{...depth65, author: ""}]},
    {...base, name: "ts-malformed-body-precedes-cap-depth", frames: [{...depth65, body: ["atom", 9], cap: ["list", [deep]]}]},
    {...base, name: "ts-malformed-rejected-scalar", frames: [], rejected: [{frame: {...f.forged, body: ["int", -1]}, reason: "bad_signature"}]});
  const large = await Promise.all(Array.from({length:32}, (_, index) => authorCarrierOp({replica: f.replica, signer: f.signer,
    deps: [f.genuine.id], kind: "command", cap: ["nil"], body: ["bin", Buffer.from(`${index}:` + "x".repeat(8192)).toString("base64")]})));
  cases.push({...base, name: "ts-cutoff-larger-than-an-artifact", frames: [...f.frames, ...large]});
  const huge = await authorCarrierOp({replica:f.replica, signer:f.signer, deps:[], kind:"command", cap:["nil"],
    body:["bin", Buffer.alloc(512*1024, 120).toString("base64")]});
  const hugeForgery = {...huge, sig:Buffer.alloc(64).toString("base64")};
  const emptyDelegation: CarrierTerm = ["delegation", {id:"", replica:"", parent_id:"",
    issuer:Buffer.alloc(32,7).toString("base64"), audience:Buffer.alloc(32,7).toString("base64"),
    ops:[], roles:[], live:true, sig:Buffer.alloc(64).toString("base64")}];
  const emptyFrame = await authorCarrierOp({replica:f.replica, signer:f.signer, deps:[], kind:"command", cap:["nil"], body:emptyDelegation});
  cases.push({...base, name:"ts-broad-observation-authenticates-before-portability", frames:[huge]},
    {...base, name:"ts-broad-observation-forgery-invalid", frames:[hugeForgery]},
    {...base, name:"ts-broad-observation-genuine-not-rejected", frames:[], rejected:[{frame:huge, reason:"bad_signature"}]},
    {...base, name:"ts-broad-observation-rejected-unportable", frames:[], rejected:[{frame:hugeForgery, reason:"bad_signature"}]},
    {...base, name:"ts-empty-delegation-fields-remain-raw-evidence", frames:[emptyFrame]});
  let exact = false;
  for (let padding=0; padding<4 && !exact; padding++) {
    const replica = f.replica + "x".repeat(padding);
    const make = (size: number) => authorCarrierOp({replica, signer: f.signer, deps: [], kind: "command", cap: ["nil"], body: ["bin", Buffer.alloc(size, 120).toString("base64")]});
    let low=0, high=50_000;
    while (low<high) { const middle=Math.ceil((low+high)/2); const frame=await make(middle);
      if (Buffer.byteLength(JSON.stringify({type:"push", ops:[frame]})) <= 64_000) low=middle; else high=middle-1; }
    const frame=await make(low);
    if (Buffer.byteLength(JSON.stringify({type:"push", ops:[frame]})) !== 64_000) continue;
    exact=true;
    const tooLarge=await authorCarrierOp({replica: replica+"x", signer:f.signer, deps:[], kind:"command", cap:["nil"], body: frame.body});
    assert.equal(Buffer.byteLength(JSON.stringify({type:"push", ops:[tooLarge]})), 64_001);
    cases.push({name:"ts-exact-push-limit", replica, frames:[frame], rejected:[]},
      {name:"ts-one-push-byte-over", replica:replica+"x", frames:[tooLarge], rejected:[]},
      {name:"ts-forged-oversize-still-invalid", replica:replica+"x", frames:[{...tooLarge, sig:Buffer.alloc(64).toString("base64")}], rejected:[]});
  }
  assert.ok(exact, "find genuine exact push-byte boundary");
  return {cases: await Promise.all(cases.map(async ({name, ...input}) => ({name, input, result: await deriveTreehouseCatalogCutoff(input)})))};
}
const serialize = (value: unknown) => JSON.stringify(value, (_key, item) => item instanceof Uint8Array ? Buffer.from(item).toString("base64") : item);
if (process.argv[2] === "produce") {
  const fixture = await trustFixture();
  const term: CarrierTerm = ["delegation", {id: "", replica: "", parent_id: "",
    issuer: Buffer.alloc(32, 7).toString("base64"), audience: Buffer.alloc(32, 7).toString("base64"),
    ops: [], roles: [], live: true, sig: Buffer.alloc(64).toString("base64")}];
  console.log(JSON.stringify({histories: await Promise.all(fixture.histories.map(graph)),
    terms: [{term, bytes: Buffer.from(canonicalBytesForCarrierTerm(term)).toString("base64")}]}));
} else if (process.argv[2] === "consume") {
  const input = JSON.parse(readFileSync(0, "utf8")) as {histories: History[]};
  for (const history of input.histories) {
    const actual = await graph(history);
    assert.deepEqual(history.order, actual.order);
    assert.deepEqual(history.frontier, actual.frontier);
  }
  console.log(JSON.stringify({histories: input.histories.length}));
 } else if (process.argv[2] === "thread-policy-cases") {
  const lineage=JSON.parse(execFileSync(process.execPath,["--import","tsx","test/support/thread_lineage_peer.ts"],{encoding:"utf8"}));
  const lifecycle=JSON.parse(execFileSync(process.execPath,["--import","tsx","test/support/lifecycle_quarantine_peer.ts"],{encoding:"utf8"}));
  console.log(JSON.stringify({histories:[...await threadPolicyCases(),...lineage.cases,
   ...lifecycle.histories.filter((h:History)=>h.replica.startsWith("replica:treehouse:thread:"))]}));
 } else if (process.argv[2] === "thread-policy" || process.argv[2] === "thread-projection") {
  const input=JSON.parse(readFileSync(0,"utf8")) as {histories:History[]};
  const results=[];
  for(const h of input.histories){
   await graph(h);
   const ops=carrierOpsToSemanticOps(h.frames,{},treehouseCommandDecoders("Treehouse.Thread"));
   const result=observeTreehouse("Treehouse.Thread",ops);
   const commandReasons=Object.fromEntries(ops.filter(op=>op.kind==="command").map(op=>[op.id,result.quarantineReasons.get(op.id)??null]));
   results.push(process.argv[2]==="thread-policy"?commandReasons:{commandReasons,posts:result.posts,
    title:result.state.title,moderation:result.state.moderation,archived:result.state.archived,moderator:result.state.moderator});
  }
  console.log(JSON.stringify({results}));
 } else if (process.argv[2] === "command-cases") {
  console.log(JSON.stringify({histories:await commandCases()}));
} else if (process.argv[2] === "command-gates") {
  const input=JSON.parse(readFileSync(0,"utf8"));
  console.log(JSON.stringify({results:await Promise.all(input.histories.map(judgeCommands))}));
} else if (process.argv[2] === "reader-vocabulary") {
  console.log(JSON.stringify({names:WIRE_VOCABULARY}));
} else if (process.argv[2] === "strict-portability") {
  const input = JSON.parse(readFileSync(0,"utf8")) as {histories: History[]};
  console.log(JSON.stringify({portable:input.histories.map(h => {
    try {h.frames.map(decodeCarrierOpFrame);return true;} catch {return false;}
  })}));
} else if (process.argv[2] === "authority-cases") {
  const dir = mkdtempSync(join(tmpdir(), "native-authority-ts-"));
  try {
    const out = join(dir,"cases.json");
    execFileSync(process.execPath,["--import","tsx","test/support/export_continuation_authoring.ts","--out",out]);
    const input = JSON.parse(readFileSync(out,"utf8"));
    console.log(JSON.stringify({histories:input.vectors}));
  } finally {rmSync(dir,{recursive:true,force:true});}
} else if (process.argv[2] === "authority") {
  const input = JSON.parse(readFileSync(0,"utf8")) as {histories: History[]};
  const results = [];
  for (const history of input.histories) {
    await graph(history);
    const schema = history.replica.startsWith("replica:treehouse:space:") ? treehouseSpaceSchema : treehouseThreadSchema;
    const ops = carrierOpsToSemanticOps(history.frames, {}, treehouseCommandDecoders(schema.name as "Treehouse.Space" | "Treehouse.Thread"));
    const byId = new Map(ops.map(op => [op.id,op]));
    const a = analyzeAuthority(schema,ops,new Set(byId.keys()),canonicalOrder(ops),byId,history.replica);
    for (const [id,expired] of history.expiryQueries??[]) {
      assert.deepEqual(capabilityQuarantine(byId.get(id)!,schema,byId,a.security),expired ? {quarantined:true,reason:"lease_expired"} : {quarantined:false});
    }
    const roles = Object.keys(schema.fields).filter(r => "authority" in schema.fields[r]!);
    const acquires = Object.fromEntries(roles.map(r => [r,(a.acquiresByRole.get(r)??[]).map(v => ({opId:v.opId,holder:v.holderPubkey,tick:String(v.atTick??0)}))]));
    results.push({reasons:Object.fromEntries([...a.quarantineReasons].filter(([id]) => byId.get(id)?.kind === "authority")),
      beacons:a.security.validBeacons.map(b => [b.opId,String(b.epoch)]).sort((a,b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0),
      epochs:Object.fromEntries(roles.map(r => [r,a.acquiresByRole.get(r)?.at(-1)?.opId??null])),
      holders:Object.fromEntries(roles.map(r => [r,a.acquiresByRole.get(r)?.at(-1)?.holderPubkey??null])),acquires});
  }
  console.log(JSON.stringify({results}));
} else if (process.argv[2] === "delegations") {
  const input = JSON.parse(readFileSync(0, "utf8")) as History & {queries: {op: string; delegation: string}[]; reasonIds: string[]};
  await graph(input);
  const schema = input.replica.startsWith("replica:treehouse:space:") ? treehouseSpaceSchema : treehouseThreadSchema;
  const ops = carrierOpsToSemanticOps(input.frames, {}, treehouseCommandDecoders(schema.name as "Treehouse.Space" | "Treehouse.Thread"));
  const byId = new Map(ops.map(op => [op.id, op]));
  const analysis = analyzeAuthority(schema, ops, new Set(byId.keys()), canonicalOrder(ops), byId, input.replica);
  const security = analysis.security;
  const records = Object.fromEntries([...security.delegations].map(([id, record]) => [id, {
    validation: record.validation, introductions: record.introductionOpIds,
    invalidIntroductions: Object.fromEntries(record.invalidIntroductionReasons),
  }]));
  console.log(JSON.stringify({root: security.root?.pubkey ?? null, records,
    reasons: Object.fromEntries(input.reasonIds.map(id => [id, analysis.quarantineReasons.get(id) ?? null])),
    active: Object.fromEntries([...security.delegations].map(([id,r]) => [id,r.validation.valid])),
    revokes: security.effectiveRevokes.map(r => [r.opId, r.delegationId]),
    revoked: input.queries.map(q => revokedAsOf(byId.get(q.op)!, q.delegation, byId, security, new Map()))}));
} else if (process.argv[2] === "cutoffs") {
  console.log(serialize(await cutoffCases()));
} else if (process.argv[2] === "consume-cutoffs") {
  const input = JSON.parse(readFileSync(0,"utf8")) as {cases: {input: CutoffCase; result: {cutoff: unknown; canonicalBytes: string}}[]};
  for (const item of input.cases) {
    const result = await deriveTreehouseCatalogCutoff(item.input);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.cutoff, item.result.cutoff);
      assert.equal(Buffer.from(result.canonicalBytes).toString("base64"), item.result.canonicalBytes);
    }
  }
  console.log(JSON.stringify({cases:input.cases.length}));
} else throw new Error("expected a native history peer mode");
