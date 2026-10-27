// Fresh complete-decision contract for the private native incoming fold.
import assert from "node:assert/strict";
import {trustFixture,fixtureId,fixtureSigner,signedCatalog} from "./export_treehouse_catalog_trust";
import {authorCarrierOp} from "../../src/codec";
import {authorTreehouseRoleTransfer} from "../../src/treehouse";
import {transportCatalogId} from "../../src/treehouse_catalog_codec";
import {prepareTreehouseCatalogInstallation,evaluateTreehouseCatalogTrust} from "../../src/treehouse_catalog_trust";
import type {TreehouseCatalogEvidencePage,InstalledTreehouseCatalogTrustV1,TreehouseCatalogTrustReason} from "../../src/treehouse_catalog_trust";
type Input=Parameters<typeof evaluateTreehouseCatalogTrust>[0];
type Decision=Awaited<ReturnType<typeof evaluateTreehouseCatalogTrust>>;
const expected={trustRevision:0,historyGeneration:0};
const empty=():TreehouseCatalogEvidencePage=>({catalogs:[],rotations:[],histories:[],cutoffProofs:[]});
async function install(f:Awaited<ReturnType<typeof trustFixture>>){
  const prepared=await prepareTreehouseCatalogInstallation({review:f.review,history:f.histories[0]!,store:{kind:"verified_fresh",expected}});
  assert.equal(prepared.kind,"propose");
  const accepted=await evaluateTreehouseCatalogTrust({installed:prepared.next,expected,incoming:{...empty(),catalogs:[f.catalogJson],histories:f.histories}});
  assert.equal(accepted.kind,"propose");return accepted;
}
const f=await trustFixture(1),accepted=await install(f);
const inputs:{name:string;input:Input;kind:Decision["kind"];reason:TreehouseCatalogTrustReason|null}[]=[];
function add(name:string,installed:InstalledTreehouseCatalogTrustV1,incoming:TreehouseCatalogEvidencePage,kind:Decision["kind"],reason:TreehouseCatalogTrustReason|null){
  inputs.push({name,input:{installed:structuredClone(installed),expected:{...expected},incoming:structuredClone(incoming)},kind,reason});
}
const malformed={...empty(),catalogs:["not JSON"]};
add("unblocked-malformed-artifact",accepted.next,malformed,"reject","malformed_catalog");
add("unblocked-malformed-proof",accepted.next,{...empty(),cutoffProofs:[{} as never]},"reject","malformed_catalog");
add("page-count-before-artifact-parsing",accepted.next,{...empty(),catalogs:Array(33).fill("not JSON")},"reject","control_history_limit");
add("duplicate-incoming-history",accepted.next,{...empty(),histories:[f.histories[0]!,f.histories[0]!]},"reject","invalid_verified_history");
add("wrong-family-before-authentication",accepted.next,{...empty(),histories:[{replica:"foreign",frames:[],rejected:[]}]},"reject","wrong_catalog_scope");
add("empty-replica-is-page-shape-error",accepted.next,{...empty(),histories:[{replica:"",frames:[],rejected:[]}]},"reject","malformed_catalog");
add("duplicate-catalog-keeps-first-raw-json",accepted.next,{...empty(),catalogs:[" \n"+f.catalogJson]},"unchanged",null);
const beacon=await authorCarrierOp({replica:f.space.replica,signer:f.root,deps:[f.space.frames.at(-1)!.id],kind:"authority",body:["tuple",[["atom","beacon"],["int",1]]],cap:["nil"]});
const partial=await authorCarrierOp({replica:f.space.replica,signer:f.root,deps:[fixtureId("incoming-absent-dependency")],kind:"authority",body:["tuple",[["atom","beacon"],["int",1]]],cap:["nil"]});
const forged={...partial,sig:Buffer.alloc(64).toString("base64")};
const history=(frame:unknown)=>({replica:f.space.replica,frames:[frame],rejected:[]});
add("authentic-partial-requires-ancestors",accepted.next,{...empty(),histories:[history(partial)]},"reject","trust_pending");
add("forged-partial-cannot-request-ancestors",accepted.next,{...empty(),histories:[history(forged)]},"reject","invalid_verified_history");
add("authentic-frame-cannot-be-rejected-evidence",accepted.next,{...empty(),histories:[{replica:f.space.replica,frames:[],rejected:[{frame:beacon,reason:"bad_signature"}]}]},"reject","invalid_verified_history");
add("fresh-bad-signature-evidence-is-retained",accepted.next,{...empty(),histories:[{replica:f.space.replica,frames:[],rejected:[{frame:{...beacon,sig:Buffer.alloc(64).toString("base64")},reason:"bad_signature"}]}]},"propose",null);
const {frame:transfer}=await authorTreehouseRoleTransfer({replica:f.space.replica,deps:[f.space.creation.id],signer:f.root,parent:f.space.delegation,
  recipient:fixtureSigner("incoming-role-successor").publicKey,action:"transfer_admin"});
