import assert from "node:assert/strict";
import {trustFixture,fixtureSigner} from "./export_treehouse_catalog_trust";
import {authorTreehouseRoleTransfer} from "../../src/treehouse";
import {authorCarrierOpUnchecked} from "./unchecked_author";
import {prepareTreehouseCatalogInstallation,evaluateTreehouseCatalogTrust,resolveTreehouseCatalogRoute} from "../../src/treehouse_catalog_trust";
import {deriveTreehouseCatalogCutoff} from "../../src/treehouse_catalog_cutoff";
import {withinCatalogRawEvidenceBounds,withinCatalogRawHistoriesBounds} from "../../src/treehouse_catalog_raw_bounds";
import type {TreehouseCatalogBootstrapReview,TreehouseCatalogRawHistory,TreehouseCatalogCutoffProof,TreehouseCatalogEvidencePage,TreehouseCatalogTrustDecision} from "../../src/treehouse_catalog_trust";
import type {CarrierOpFrame} from "../../src/carrier";
const MAX=67_108_864,expected={trustRevision:0,historyGeneration:0};
type Bundle={frozen:boolean;transfer:CarrierOpFrame|null;review:TreehouseCatalogBootstrapReview;baseline:TreehouseCatalogRawHistory;catalogJson:string;proof:TreehouseCatalogCutoffProof;at:TreehouseCatalogRawHistory;overFrame:CarrierOpFrame;frameCount:number};
function stringBytes(root:unknown){let count=0;const pending=[root];while(pending.length){const v=pending.pop();if(typeof v==="string")count+=Buffer.byteLength(v);else if(Array.isArray(v))pending.push(...v);else if(v&&typeof v==="object")for(const [k,x] of Object.entries(v)){count+=Buffer.byteLength(k);pending.push(x);}}return count;}
const page=(history?:TreehouseCatalogRawHistory):TreehouseCatalogEvidencePage=>({catalogs:[],rotations:[],histories:history?[history]:[],cutoffProofs:[]});
async function install(b:Pick<Bundle,"review"|"baseline"|"catalogJson"|"proof">){
 const prepared=await prepareTreehouseCatalogInstallation({review:b.review,history:b.baseline,store:{kind:"verified_fresh",expected}});assert.equal(prepared.kind,"propose");
 const initial=await evaluateTreehouseCatalogTrust({installed:prepared.next,expected,incoming:{...page(b.baseline),catalogs:[b.catalogJson],cutoffProofs:[b.proof]}});
 assert.equal(initial.kind,"propose");assert.equal(initial.routes.length,1);assert.equal(initial.next.cutoffProofs.length,1);
 const route=resolveTreehouseCatalogRoute({decision:initial,replica:b.review.space});assert.equal(route.ok,true);if(route.ok)assert.equal(route.installationRequired,true);return initial;
}
function header(raw:unknown){
 assert.ok(raw!==null&&typeof raw==="object"&&"id" in raw&&"deps" in raw);
 assert.ok(typeof raw.id==="string"&&Array.isArray(raw.deps)&&raw.deps.every(d=>typeof d==="string"));
 return {id:raw.id,deps:raw.deps as string[]};
}
function frontier(frames:readonly unknown[]){
 const ids=new Set(frames.map(f=>header(f).id));
 for(const frame of frames)for(const dep of header(frame).deps)ids.delete(dep);
 return [...ids].sort();
}
async function stateTemplate(initial:Awaited<ReturnType<typeof install>>,baseline:TreehouseCatalogRawHistory,transfer:CarrierOpFrame|null){
 if(transfer===null)return initial.next;
 const frozen=await evaluateTreehouseCatalogTrust({installed:initial.next,expected,incoming:page({...baseline,frames:[...baseline.frames,transfer]})});
 assert.equal(frozen.kind,"retain_blocked");assert.equal(frozen.reason,"authority_changed");assert.equal(frozen.routes.length,0);
 assert.ok(frozen.next.blocked!==null);assert.equal(frozen.next.blocked.authorityWitnesses.length,1);
 assert.deepEqual(frozen.next.blocked.authorityWitnesses[0]!.frontier,frontier(frozen.next.histories[0]!.frames));
 return frozen.next;
}
function predictedState(template:Awaited<ReturnType<typeof stateTemplate>>,history:TreehouseCatalogRawHistory){
 const blocked=template.blocked===null?null:{...template.blocked,authorityWitnesses:template.blocked.authorityWitnesses.map(w=>{
  assert.equal(w.replica,history.replica);return {...w,frontier:frontier(history.frames)};
 })};
 return {...template,histories:[history],blocked};
}
export async function produce(frozen=false):Promise<Bundle>{
 const f=await trustFixture(0),baseline=f.histories[0]!,proof=f.cutoffProofs[0]!;
 const transfer=frozen?(await authorTreehouseRoleTransfer({replica:f.space.replica,deps:[f.space.creation.id],signer:f.root,parent:f.space.delegation,
  recipient:fixtureSigner("capacity-role-successor").publicKey,action:"transfer_admin"})).frame:null;
 const b={frozen,transfer,review:f.review,baseline,catalogJson:f.catalogJson,proof},initial=await install(b),deps=[f.bootstrap.id];
 const template=await stateTemplate(initial,baseline,transfer);
 const author=async(text:string,padding=0)=>{
  const frame=await authorCarrierOpUnchecked({replica:f.space.replica,signer:f.root,deps,kind:"command",body:["tuple",[["atom","create_space"],["list",[["bin",Buffer.from(text).toString("base64")]]]]],cap:["nil"]});
  return {...frame,deps:[...frame.deps,...Array(padding).fill(deps[0])]};
 };
 const frames=[...baseline.frames,...(transfer?[transfer]:[])],heads=new Set(frontier(frames));
 let total=stringBytes(template);
 const delta=(frame:CarrierOpFrame)=>frozen?frame.id.length-[...new Set(frame.deps)].filter(dep=>heads.has(dep)).reduce((n,dep)=>n+dep.length,0):0;
 const append=(frame:CarrierOpFrame)=>{total+=stringBytes(frame)+delta(frame);frames.push(frame);for(const dep of frame.deps)heads.delete(dep);heads.add(frame.id);};
 while(MAX-total>62_000){const frame=await author(`${frames.length}:`+"x".repeat(44_000));assert.ok(Buffer.byteLength(JSON.stringify({type:"push",ops:[frame]}))<=64_000);append(frame);}
 const empty=await author(""),available=MAX-total-stringBytes(empty)-delta(empty),width=deps[0]!.length;
 const padding=[0,1,2,3].find(n=>available>=n*width&&(available-n*width)%4===0);assert.notEqual(padding,undefined);assert.equal(width,43);
 const payload="z".repeat((available-padding!*width)/4*3);assert.ok(payload.length>=96);
 const final=await author(payload,padding);
 assert.ok(Buffer.byteLength(JSON.stringify({type:"push",ops:[final]}))<=64_000);
 append(final);assert.equal(total,MAX);
 const overFrame=await author(payload.slice(0,-96),padding!+3);
 assert.ok(Buffer.byteLength(JSON.stringify({type:"push",ops:[overFrame]}))<=64_000);
 return {...b,at:{...baseline,frames},overFrame,frameCount:frames.length};
}
export async function check(b:Bundle,onDecision:(name:string,decision:TreehouseCatalogTrustDecision)=>void=()=>{}){
 const frozen=b.frozen??false,transfer=b.transfer??null;assert.equal(frozen,transfer!==null);
 const initial=await install(b),at=b.at,frames=at.frames,over={...at,frames:[...frames.slice(0,-1),b.overFrame]};
 const template=await stateTemplate(initial,b.baseline,transfer);
 const predicted=predictedState(template,at),predictedOver=predictedState(template,over);
 assert.equal(stringBytes(predicted),MAX);assert.equal(stringBytes(predictedOver),MAX+1);
 assert.equal(withinCatalogRawEvidenceBounds(predicted),true);assert.equal(withinCatalogRawEvidenceBounds(predictedOver),false);
 for(const h of [at,over]){assert.equal(withinCatalogRawEvidenceBounds(page(h)),true);assert.equal(withinCatalogRawHistoriesBounds([h]),true);const cutoff=await deriveTreehouseCatalogCutoff(h);assert.equal(cutoff.ok,true,"portable genuine history is required, not unsupported padding");}
 const original=JSON.stringify(initial.next);
 const accepted=await evaluateTreehouseCatalogTrust({installed:initial.next,expected,incoming:page(at)});assert.equal(accepted.kind,frozen?"retain_blocked":"propose");assert.equal(accepted.reason,frozen?"authority_changed":null);assert.equal(accepted.routes.length,frozen?0:1);assert.equal(stringBytes(accepted.next),MAX);assert.equal(accepted.next.histories[0]!.frames.length,b.frameCount);assert.deepEqual(accepted.next.accepted,initial.next.accepted);assert.equal(accepted.next.cutoffProofs.length,1);
 onDecision("accepted",accepted);
 const reopened=await evaluateTreehouseCatalogTrust({installed:accepted.next,expected,incoming:page()});assert.equal(reopened.kind,frozen?"retain_blocked":"unchanged");assert.equal(reopened.reason,frozen?"authority_changed":null);assert.equal(reopened.routes.length,frozen?0:1);
 onDecision("reopened",reopened);
 const proposedOver=await evaluateTreehouseCatalogTrust({installed:initial.next,expected,incoming:page(over)});assert.equal(proposedOver.kind,"reject");assert.equal(proposedOver.reason,"invalid_verified_history");assert.deepEqual(proposedOver.detail.ids,[]);
 onDecision("proposedOver",proposedOver);
 const savedOver=await evaluateTreehouseCatalogTrust({installed:predictedOver,expected,incoming:page(b.baseline)});assert.equal(savedOver.kind,"reject");assert.equal(savedOver.reason,"trust_recovery_required");assert.deepEqual(savedOver.detail.ids,[]);
 for(const decision of [proposedOver,savedOver])assert.deepEqual(resolveTreehouseCatalogRoute({decision,replica:b.review.space}),{ok:false,reason:"trust_recovery_required"});
 onDecision("savedOver",savedOver);
 {
  const modeled=await evaluateTreehouseCatalogTrust({installed:predicted,expected,incoming:page(b.baseline)});
  assert.ok(modeled.kind!=="reject",JSON.stringify({kind:modeled.kind,reason:modeled.reason,detail:modeled.detail,modeledBytes:stringBytes(predicted),acceptedBytes:stringBytes(accepted.next),sameBlock:JSON.stringify(predicted.blocked)===JSON.stringify(accepted.next.blocked)}));assert.equal(modeled.reason,frozen?"authority_changed":null);
  assert.deepEqual(modeled.next,accepted.next,"the in-budget model must replay to the actual accepted state");
  onDecision("modelReopened",modeled);
 }
 if(frozen)for(const kind of ["catalog","proof"] as const)for(const [h,oversized] of [[at,false],[over,true]] as const){
  const incoming={...page(h),...(kind==="catalog"?{catalogs:["not JSON"]}:{cutoffProofs:[{} as never]})};
  const decision=await evaluateTreehouseCatalogTrust({installed:initial.next,expected,incoming});
  assert.equal(decision.kind,oversized?"reject":"retain_blocked");assert.equal(decision.reason,oversized?"invalid_verified_history":"authority_changed");
  if(decision.kind!=="reject"){assert.equal(decision.routes.length,0);assert.deepEqual(decision.next.accepted,initial.next.accepted);assert.equal(stringBytes(decision.next),MAX);}
  onDecision(`${kind}Fallback${oversized?"Over":"At"}`,decision);
 }
 if(frozen)for(const kind of ["catalog","proof"] as const){
  const incoming={...page(),...(kind==="catalog"?{catalogs:["not JSON"]}:{cutoffProofs:[{} as never]})};
  const decision=await evaluateTreehouseCatalogTrust({installed:accepted.next,expected,incoming});
  assert.equal(decision.kind,"retain_blocked");assert.equal(decision.reason,"authority_changed");assert.equal(decision.routes.length,0);
  assert.deepEqual(decision.next,accepted.next);onDecision(`saved${kind==="catalog"?"Catalog":"Proof"}FallbackAt`,decision);
 }
 assert.equal(JSON.stringify(initial.next),original);
 return {initial,blockedAt:predicted.blocked,blockedOver:predictedOver.blocked};
}
