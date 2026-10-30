import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {trustFixture,signedCatalog,fixtureId,fixtureSigner} from "./export_treehouse_catalog_trust";
import {authorTreehouseRoleTransfer} from "../../src/treehouse";
import {authorCarrierOp} from "../../src/codec";
import {catalogEnvelopeFromCarrierTerm,transportCatalogId} from "../../src/treehouse_catalog_codec";
import type {CatalogEntry} from "../../src/treehouse_catalog_codec";
import {prepareTreehouseCatalogInstallation,evaluateTreehouseCatalogTrust} from "../../src/treehouse_catalog_trust";
import type {TreehouseCatalogBootstrapReview,TreehouseCatalogRawHistory,InstalledTreehouseCatalogTrustV1} from "../../src/treehouse_catalog_trust";
type Case={name:string;catalogJson:string;histories:TreehouseCatalogRawHistory[];reason:string|null};
type Frozen={baseCatalogJson:string;baseHistories:TreehouseCatalogRawHistory[];freezeHistories:TreehouseCatalogRawHistory[];cases:(Case&{retain?:boolean;catalogs?:string[]})[]};
type Bundle={frozen?:Frozen;review:TreehouseCatalogBootstrapReview;histories:TreehouseCatalogRawHistory[];cutoffProofs:[];catalogJson:string;cases:Case[]};
async function produce():Promise<Bundle>{
 const f=await trustFixture(1),t=f.threads[0]!,missing=fixtureId("missing-entry-item"),stranger=fixtureSigner("entry-priority-stranger");
 const text=(s:string):["bin",string]=>["bin",Buffer.from(s).toString("base64")];
 const deniedCreation=await authorCarrierOp({replica:t.replica,signer:stranger,deps:[t.genesis.id],kind:"command",cap:t.creation.cap,body:["tuple",[["atom","create_thread"],["list",[text("Denied")]]]]});
 const deniedReference=await authorCarrierOp({replica:f.space.replica,signer:stranger,deps:[f.space.frames.at(-1)!.id],kind:"command",cap:f.space.creation.cap,body:["tuple",[["atom","create_thread"],["list",[text(t.replica),text("Denied")]]]]});
 const malformedCreation=await authorCarrierOp({replica:t.replica,signer:t.signer,deps:[t.genesis.id],kind:"command",cap:t.creation.cap,body:["tuple",[["atom","create_thread"],["list",[]]]]});
 const missingChild=f.histories.filter(h=>h.replica!==t.replica);
 const extra=(await trustFixture(2)).threads[1]!;
 const unrelated:TreehouseCatalogRawHistory={replica:extra.replica,frames:extra.frames.map((frame,i)=>i===0?{...frame,sig:Buffer.alloc(64).toString("base64")}:frame),rejected:[]};
 const add=(replica:string,frame:typeof deniedCreation)=>f.histories.map(h=>h.replica===replica?{...h,frames:[...h.frames,frame]}:h);
 const inputs:[string,Partial<CatalogEntry>,TreehouseCatalogRawHistory[],string|null][]=[
  ["complete",{},f.histories,null],
  ["missing_genesis",{genesis:missing},f.histories,"trust_pending"],
  ["missing_creation",{creation:missing},f.histories,"trust_pending"],
  ["missing_reference",{reference:missing},f.histories,"trust_pending"],
  ["missing_child",{},missingChild,"trust_pending"],
  ["missing_child_wrong_root",{root:f.bootstrapRecord.spaceRoot},missingChild,"trust_pending"],
  ["missing_child_wrong_reference",{reference:f.space.creation.id},missingChild,"trust_pending"],
  ["root_missing_creation",{root:f.bootstrapRecord.spaceRoot,creation:missing},f.histories,"invalid_catalog_transition"],
  ["root_missing_genesis",{root:f.bootstrapRecord.spaceRoot,genesis:missing},f.histories,"invalid_catalog_transition"],
  ["genesis_kind_missing_creation",{genesis:t.creation.id,creation:missing},f.histories,"invalid_catalog_transition"],
  ["creation_kind_missing_genesis",{creation:t.genesis.id,genesis:missing},f.histories,"invalid_catalog_transition"],
  ["reference_kind_missing_creation",{reference:f.space.creation.id,creation:missing},f.histories,"invalid_catalog_transition"],
  ["reference_kind_missing_genesis",{reference:f.space.creation.id,genesis:missing},f.histories,"invalid_catalog_transition"],
  ["refused_creation_missing_genesis",{creation:deniedCreation.id,genesis:missing},add(t.replica,deniedCreation),"invalid_catalog_transition"],
  ["refused_reference_missing_creation",{reference:deniedReference.id,creation:missing},add(f.space.replica,deniedReference),"invalid_catalog_transition"],
  ["malformed_creation_missing_genesis",{creation:malformedCreation.id,genesis:missing},add(t.replica,malformedCreation),"invalid_catalog_transition"],
  ["empty_child",{},f.histories.map(h=>h.replica===t.replica?{...h,frames:[]}:h),"invalid_catalog_transition"],
  ["unrelated_forgery",{root:f.bootstrapRecord.spaceRoot,creation:missing},[...f.histories,unrelated],"invalid_verified_history"],
 ];
 const cases:Case[]=[];
 for(const [name,edits,histories,reason] of inputs){
  const catalog={...f.catalog,entries:f.catalog.entries.map(e=>e.kind==="thread"?{...e,...edits}:e)};
  cases.push({name,catalogJson:await signedCatalog(catalog,f.catalogSigner),histories,reason});
 }
 const baseCatalogJson=await signedCatalog({...f.catalog,entries:f.catalog.entries.filter(e=>e.kind==="space")},f.catalogSigner);

 const pending=cases.find(c=>c.name==="refused_creation_missing_genesis")!;
 const pendingRecord=catalogEnvelopeFromCarrierTerm(JSON.parse(pending.catalogJson))!.catalog;
 const child=await signedCatalog({...pendingRecord,revision:1,previous:transportCatalogId(pendingRecord)},f.catalogSigner);
 const frozenCases=(cases.filter(c=>["refused_creation_missing_genesis","refused_reference_missing_creation","malformed_creation_missing_genesis","root_missing_creation"].includes(c.name))).map(c=>({...c,retain:c.name!=="root_missing_creation"}));
 const frozen:Frozen={baseCatalogJson,baseHistories:f.histories.filter(h=>h.replica===f.space.replica),freezeHistories:await freezeHistories(f),cases:[...frozenCases,{...pending,name:"same_inventory_cache",catalogs:[pending.catalogJson,child]}]};
 return {review:f.review,histories:f.histories,cutoffProofs:[],catalogJson:f.catalogJson,cases,frozen};
}
async function freezeHistories(f:Awaited<ReturnType<typeof trustFixture>>){
 const {frame:transfer}=await authorTreehouseRoleTransfer({replica:f.space.replica,deps:[f.space.creation.id],signer:f.root,recipient:fixtureSigner("entry-frozen-successor").publicKey,parent:f.space.delegation,action:"transfer_admin"});
 return [{...f.histories[0]!,frames:[...f.space.frames,transfer]}];
}
async function produceMulti():Promise<Bundle>{
 const f=await trustFixture(2),threads=[...f.threads].sort((a,b)=>Buffer.compare(Buffer.from(a.replica),Buffer.from(b.replica))),first=threads[0]!,second=threads[1]!,missing=fixtureId("multi-missing"),stranger=fixtureSigner("multi-stranger");
 const text=(s:string):["bin",string]=>["bin",Buffer.from(s).toString("base64")];
 const denied=await Promise.all([first,second].map(t=>authorCarrierOp({replica:t.replica,signer:stranger,deps:[t.genesis.id],kind:"command",cap:t.creation.cap,body:["tuple",[["atom","create_thread"],["list",[text("Denied")]]]]})));
 const deniedSpace=await authorCarrierOp({replica:f.space.replica,signer:stranger,deps:[f.space.genesis.id],kind:"command",cap:f.space.creation.cap,body:["tuple",[["atom","create_space"],["list",[]]]]});
 const histories=f.histories.map(h=>h.replica===f.space.replica?{...h,frames:[...h.frames,deniedSpace]}:h.replica===first.replica?{...h,frames:[...h.frames,denied[0]!]}:h.replica===second.replica?{...h,frames:[...h.frames,denied[1]!]}:h);
 const variants:[string,Record<string,Partial<CatalogEntry>>][]=[
  ["pending_then_invalid",{[first.replica]:{genesis:missing},[second.replica]:{root:f.bootstrapRecord.spaceRoot}}],
  ["invalid_then_pending",{[first.replica]:{root:f.bootstrapRecord.spaceRoot},[second.replica]:{genesis:missing}}],
  ["first_invalid_only",{[first.replica]:{root:f.bootstrapRecord.spaceRoot},[second.replica]:{creation:denied[1]!.id}}],
  ["first_refused_only",{[first.replica]:{creation:denied[0]!.id},[second.replica]:{root:f.bootstrapRecord.spaceRoot}}],
  ["first_refused_clean_sibling",{[first.replica]:{creation:denied[0]!.id,genesis:missing}}],
  ["second_refused_clean_sibling",{[second.replica]:{creation:denied[1]!.id,genesis:missing}}],
  ["space_refused_and_missing",{[f.space.replica]:{genesis:missing,creation:deniedSpace.id}}],
  ["space_invalid_and_missing",{[f.space.replica]:{genesis:missing,creation:f.space.genesis.id}}],
 ];
 const cases:Case[]=[];
 for(const [name,edits] of variants)cases.push({name,catalogJson:await signedCatalog({...f.catalog,entries:f.catalog.entries.map(e=>({...e,...edits[e.replica]}))},f.catalogSigner),histories,reason:"invalid_catalog_transition"});
 const frozen:Frozen={baseCatalogJson:await signedCatalog({...f.catalog,entries:f.catalog.entries.filter(e=>e.kind==="space")},f.catalogSigner),baseHistories:[f.histories[0]!],freezeHistories:await freezeHistories(f),cases:cases.map(c=>({...c,retain:["first_refused_clean_sibling","second_refused_clean_sibling","space_refused_and_missing"].includes(c.name)}))};
 return {review:f.review,histories:f.histories,cutoffProofs:[],catalogJson:f.catalogJson,cases,frozen};
}
const b:Bundle=process.argv[2]?.startsWith("consume")?JSON.parse(readFileSync(process.argv[3]!,"utf8")):process.argv[2]==="multi"?await produceMulti():await produce();
const expected={trustRevision:0,historyGeneration:0};
const p=await prepareTreehouseCatalogInstallation({review:b.review,history:b.histories[0]!,store:{kind:"verified_fresh",expected}});
assert.equal(p.kind,"propose");
async function run(installed:InstalledTreehouseCatalogTrustV1,json:string|null|string[],histories:TreehouseCatalogRawHistory[]){
 const incoming={catalogs:Array.isArray(json)?json:json===null?[]:[json],rotations:[],histories,cutoffProofs:[]};
 const beforeState=JSON.stringify(installed),beforePage=JSON.stringify(incoming);
 const result=await evaluateTreehouseCatalogTrust({installed,expected,incoming});
 assert.equal(JSON.stringify(installed),beforeState);assert.equal(JSON.stringify(incoming),beforePage);
 return result;
}
const intact=await run(p.next,b.catalogJson,b.histories);
assert.equal(intact.kind,"propose");assert.equal(intact.routes.length,catalogEnvelopeFromCarrierTerm(JSON.parse(b.catalogJson))!.catalog.entries.length);
const results=[];
for(const c of b.cases){
 const orders=[];
 for(const reverse of [false,true]){
  const histories=reverse?[...c.histories].reverse().map(h=>({...h,frames:[...h.frames].reverse()})):c.histories;
  const decision=await run(p.next,c.catalogJson,histories);
  assert.equal(decision.reason,c.reason,c.name);
  if(c.reason!==null&&c.reason!=="trust_pending")assert.equal(decision.kind,"reject");else assert.equal(decision.kind,"propose");
  let saved=null;
  if(c.reason!==null&&c.reason!=="trust_pending"){
   const catalog=catalogEnvelopeFromCarrierTerm(JSON.parse(c.catalogJson))!;
   const broken={...p.next,histories,catalogs:[{id:transportCatalogId(catalog.catalog),json:c.catalogJson}]};
   saved=await run(broken,b.catalogJson,b.histories);
   assert.equal(saved.kind,"reject");assert.equal(saved.reason,"trust_recovery_required");
  }
  orders.push({decision,saved});
 }
 results.push({name:c.name,orders});
}
let frozenResults=null;
if(b.frozen){
 const base=await run(p.next,b.frozen.baseCatalogJson,b.frozen.baseHistories);assert.equal(base.kind,"propose");
 const setup=await run(base.next,null,b.frozen.freezeHistories);assert.equal(setup.kind,"retain_blocked");assert.equal(setup.reason,"authority_changed");
 const cases=[];
 for(const c of b.frozen.cases){
  const orders=[];
  for(const reverse of [false,true]){
   const histories=reverse?[...c.histories].reverse().map(h=>({...h,frames:[...h.frames].reverse()})):c.histories;
   const catalogs=c.catalogs?(reverse?[...c.catalogs].reverse():c.catalogs):c.catalogJson;
   const decision=await run(setup.next,catalogs,histories);assert.equal(decision.kind,"retain_blocked");assert.equal(decision.reason,"authority_changed");
   const id=transportCatalogId(catalogEnvelopeFromCarrierTerm(JSON.parse(c.catalogJson))!.catalog);assert.equal(decision.next.catalogs.some(row=>row.id===id),c.retain??true,c.name);
   const reopened=await run(decision.next,null,[]);assert.equal(reopened.kind,"retain_blocked");assert.deepEqual(reopened.next,decision.next);
   orders.push({decision,reopened});
  }
  cases.push({name:c.name,orders});
 }
 frozenResults={base,setup,cases};
}
console.log(JSON.stringify({bundle:b,intact,results,frozenResults}));
