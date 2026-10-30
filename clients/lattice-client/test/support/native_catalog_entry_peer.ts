// Fresh public-owner observations for the native entry-fact seam. Full graph
// decisions remain attached as evidence, not a native graph-parity assertion.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {authorCarrierOpUnchecked} from "./unchecked_author";
import type {CarrierTerm} from "../../src/carrier";
import {trustFixture, signedCatalog, fixtureId} from "./export_treehouse_catalog_trust";
import {catalogEntryToCarrierTerm, catalogBootstrapToCarrierTerm} from "../../src/treehouse_catalog_codec";
import type {CatalogEntry, TransportCatalog} from "../../src/treehouse_catalog_codec";
import type {TreehouseCatalogRawHistory} from "../../src/treehouse_catalog_trust";
import {prepareTreehouseCatalogInstallation,evaluateTreehouseCatalogTrust} from "../../src/treehouse_catalog_trust";
if(process.argv[2]==="consume"){
 const input=JSON.parse(readFileSync(0,"utf8"));
 const results: Awaited<ReturnType<typeof evaluateTreehouseCatalogTrust>>[]=[];
 for(const item of input.cases){
  const expected={trustRevision:0,historyGeneration:0};
  const prepared=await prepareTreehouseCatalogInstallation({review:item.review,history:item.histories.find((h:TreehouseCatalogRawHistory)=>h.replica===item.review.space),store:{kind:"verified_fresh",expected}});
  assert.equal(prepared.kind,"propose");
  results.push(await evaluateTreehouseCatalogTrust({installed:prepared.next,expected,incoming:{catalogs:[item.catalogJson],rotations:[],histories:item.histories,cutoffProofs:[]}}));
 }
 await new Promise<void>((resolve)=>process.stdout.write(JSON.stringify({results})+"\n",()=>resolve()));process.exit(0);
}
const f=await trustFixture(2), expected={trustRevision:0,historyGeneration:0};
const first=[...f.threads].sort((a,b)=>Buffer.compare(Buffer.from(a.replica),Buffer.from(b.replica)))[0]!;
const second=f.threads.find(t=>t.replica!==first.replica)!;
const prepared=await prepareTreehouseCatalogInstallation({review:f.review,history:f.histories[0]!,store:{kind:"verified_fresh",expected}});
assert.equal(prepared.kind,"propose");
const change=(replica:string, edits:Partial<CatalogEntry>):TransportCatalog=>({...f.catalog,entries:f.catalog.entries.map(e=>e.replica===replica?{...e,...edits}:e)});
const missing=f.histories.filter(h=>h.replica!==first.replica);
const cases=[];
const malformed: TreehouseCatalogRawHistory[]=f.histories.map(raw=>({...raw,frames:raw.replica===first.replica?raw.frames.map((frame,index)=>index===0?{...frame,body:["delegation",{}],sig:Buffer.alloc(64).toString("base64")}:frame):raw.frames}));
let deep:CarrierTerm=["nil"];
for(let i=0;i<65;i++) deep=["list",[deep]];
const deepFrame=await authorCarrierOpUnchecked({replica:first.replica,signer:first.signer,deps:[],kind:"command",cap:["nil"],body:deep});
const deepHistories=f.histories.map(raw=>raw.replica===first.replica?{...raw,frames:[...raw.frames,deepFrame]}:raw);
const forgedDeep=f.histories.map(raw=>raw.replica===first.replica?{...raw,frames:[...raw.frames,{...deepFrame,sig:Buffer.alloc(64).toString("base64")}]}:raw);
const inputs:[string,TransportCatalog,TreehouseCatalogRawHistory[],string|null][]=[
 ["complete",f.catalog,f.histories,null],
 ["same-frame-unsupported-forgery",f.catalog,malformed,"invalid_verified_history"],
 ["signed-depth65-unsupported",f.catalog,deepHistories,"unsupported_cutoff"],
 ["forged-depth65-invalid",f.catalog,forgedDeep,"invalid_verified_history"],
 ["missing-child",f.catalog,missing,"trust_pending"],
 ["wrong-root",change(first.replica,{root:f.bootstrapRecord.spaceRoot}),f.histories,"invalid_catalog_transition"],
 ["genesis-is-creation",change(first.replica,{genesis:first.creation.id}),f.histories,"invalid_catalog_transition"],
 ["creation-is-genesis",change(first.replica,{creation:first.genesis.id}),f.histories,"invalid_catalog_transition"],
 ["wrong-reference",change(first.replica,{reference:f.space.creation.id}),f.histories,"invalid_catalog_transition"],
 ["missing-genesis",change(first.replica,{genesis:fixtureId("missing-genesis")}),f.histories,"trust_pending"],
 ["missing-creation",change(first.replica,{creation:fixtureId("missing-creation")}),f.histories,"trust_pending"],
 ["missing-reference",change(first.replica,{reference:fixtureId("missing-reference")}),f.histories,"trust_pending"],
 ["pending-cannot-hide-invalid-entry",change(second.replica,{root:f.bootstrapRecord.spaceRoot}),missing,"invalid_catalog_transition"],
];
for(const [name,catalog,histories,reason] of inputs){
 const catalogJson=await signedCatalog(catalog,f.catalogSigner);
 const publicDecision=await evaluateTreehouseCatalogTrust({installed:prepared.next,expected,incoming:{catalogs:[catalogJson],rotations:[],histories,cutoffProofs:[]}});
 assert.equal(publicDecision.reason,reason,name);
 if(reason===null){assert.equal(publicDecision.kind,"propose");assert.notEqual(publicDecision.next.accepted,null);assert.equal(publicDecision.routes.length,3);}
 else if(reason==="trust_pending"){assert.equal(publicDecision.kind,"propose");assert.equal(publicDecision.next.accepted,null);assert.deepEqual(publicDecision.routes,[]);}
 else {assert.equal(publicDecision.kind,"reject");}
 cases.push({name,catalogJson,histories:histories.map(raw=>({name:raw.replica,raw})),publicDecision,
 result:reason===null?{ok:true,entries:["list",catalog.entries.map(catalogEntryToCarrierTerm)],bootstrap:catalogBootstrapToCarrierTerm(f.bootstrapRecord),bootstrapId:f.bootstrap.id}:{ok:false,reason}});
}
console.log(JSON.stringify({cases,review:f.review}));