const changed={...f.histories[0]!,frames:[...f.space.frames,transfer]};
const authority=await evaluateTreehouseCatalogTrust({installed:accepted.next,expected,incoming:{...empty(),histories:[changed]}});
assert.equal(authority.kind,"retain_blocked");assert.equal(authority.reason,"authority_changed");
add("new-authority-freeze-survives-malformed-artifact",accepted.next,{...malformed,histories:[changed]},"retain_blocked","authority_changed");
add("saved-authority-freeze-survives-malformed-artifact",authority.next,malformed,"retain_blocked","authority_changed");
add("saved-authority-freeze-survives-malformed-proof",authority.next,{...empty(),cutoffProofs:[{} as never]},"retain_blocked","authority_changed");
add("saved-freeze-does-not-hide-forged-history",authority.next,{...empty(),histories:[history(forged)]},"reject","invalid_verified_history");
add("saved-freeze-does-not-hide-page-limit",authority.next,{...empty(),catalogs:Array(33).fill("not JSON")},"reject","control_history_limit");
add("saved-freeze-does-not-hide-wrong-family",authority.next,{...empty(),histories:[{replica:"foreign",frames:[],rejected:[]}]},"reject","wrong_catalog_scope");
const forkJson=await signedCatalog({...f.catalog,entries:f.catalog.entries.map(e=>({...e,route:`/r/${fixtureId("fork:"+e.replica)}`}))},f.catalogSigner);
const fork=await evaluateTreehouseCatalogTrust({installed:accepted.next,expected,incoming:{...empty(),catalogs:[forkJson]}});
assert.equal(fork.kind,"retain_blocked");assert.equal(fork.reason,"catalog_fork");
add("saved-graph-fork-survives-invalid-rotation",fork.next,{...empty(),rotations:["not JSON"]},"retain_blocked","catalog_fork");
add("new-graph-fork-is-not-an-early-security-fallback",accepted.next,{...empty(),catalogs:[forkJson],cutoffProofs:[{} as never]},"reject","malformed_catalog");
const revision={...f.catalog,revision:1,previous:transportCatalogId(f.catalog)};
const revisionJson=await signedCatalog(revision,f.catalogSigner);
const advanced=await evaluateTreehouseCatalogTrust({installed:accepted.next,expected,incoming:{...empty(),catalogs:[revisionJson]}});
assert.equal(advanced.kind,"propose");assert.equal(advanced.next.accepted!.revision,1);
add("old-catalog-cannot-roll-back-watermark",advanced.next,{...empty(),catalogs:[f.catalogJson]},"unchanged",null);
// A retained nonaccepted sibling remains diagnostic after real later proof
// refuses its child creation. The accepted Space is unaffected.
const base=await trustFixture(0),baseAccepted=await install(base);
const pendingForkInput:Input={installed:baseAccepted.next,expected,incoming:{...empty(),catalogs:[f.catalogJson],histories:[f.histories[0]!]}};
const pendingFork=await evaluateTreehouseCatalogTrust(pendingForkInput);
assert.equal(pendingFork.kind,"retain_blocked");assert.equal(pendingFork.reason,"catalog_fork");assert.equal(pendingFork.next.blocked!.pendingProofIds.length,1);
add("pending-sibling-before-later-history",pendingForkInput.installed,pendingForkInput.incoming,"retain_blocked","catalog_fork");
const thread=f.threads[0]!;
let refusedThread:typeof f.histories[number]|undefined;
for(let n=0;n<32;n++){
  const {frame}=await authorTreehouseRoleTransfer({replica:thread.replica,deps:[thread.genesis.id],signer:thread.signer,parent:thread.delegation,
    recipient:fixtureSigner(`incoming-thread-successor-${n}`).publicKey,action:"change_moderator"});
  const candidate={replica:thread.replica,frames:[...thread.frames,frame],rejected:[]};
  const observed=await evaluateTreehouseCatalogTrust({installed:accepted.next,expected,incoming:{...empty(),histories:[candidate]}});
  if(observed.kind==="retain_blocked"&&observed.reason==="authority_changed"&&observed.next.blocked!.opIds.includes(thread.creation.id)){refusedThread=candidate;break;}
}
assert.ok(refusedThread,"actual public owner must prove the child creation refusal");
const diagnosticInput:Input={installed:pendingFork.next,expected,incoming:{...empty(),histories:[refusedThread]}};
const diagnostic=await evaluateTreehouseCatalogTrust(diagnosticInput);
assert.equal(diagnostic.kind,"retain_blocked");assert.equal(diagnostic.reason,"catalog_fork");assert.deepEqual(diagnostic.next.accepted,baseAccepted.next.accepted);
add("retained-sibling-later-refusal-stays-diagnostic",diagnosticInput.installed,diagnosticInput.incoming,"retain_blocked","catalog_fork");
add("contradictory-frozen-sibling-reopens",diagnostic.next,empty(),"retain_blocked","catalog_fork");
// Whole-page overflow is authenticated before budget handling. Original arrays
// and the first overflow witnesses survive either authority-event order.
const records:{id:string;json:string}[]=[];let previous:string|null=null;
for(let revision=0;revision<1023;revision++){
  const catalog={...base.catalog,revision,previous},id=transportCatalogId(catalog);
  records.push({id,json:await signedCatalog(catalog,base.catalogSigner)});previous=id;
}
const budget=structuredClone(baseAccepted.next);budget.catalogs=records.sort((a,b)=>Buffer.compare(Buffer.from(a.id),Buffer.from(b.id)));
budget.accepted={binding:base.bootstrap.id,generation:0,catalog:previous!,revision:1022};
const overflowCatalogs:string[]=[];
for(const revision of [1023,1024]){const catalog={...base.catalog,revision,previous};overflowCatalogs.push(await signedCatalog(catalog,base.catalogSigner));previous=transportCatalogId(catalog);}
const overflowPage={...empty(),catalogs:overflowCatalogs};
const overflow=await evaluateTreehouseCatalogTrust({installed:budget,expected,incoming:overflowPage});
assert.equal(overflow.kind,"retain_blocked");assert.equal(overflow.reason,"control_history_limit");assert.equal(overflow.next.blocked!.triggers.length,2);
add("whole-page-overflow-unadmitted",budget,overflowPage,"retain_blocked","control_history_limit");
add("overflow-does-not-hide-invalid-artifact",budget,{...empty(),catalogs:[...overflowCatalogs,"not JSON"]},"reject","malformed_catalog");
add("saved-overflow-survives-invalid-artifact",overflow.next,malformed,"retain_blocked","control_history_limit");
const baseChanged={...base.histories[0]!,frames:[...base.space.frames,transfer]};
add("overflow-before-authority",overflow.next,{...empty(),histories:[baseChanged]},"retain_blocked","authority_changed");
const authorityAtBudget=await evaluateTreehouseCatalogTrust({installed:budget,expected,incoming:{...empty(),histories:[baseChanged]}});
assert.equal(authorityAtBudget.kind,"retain_blocked");assert.equal(authorityAtBudget.reason,"authority_changed");
add("authority-before-overflow",authorityAtBudget.next,overflowPage,"retain_blocked","authority_changed");
add("simultaneous-authority-and-overflow",budget,{...overflowPage,histories:[baseChanged]},"retain_blocked","authority_changed");
const cases:{name:string;orders:{input:Input;decision:Decision}[]}[]=[];
for(const item of inputs){
  const orders:{input:Input;decision:Decision}[]=[];
  for(const reverse of [false,true]){
    const input=structuredClone(item.input);
    if(reverse){
      input.incoming.catalogs=[...input.incoming.catalogs].reverse();input.incoming.rotations=[...input.incoming.rotations].reverse();input.incoming.cutoffProofs=[...input.incoming.cutoffProofs].reverse();
      input.incoming.histories=[...input.incoming.histories].reverse().map(h=>({...h,frames:[...h.frames].reverse(),rejected:[...h.rejected].reverse()}));
    }
    const before=JSON.stringify(input),decision=await evaluateTreehouseCatalogTrust(input);
    assert.equal(JSON.stringify(input),before);assert.equal(decision.kind,item.kind,`${item.name} reverse=${reverse}`);assert.equal(decision.reason,item.reason,item.name);
    if(decision.kind==="retain_blocked"){assert.deepEqual(decision.routes,[]);assert.deepEqual(decision.next.accepted,item.input.installed.accepted);}
    if(item.name==="overflow-before-authority"&&decision.kind==="retain_blocked")assert.deepEqual(decision.next.blocked!.triggers,overflow.next.blocked!.triggers);
    orders.push({input,decision});
  }
  cases.push({name:item.name,orders});
}
assert.equal(cases.length,29);
await new Promise<void>(resolve=>process.stdout.write(JSON.stringify({cases})+"\n",()=>resolve()));
