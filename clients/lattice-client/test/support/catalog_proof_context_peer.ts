import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {trustFixture,fixtureId} from "./export_treehouse_catalog_trust";
import {authorCarrierOpUnchecked} from "./unchecked_author";
import {prepareTreehouseCatalogInstallation,evaluateTreehouseCatalogTrust} from "../../src/treehouse_catalog_trust";
import type {TreehouseCatalogRawHistory,TreehouseCatalogBootstrapReview,TreehouseCatalogCutoffProof} from "../../src/treehouse_catalog_trust";
import {deriveTreehouseCatalogCutoff} from "../../src/treehouse_catalog_cutoff";
const expected={trustRevision:0,historyGeneration:0};
type Bundle={review:TreehouseCatalogBootstrapReview;histories:TreehouseCatalogRawHistory[];catalogJson:string;unknownName:string;wrongDigest:string;cutoff:TreehouseCatalogCutoffProof["cutoff"];cases:{name:string;history:unknown;cutoff?:TreehouseCatalogCutoffProof["cutoff"]}[]};
async function produce():Promise<Bundle>{
 const f=await trustFixture(1),history=f.histories[0]!;
 const unknownName=`proof_future_${process.pid}_${Date.now()}`;
 const unknown=await authorCarrierOpUnchecked({replica:f.space.replica,signer:f.root,deps:[],kind:"command",body:["atom",unknownName],cap:["nil"]});
 const partial=await authorCarrierOpUnchecked({replica:f.space.replica,signer:f.root,deps:[fixtureId("proof-missing")],kind:"command",body:["atom","post"],cap:["nil"]});
 const prefix={...history,frames:history.frames.slice(0,-1)},absent={...history,frames:[...history.frames,await authorCarrierOpUnchecked({replica:f.space.replica,signer:f.root,deps:[],kind:"command",body:["nil"],cap:["nil"]})]};
 const prefixCutoff=await deriveTreehouseCatalogCutoff(prefix),absentCutoff=await deriveTreehouseCatalogCutoff(absent);
 assert.equal(prefixCutoff.ok,true);assert.equal(absentCutoff.ok,true);
 if(!prefixCutoff.ok||!absentCutoff.ok)throw new Error("producer must create portable proof controls");
 return {review:f.review,histories:f.histories,catalogJson:f.catalogJson,unknownName,wrongDigest:fixtureId("proof-wrong-digest"),cutoff:f.cutoffProofs.find(p=>p.cutoff.replica===f.review.space)!.cutoff,cases:[
  {name:"valid",history},{name:"valid-prefix",history:prefix,cutoff:prefixCutoff.cutoff},{name:"absent-member",history:absent,cutoff:absentCutoff.cutoff},{name:"unsupported",history:{...history,frames:[...history.frames,unknown]}},
  {name:"forged",history:{...history,frames:[...history.frames,{...unknown,sig:Buffer.alloc(64).toString("base64")}]}},
  {name:"partial",history:{...history,frames:[partial]}},{name:"malformed-history",history:{replica:history.replica,frames:[]}},
  {name:"malformed-rejected",history:{...history,rejected:[{frame:unknown,reason:"invented"}]}}
 ]};
}
async function run(bundle:Bundle){
 const page={catalogs:[],rotations:[],histories:[],cutoffProofs:[]};
 const prepared=await prepareTreehouseCatalogInstallation({review:bundle.review,history:bundle.histories[0]!,store:{kind:"verified_fresh",expected}});
 assert.equal(prepared.kind,"propose");
 const base=await evaluateTreehouseCatalogTrust({installed:prepared.next,expected,incoming:{...page,catalogs:[bundle.catalogJson],histories:bundle.histories}});
 assert.equal(base.kind,"propose");assert.equal(base.next.accepted?.revision,0);assert.equal(base.routes.length,2);
 const original=JSON.stringify(base.next),results=[];
 const cases=[...bundle.cases.map(c=>({...c,proof:{cutoff:c.cutoff??bundle.cutoff,history:c.history}})),
  {name:"malformed-proof",proof:{cutoff:bundle.cutoff,history:bundle.histories[0],extra:true}},
  {name:"malformed-cutoff",proof:{cutoff:{...bundle.cutoff,extra:true},history:bundle.histories[0]}},
  {name:"wrong-cutoff",proof:{cutoff:{...bundle.cutoff,logDigest:bundle.wrongDigest},history:bundle.histories[0]}}
 ];
 for(const c of cases){
  const incoming=JSON.parse(JSON.stringify({...page,cutoffProofs:[c.proof]}));
  const d=await evaluateTreehouseCatalogTrust({installed:base.next,expected,incoming});
  assert.equal(JSON.stringify(base.next),original);
  if(c.name==="valid"||c.name==="valid-prefix"){
   assert.equal(d.kind,"propose");assert.equal(d.reason,null);assert.deepEqual(d.next.accepted,base.next.accepted);assert.equal(d.routes.length,2);assert.equal(d.next.cutoffProofs.length,1);
   const reopened=await evaluateTreehouseCatalogTrust({installed:JSON.parse(JSON.stringify(d.next)),expected,incoming:page});
   assert.equal(reopened.kind,"unchanged");assert.deepEqual(reopened.next,d.next);
   if(c.name==="valid"){
   const mismatched=JSON.parse(JSON.stringify(d.next));mismatched.cutoffProofs[0].cutoff.logDigest=bundle.wrongDigest;
   const corrupt=await evaluateTreehouseCatalogTrust({installed:mismatched,expected,incoming});
   assert.equal(corrupt.kind,"reject");assert.equal(corrupt.reason,"trust_recovery_required");assert.deepEqual(corrupt.detail.ids,[]);
   for(const defect of bundle.cases.filter(c=>!["valid","valid-prefix","absent-member"].includes(c.name))){
    const broken=JSON.parse(JSON.stringify(d.next));broken.cutoffProofs[0].history=defect.history;
    const recovered=await evaluateTreehouseCatalogTrust({installed:broken,expected,incoming});
    assert.equal(recovered.kind,"reject");assert.equal(recovered.reason,"trust_recovery_required");assert.deepEqual(recovered.detail.ids,[]);
   }
   }
  }else{
   assert.equal(d.kind,"reject");assert.equal(d.reason,c.name.startsWith("malformed-proof")||c.name==="malformed-cutoff"?"malformed_catalog":"recovery_incomplete");
   assert.deepEqual(d.detail.ids,c.name==="wrong-cutoff"?[bundle.wrongDigest]:c.name==="absent-member"?[c.proof.cutoff.logDigest]:[]);
  }
  results.push({name:c.name,kind:d.kind,reason:d.reason,ids:d.detail.ids});
 }
 return {bundle,results};
}
const bundle=process.argv[2]==="consume"?JSON.parse(readFileSync(process.argv[3]!,"utf8")):await produce();
console.log(JSON.stringify(await run(bundle)));
