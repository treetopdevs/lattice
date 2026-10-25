import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {trustFixture,fixtureId,signedCatalog} from "./export_treehouse_catalog_trust";
import {boundaryCases} from "./catalog_incoming_boundary_cases";
import {authorTreehouseCommand} from "../../src/treehouse";
import {transportCatalogId} from "../../src/treehouse_catalog_codec";
import {prepareTreehouseCatalogInstallation,evaluateTreehouseCatalogTrust} from "../../src/treehouse_catalog_trust";
import type {InstalledTreehouseCatalogTrustV1,TreehouseCatalogEvidencePage,TreehouseCatalogRawHistory,TreehouseCatalogTrustDecision} from "../../src/treehouse_catalog_trust";
const expected={trustRevision:0,historyGeneration:0};
interface Bundle {review:InstalledTreehouseCatalogTrustV1["review"];histories:TreehouseCatalogRawHistory[];catalogJson:string;advancedCatalogJson:string;forkHistory:TreehouseCatalogRawHistory;deepFrame:unknown;cases:{name:string;history:TreehouseCatalogRawHistory}[];}
const page=(histories:TreehouseCatalogRawHistory[]=[]):TreehouseCatalogEvidencePage=>({catalogs:[],rotations:[],histories,cutoffProofs:[]});
async function produce():Promise<Bundle>{
 const f=await trustFixture(1);
 const retainedHistories:TreehouseCatalogRawHistory[]=f.histories;
 retainedHistories[0]!.rejected=[{frame:{...f.histories[0]!.frames[0]!,sig:Buffer.alloc(64).toString("base64")},reason:"bad_signature"}];
 const fork=await authorTreehouseCommand({product:"Treehouse.Space",replica:f.space.replica,signer:f.root,deps:[f.histories[0]!.frames.at(-1)!.id],capId:f.space.delegation.id,command:{command:"catalog_bootstrap_v1",record:{...f.bootstrapRecord,nonce:fixtureId("recovery-bootstrap-fork")}}});
 const names=new Set(["depth-64-complete","depth-65-complete","depth-66-partial","push-64000-complete","push-64001-complete","forged-depth-65-partial"]);
 const inputs=(await boundaryCases(f)).filter(([name])=>names.has(name));
 assert.equal(inputs.length,names.size);
 return {review:f.review,histories:f.histories,catalogJson:f.catalogJson,advancedCatalogJson:await signedCatalog({...f.catalog,revision:1,previous:transportCatalogId(f.catalog)},f.catalogSigner),forkHistory:{...f.histories[0]!,frames:[...f.histories[0]!.frames,fork]},deepFrame:inputs.find(([name])=>name==="depth-65-complete")![1].at(-1),cases:inputs.map(([name,frames])=>({name,history:{replica:f.space.replica,frames,rejected:[]}}))};
}
function summary(d:TreehouseCatalogTrustDecision){
 const state=d.kind==="reject"?null:d.next;
 return {kind:d.kind,reason:d.reason,ids:d.detail.ids,accepted:state?.accepted??null,blocked:state?.blocked?.reason??null,routes:d.kind==="reject"?[]:d.routes.map(r=>r.replica).sort(),histories:state===null?[]:state.histories.map(h=>[h.replica,h.frames.map(f=>(f as {id:string}).id).sort()]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))),catalogs:state?.catalogs.map(c=>c.id).sort()??[],rotations:state?.rotations.map(r=>r.id).sort()??[]};
}
async function run(bundle:Bundle){
 const prepared=await prepareTreehouseCatalogInstallation({review:bundle.review,history:bundle.histories.find(h=>h.replica===bundle.review.space)!,store:{kind:"verified_fresh",expected}});
 assert.equal(prepared.kind,"propose");
 const first=await evaluateTreehouseCatalogTrust({installed:prepared.next,expected,incoming:{...page(bundle.histories),catalogs:[bundle.catalogJson,bundle.advancedCatalogJson]}});
 assert.equal(first.kind,"propose");assert.equal(first.next.accepted?.revision,1);assert.equal(first.routes.length,2);
 const frozen=await evaluateTreehouseCatalogTrust({installed:first.next,expected,incoming:page([bundle.forkHistory])});
 assert.equal(frozen.kind,"retain_blocked");assert.equal(frozen.reason,"catalog_fork");assert.deepEqual(frozen.next.accepted,first.next.accepted);
 const observations=[];
 for(const [label,original] of [["accepted",first.next],["blocked",frozen.next]] as const){
  const base:InstalledTreehouseCatalogTrustV1=JSON.parse(JSON.stringify(original));
  const before=JSON.stringify(base);
  for(const [name,incoming] of [["reopen",page()],["older-catalog",{...page(),catalogs:[bundle.catalogJson]}],...bundle.cases.map(c=>[c.name,page([c.history])] as const)] as const){
   const decision=await evaluateTreehouseCatalogTrust({installed:base,expected,incoming});
   assert.equal(JSON.stringify(base),before,"incoming processing mutated retained input");
   if(name==="reopen"){assert.equal(decision.kind,label==="accepted"?"unchanged":"retain_blocked");assert.equal(decision.reason,label==="accepted"?null:"catalog_fork");}
   if(decision.kind!=="reject"){
    assert.deepEqual(decision.next.accepted,base.accepted,"accepted watermark changed");
    if(base.blocked!==null){assert.deepEqual(decision.next.blocked,base.blocked);assert.deepEqual(decision.routes,[]);}
    for(const h of base.histories){const retained:TreehouseCatalogRawHistory=decision.next.histories.find((n:TreehouseCatalogRawHistory)=>n.replica===h.replica)!;for(const frame of h.frames)assert.deepEqual(retained.frames.find((n:unknown)=>(n as {id:string}).id===(frame as {id:string}).id),frame);for(const rejected of h.rejected)assert.ok(retained.rejected.some(n=>JSON.stringify(n)===JSON.stringify(rejected)));}
    if(name==="reopen")assert.deepEqual(decision.next,base);
   }
   observations.push({name:`${label}:${name}`,decision:summary(decision)});
  }
  for(const defect of ["signature","unportable-depth","watermark"] as const){
   const damaged:InstalledTreehouseCatalogTrustV1=JSON.parse(before);
   const h=damaged.histories.find(h=>h.replica===bundle.review.space)!;
   if(defect==="signature")h.frames=h.frames.map((f,n)=>n===0?{...(f as object),sig:Buffer.alloc(64).toString("base64")}:f);
   else if(defect==="unportable-depth")h.frames=[...h.frames,bundle.deepFrame];
   else damaged.accepted={...damaged.accepted!,revision:0};
   for(const [name,incoming] of [["repair",page(bundle.histories)],["malformed",JSON.parse('{"catalogs":[],"rotations":[],"histories":null,"cutoffProofs":[]}')]] as const){
    const decision=await evaluateTreehouseCatalogTrust({installed:damaged,expected,incoming});
    assert.equal(decision.kind,"reject");assert.equal(decision.reason,"trust_recovery_required");
    observations.push({name:`${label}:corrupt-${defect}:${name}`,decision:summary(decision)});
   }
  }
 }
 return observations;
}
const bundle:Bundle=process.argv[2]==="consume"?JSON.parse(readFileSync(process.argv[3]!,"utf8")):await produce();
console.log(JSON.stringify({bundle,observations:await run(bundle)}));
