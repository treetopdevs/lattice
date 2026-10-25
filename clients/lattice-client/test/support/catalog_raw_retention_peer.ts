import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {trustFixture} from "./export_treehouse_catalog_trust";
import {authorCarrierOpUnchecked} from "./unchecked_author";
import {verifyCarrierOpHash} from "../../src/codec";
import {deriveTreehouseCatalogCutoff} from "../../src/treehouse_catalog_cutoff";
import {prepareTreehouseCatalogInstallation,evaluateTreehouseCatalogTrust} from "../../src/treehouse_catalog_trust";
import type {TreehouseCatalogBootstrapReview,TreehouseCatalogRawHistory} from "../../src/treehouse_catalog_trust";
import type {CarrierOpFrame} from "../../src/carrier";
const expected={trustRevision:0,historyGeneration:0};
type Bundle={review:TreehouseCatalogBootstrapReview;history:TreehouseCatalogRawHistory;catalogJson:string;control:CarrierOpFrame};
async function produce():Promise<Bundle>{
 const f=await trustFixture(0),baseline=f.histories[0]!;
 const control=await authorCarrierOpUnchecked({replica:f.space.replica,signer:f.root,deps:[f.bootstrap.id],kind:"command",body:["int",1],cap:["nil"]});
 return {review:f.review,history:{...baseline,frames:[...baseline.frames,control]},catalogJson:f.catalogJson,control};
}
async function run(b:Bundle){
 const page={catalogs:[],rotations:[],histories:[],cutoffProofs:[]};
 const prepared=await prepareTreehouseCatalogInstallation({review:b.review,history:b.history,store:{kind:"verified_fresh",expected}});assert.equal(prepared.kind,"propose");
 const base=await evaluateTreehouseCatalogTrust({installed:prepared.next,expected,incoming:{...page,histories:[b.history],catalogs:[b.catalogJson]}});assert.equal(base.kind,"propose");assert.equal(base.next.accepted?.revision,0);assert.equal(base.routes.length,1);
 const original=JSON.stringify(base.next),results=[];
 const dup={...b.control,deps:[...b.control.deps,b.control.deps[0]!]};
 const variants=[{name:"exact",frame:b.control},{name:"object-key-order",frame:Object.fromEntries(Object.entries(b.control).reverse())},{name:"small-text",frame:{...b.control,body:["int","1"]}},{name:"dependency-alias",frame:dup}];
 for(const {name,frame} of variants){
  assert.equal(await verifyCarrierOpHash(JSON.parse(JSON.stringify(frame))),true);
  const incoming=JSON.parse(JSON.stringify({...page,histories:[{replica:b.history.replica,frames:[frame],rejected:[]}]}));
  const d=await evaluateTreehouseCatalogTrust({installed:base.next,expected,incoming});
  const exact=name==="exact"||name==="object-key-order";
  assert.equal(d.kind,exact?"unchanged":"reject");assert.equal(d.reason,exact?null:"invalid_verified_history");assert.deepEqual(d.detail.ids,exact?[]:[b.control.id]);
  if(d.kind!=="reject"){assert.deepEqual(d.next,base.next);assert.equal(d.routes.length,1);}
  results.push({name,kind:d.kind,reason:d.reason,ids:d.detail.ids});
 }
 const cutoff=await deriveTreehouseCatalogCutoff(b.history);assert.equal(cutoff.ok,true);if(!cutoff.ok)throw new Error("valid proof cutoff required");
 const aliasHistory={...b.history,frames:b.history.frames.map(f=>(f as CarrierOpFrame).id===b.control.id?dup:f)};
 const aliasCutoff=await deriveTreehouseCatalogCutoff(aliasHistory);assert.equal(aliasCutoff.ok,true);if(!aliasCutoff.ok)throw new Error("alias proof must be authentic/portable");assert.deepEqual(aliasCutoff.cutoff,cutoff.cutoff);
 const proof=await evaluateTreehouseCatalogTrust({installed:base.next,expected,incoming:{...page,cutoffProofs:[{cutoff:cutoff.cutoff,history:aliasHistory}]}});
 assert.equal(proof.kind,"reject");assert.equal(proof.reason,"recovery_incomplete");assert.deepEqual(proof.detail.ids,[cutoff.cutoff.logDigest]);
 assert.equal(JSON.stringify(base.next),original);
 return {bundle:b,results};
}
const b=process.argv[2]==="consume"?JSON.parse(readFileSync(process.argv[3]!,"utf8")):await produce();
console.log(JSON.stringify(await run(b)));
