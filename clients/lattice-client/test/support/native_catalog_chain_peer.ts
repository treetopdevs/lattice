// Actual public trust decisions, with structural links decoded from the returned
// evidence. This corpus does not turn structural heads into a native trust verdict.
import assert from "node:assert/strict";
import {trustFixture,signedCatalog,signedRotation,fixtureId} from "./export_treehouse_catalog_trust";
import {prepareTreehouseCatalogInstallation,evaluateTreehouseCatalogTrust} from "../../src/treehouse_catalog_trust";
import {catalogEnvelopeFromCarrierTerm,catalogRotationEnvelopeFromCarrierTerm,catalogRotationId,transportCatalogId} from "../../src/treehouse_catalog_codec";
import type {TreehouseCatalogTrustDecision} from "../../src/treehouse_catalog_trust";
import type {TransportCatalog,CatalogRotation} from "../../src/treehouse_catalog_codec";
const f=await trustFixture(2), expected={trustRevision:0,historyGeneration:0};
const prepared=await prepareTreehouseCatalogInstallation({review:f.review,history:f.histories[0]!,store:{kind:"verified_fresh",expected}});
assert.equal(prepared.kind,"propose");
const initial=prepared.next;
const firstId=transportCatalogId(f.catalog);
const revision=(previous=firstId,n=1):TransportCatalog=>({...f.catalog,revision:n,previous});
const cases:{name:string;catalogs:string[];rotations:string[];result:TreehouseCatalogTrustDecision;links?:object}[]=[];
async function add(name:string,catalogs:string[],rotations:string[],reason:string|null=null){
 const result=await evaluateTreehouseCatalogTrust({installed:initial,expected,incoming:{catalogs,rotations,histories:f.histories,cutoffProofs:f.cutoffProofs}});
 assert.equal(result.reason,reason,name);
 if(reason===null){assert.equal(result.kind,"propose",name);assert.notEqual(result.next.accepted,null,name);assert.equal(result.routes.length,3,name);}
 else if(reason==="catalog_fork"){assert.equal(result.kind,"retain_blocked",name);assert.deepEqual(result.routes,[],name);}
 else {assert.equal(result.kind,"reject",name);}
 cases.push({name,catalogs,rotations,result});
}
await add("initial",[f.catalogJson],[]);
const one=revision(), oneJson=await signedCatalog(one,f.catalogSigner),two=revision(transportCatalogId(one),2);
await add("linear-revisions",[await signedCatalog(two,f.catalogSigner),oneJson,f.catalogJson],[]);
await add("identical-retry",[f.catalogJson,JSON.stringify(JSON.parse(f.catalogJson),null,1)],[]);
await add("revision-gap",[f.catalogJson,await signedCatalog(revision(firstId,2),f.catalogSigner)],[],"invalid_catalog_transition");
await add("missing-predecessor",[await signedCatalog(revision(fixtureId("absent-previous")),f.catalogSigner)],[],"trust_pending");
await add("inventory-shrink",[f.catalogJson,await signedCatalog({...one,entries:one.entries.filter(e=>e.kind==="space")},f.catalogSigner)],[],"invalid_catalog_transition");
await add("changed-entry-identity",[f.catalogJson,await signedCatalog({...one,entries:one.entries.map(e=>e.kind==="thread"?{...e,root:f.bootstrapRecord.spaceRoot}:e)},f.catalogSigner)],[],"invalid_catalog_transition");
await add("wrong-service",[await signedCatalog({...f.catalog,entries:f.catalog.entries.map(e=>({...e,serviceId:fixtureId("wrong-service")}))},f.catalogSigner)],[],"wrong_catalog_scope");
const wrongBootstrap=fixtureId("wrong-bootstrap");
await add("wrong-bootstrap-scope",[await signedCatalog({...f.catalog,bootstrap:wrongBootstrap,entries:f.catalog.entries.map(e=>e.kind==="space"?{...e,reference:wrongBootstrap}:e)},f.catalogSigner)],[],"wrong_catalog_scope");
function corruptSignature(json:string,field:string){const term=JSON.parse(json);const pair=term[1].find((pair:unknown[])=>JSON.stringify(pair[0])===JSON.stringify(["atom",field]));pair[1]=["bin",Buffer.alloc(64).toString("base64")];return JSON.stringify(term);}
await add("conflicting-signature",[f.catalogJson,corruptSignature(f.catalogJson,"signature")],[],"invalid_catalog_signature");
await add("forgery-before-missing-predecessor",[corruptSignature(await signedCatalog(revision(fixtureId("absent-previous")),f.catalogSigner),"signature")],[],"invalid_catalog_signature");
const rotation=catalogRotationEnvelopeFromCarrierTerm(JSON.parse(f.rotationJson))!;
async function rotationCase(name:string,value:CatalogRotation,reason:string|null=null,mode="normal"){
 let json=await signedRotation(value,f.catalogSigner,mode==="same-key"?f.catalogSigner:mode==="service-key"?f.serviceSigner:f.nextCatalogSigner);
 if(mode==="old-forgery")json=corruptSignature(json,"old_signature");
 if(mode==="new-forgery")json=corruptSignature(json,"new_signature");
 const envelope=catalogRotationEnvelopeFromCarrierTerm(JSON.parse(json))!;
 const catalog=await signedCatalog({...f.catalog,binding:catalogRotationId(envelope)},mode==="same-key"?f.catalogSigner:mode==="service-key"?f.serviceSigner:f.nextCatalogSigner);
 await add(name,[catalog,f.catalogJson],[json],reason);
}
await rotationCase("rotation",rotation.rotation);
await rotationCase("rotation-generation-gap",{...rotation.rotation,generation:2},"invalid_catalog_transition");
await rotationCase("rotation-same-key",{...rotation.rotation,newCatalogKey:f.bootstrapRecord.catalogKey},"invalid_catalog_transition","same-key");
await rotationCase("rotation-service-key",{...rotation.rotation,newCatalogKey:f.bootstrapRecord.serviceKey},"invalid_catalog_transition","service-key");
await rotationCase("rotation-bad-old-signature",rotation.rotation,"invalid_catalog_signature","old-forgery");
await rotationCase("rotation-bad-possession",rotation.rotation,"invalid_possession","new-forgery");
await rotationCase("rotation-inventory-mismatch",{...rotation.rotation,inventoryDigest:fixtureId("wrong-inventory")},"invalid_catalog_transition");
await rotationCase("rotation-cutoff-replica-mismatch",{...rotation.rotation,cutoffs:rotation.rotation.cutoffs.slice(0,1)},"invalid_catalog_transition");
await rotationCase("rotation-missing-parent",{...rotation.rotation,parent:fixtureId("missing-binding")},"trust_pending");
const sibling={...one,entries:one.entries.map(e=>({...e,route:`/r/${fixtureId(`branch-${e.replica}`)}`}))};
await add("catalog-siblings",[f.catalogJson,oneJson,await signedCatalog(sibling,f.catalogSigner)],[],"catalog_fork");
// The accepted source records, rather than a hand-authored successful verdict,
// provide each expected link. Fork policy remains outside the native link proof.
for(const item of cases){
 const result=item.result;
 if(result.kind==="reject")continue;
 const bindings:Record<string,unknown>={[f.bootstrap.id]:{generation:0,key:[...f.catalogSigner.publicKey],parent:null,prior:null,inventory:null}};
 for(const record of result.next.rotations){const r=catalogRotationEnvelopeFromCarrierTerm(JSON.parse(record.json))!.rotation;bindings[record.id]={generation:r.generation,key:[...Buffer.from(r.newCatalogKey,"base64")],parent:r.parent,prior:r.priorCatalog,inventory:r.inventoryDigest};}
 const catalogs:Record<string,unknown>={};
 const decoded=result.next.catalogs.map(record=>({id:record.id,c:catalogEnvelopeFromCarrierTerm(JSON.parse(record.json))!.catalog}));
 for(const {id,c} of decoded)catalogs[id]={binding:c.binding,revision:c.revision,previous:c.previous};
 const catalog_heads=Object.fromEntries(result.observed.catalogHeads.map(group=>[group.binding,group.catalogs]));
 if(result.next.accepted!==null){
  assert.equal((bindings[result.next.accepted.binding] as {generation:number}).generation,result.next.accepted.generation,item.name);
 }
 Object.assign(item,{links:{bindings,catalogs,catalog_heads,binding_heads:result.observed.bindingHeads}});
}
console.log(JSON.stringify({review:f.review,histories:f.histories,cutoffProofs:f.cutoffProofs,bootstrapCatalog:f.catalogJson,cases}));
