import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {trustFixture,signedCatalog,signedRotation} from "./export_treehouse_catalog_trust";
import {catalogRotationEnvelopeFromCarrierTerm,catalogRotationEnvelopeToCarrierTerm,catalogRotationId,transportCatalogId,catalogEnvelopeFromCarrierTerm} from "../../src/treehouse_catalog_codec";
import {prepareTreehouseCatalogInstallation,evaluateTreehouseCatalogTrust} from "../../src/treehouse_catalog_trust";
import type {TreehouseCatalogTrustDecision,TreehouseCatalogBootstrapReview,TreehouseCatalogRawHistory,TreehouseCatalogCutoffProof,InstalledTreehouseCatalogTrustV1} from "../../src/treehouse_catalog_trust";
type Case={name:string;catalogs:string[];rotations:string[];reason:string|null;generation?:number};
type Bundle={review:TreehouseCatalogBootstrapReview;histories:TreehouseCatalogRawHistory[];cutoffProofs:TreehouseCatalogCutoffProof[];catalogJson:string;rotationJson:string;rotatedCatalogJson:string;cases:Case[]};
async function produce():Promise<Bundle>{
 const f=await trustFixture();const r1=catalogRotationEnvelopeFromCarrierTerm(JSON.parse(f.rotationJson))!;
 const c1={...f.catalog,binding:catalogRotationId(r1)};
 const c1json=await signedCatalog(c1,f.nextCatalogSigner);
 const cases:Case[]=[];
 for(const hop of [0,1]) for(const mode of ["genuine","old-forged","possession-forged"]){
  const signer=hop===0?f.catalogSigner:f.nextCatalogSigner;
  const r={...f.rotation,parent:hop===0?f.bootstrap.id:catalogRotationId(r1),priorCatalog:hop===0?transportCatalogId(f.catalog):transportCatalogId(c1),generation:hop+1,newCatalogKey:Buffer.from(signer.publicKey).toString("base64")};
  const e=catalogRotationEnvelopeFromCarrierTerm(JSON.parse(await signedRotation(r,signer,signer)))!;
  if(mode==="old-forged")e.oldSignature=Buffer.alloc(64).toString("base64");
  if(mode==="possession-forged")e.newSignature=Buffer.alloc(64).toString("base64");
  const json=JSON.stringify(catalogRotationEnvelopeToCarrierTerm(e));
  const cjson=await signedCatalog({...f.catalog,binding:catalogRotationId(e)},signer);
  cases.push({name:`noop-hop${hop}-${mode}`,catalogs:hop===0?[f.catalogJson,cjson]:[f.catalogJson,c1json,cjson],rotations:hop===0?[json]:[f.rotationJson,json],reason:"invalid_catalog_transition"});
 }
 for(const mode of ["genuine","old-forged","possession-forged"]){
  const e=catalogRotationEnvelopeFromCarrierTerm(JSON.parse(f.rotationJson))!;
  if(mode==="old-forged")e.oldSignature=Buffer.alloc(64).toString("base64");
  if(mode==="possession-forged")e.newSignature=Buffer.alloc(64).toString("base64");
  const cjson=await signedCatalog({...f.catalog,binding:catalogRotationId(e)},f.nextCatalogSigner);
  cases.push({name:`distinct-${mode}`,catalogs:[f.catalogJson,cjson],rotations:[JSON.stringify(catalogRotationEnvelopeToCarrierTerm(e))],reason:mode==="genuine"?null:mode==="old-forged"?"invalid_catalog_signature":"invalid_possession"});
 }
 const back={...f.rotation,parent:catalogRotationId(r1),priorCatalog:transportCatalogId(c1),generation:2,newCatalogKey:f.bootstrapRecord.catalogKey};
 const backJson=await signedRotation(back,f.nextCatalogSigner,f.catalogSigner);
 const backEnvelope=catalogRotationEnvelopeFromCarrierTerm(JSON.parse(backJson))!;
 const backCatalog=await signedCatalog({...f.catalog,binding:catalogRotationId(backEnvelope)},f.catalogSigner);
 cases.push({name:"authorized-ancestor-key-return",catalogs:[f.catalogJson,c1json,backCatalog],rotations:[f.rotationJson,backJson],reason:null,generation:2});
 cases.push({...cases[0]!,name:"noop-rotation-only",catalogs:[f.catalogJson]});
 return {review:f.review,histories:f.histories,cutoffProofs:f.cutoffProofs,catalogJson:f.catalogJson,rotationJson:f.rotationJson,rotatedCatalogJson:c1json,cases};
}
const b:Bundle=process.argv[2]==="consume"?JSON.parse(readFileSync(process.argv[3]!,"utf8")):await produce();
const expected={trustRevision:0,historyGeneration:0};
const prepared=await prepareTreehouseCatalogInstallation({review:b.review,history:b.histories[0]!,store:{kind:"verified_fresh",expected}});
assert.equal(prepared.kind,"propose");
async function run(installed:InstalledTreehouseCatalogTrustV1,catalogs:string[],rotations:string[]):Promise<TreehouseCatalogTrustDecision>{
 const incoming={catalogs,rotations,histories:b.histories,cutoffProofs:b.cutoffProofs};
 const beforeState=JSON.stringify(installed),beforePage=JSON.stringify(incoming);
 const result=await evaluateTreehouseCatalogTrust({installed,expected,incoming});
 assert.equal(JSON.stringify(installed),beforeState);assert.equal(JSON.stringify(incoming),beforePage);
 return result;
}
const base=await run(prepared.next,[b.catalogJson],[]);assert.equal(base.kind,"propose");
const repair=await run(base.next,[b.catalogJson,b.rotatedCatalogJson],[b.rotationJson]);
assert.equal(repair.kind,"propose");assert.equal(repair.reason,null);assert.equal(repair.next.accepted?.generation,1);assert.equal(repair.routes.length,2);
const results:{name:string;decisions:TreehouseCatalogTrustDecision[];saved:TreehouseCatalogTrustDecision|null}[]=[];
for(const c of b.cases){
 const decisions:TreehouseCatalogTrustDecision[]=[];
 const states:InstalledTreehouseCatalogTrustV1[]=[prepared.next,base.next];
 for(const state of states){
  const d=await run(state,c.catalogs,c.rotations);
  assert.equal(d.reason,c.reason,c.name);
  if(c.reason===null){assert.equal(d.kind,"propose");assert.equal(d.next.accepted?.generation,c.generation??1);assert.equal(d.routes.length,2);}
  else assert.equal(d.kind,"reject");
  decisions.push(d);
 }
 const broken:InstalledTreehouseCatalogTrustV1=structuredClone(base.next);
 broken.catalogs=c.catalogs.map(json=>({id:transportCatalogId(catalogEnvelopeFromCarrierTerm(JSON.parse(json))!.catalog),json})).sort((a,b)=>Buffer.compare(Buffer.from(a.id),Buffer.from(b.id)));
 broken.rotations=c.rotations.map(json=>({id:catalogRotationId(catalogRotationEnvelopeFromCarrierTerm(JSON.parse(json))!),json})).sort((a,b)=>Buffer.compare(Buffer.from(a.id),Buffer.from(b.id)));
 const saved:TreehouseCatalogTrustDecision|null=c.reason===null?null:await run(broken,[b.catalogJson,b.rotatedCatalogJson],[b.rotationJson]);
 if(saved!==null){assert.equal(saved.kind,"reject");assert.equal(saved.reason,"trust_recovery_required");}
 results.push({name:c.name,decisions,saved});
}
console.log(JSON.stringify({bundle:b,base,repair,results}));
