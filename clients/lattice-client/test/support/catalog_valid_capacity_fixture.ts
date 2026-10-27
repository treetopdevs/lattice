import assert from "node:assert/strict";
import {trustFixture} from "./export_treehouse_catalog_trust";
import {authorCarrierOpUnchecked} from "./unchecked_author";
import {prepareTreehouseCatalogInstallation,evaluateTreehouseCatalogTrust,resolveTreehouseCatalogRoute} from "../../src/treehouse_catalog_trust";
import {deriveTreehouseCatalogCutoff} from "../../src/treehouse_catalog_cutoff";
import {withinCatalogRawEvidenceBounds,withinCatalogRawHistoriesBounds} from "../../src/treehouse_catalog_raw_bounds";
import type {TreehouseCatalogBootstrapReview,TreehouseCatalogRawHistory,TreehouseCatalogCutoffProof,TreehouseCatalogEvidencePage} from "../../src/treehouse_catalog_trust";
import type {CarrierOpFrame} from "../../src/carrier";
const MAX=67_108_864,expected={trustRevision:0,historyGeneration:0};
type Bundle={review:TreehouseCatalogBootstrapReview;baseline:TreehouseCatalogRawHistory;catalogJson:string;proof:TreehouseCatalogCutoffProof;at:TreehouseCatalogRawHistory;overFrame:CarrierOpFrame;frameCount:number};
function stringBytes(root:unknown){let count=0;const pending=[root];while(pending.length){const v=pending.pop();if(typeof v==="string")count+=Buffer.byteLength(v);else if(Array.isArray(v))pending.push(...v);else if(v&&typeof v==="object")for(const [k,x] of Object.entries(v)){count+=Buffer.byteLength(k);pending.push(x);}}return count;}
const page=(history?:TreehouseCatalogRawHistory):TreehouseCatalogEvidencePage=>({catalogs:[],rotations:[],histories:history?[history]:[],cutoffProofs:[]});
async function install(b:Pick<Bundle,"review"|"baseline"|"catalogJson"|"proof">){
 const prepared=await prepareTreehouseCatalogInstallation({review:b.review,history:b.baseline,store:{kind:"verified_fresh",expected}});assert.equal(prepared.kind,"propose");
 const initial=await evaluateTreehouseCatalogTrust({installed:prepared.next,expected,incoming:{...page(b.baseline),catalogs:[b.catalogJson],cutoffProofs:[b.proof]}});
 assert.equal(initial.kind,"propose");assert.equal(initial.routes.length,1);assert.equal(initial.next.cutoffProofs.length,1);
 const route=resolveTreehouseCatalogRoute({decision:initial,replica:b.review.space});assert.equal(route.ok,true);if(route.ok)assert.equal(route.installationRequired,true);return initial;
}
export async function produce():Promise<Bundle>{
 const f=await trustFixture(0),baseline=f.histories[0]!,proof=f.cutoffProofs[0]!;
 const b={review:f.review,baseline,catalogJson:f.catalogJson,proof},initial=await install(b),deps=[f.bootstrap.id];
 const author=async(text:string,padding=0)=>{
  const frame=await authorCarrierOpUnchecked({replica:f.space.replica,signer:f.root,deps,kind:"command",body:["tuple",[["atom","create_space"],["list",[["bin",Buffer.from(text).toString("base64")]]]]],cap:["nil"]});
  return {...frame,deps:[...frame.deps,...Array(padding).fill(deps[0])]};
 };
 const frames=[...baseline.frames];let total=stringBytes(initial.next);
 while(MAX-total>62_000){const frame=await author(`${frames.length}:`+"x".repeat(44_000));assert.ok(Buffer.byteLength(JSON.stringify({type:"push",ops:[frame]}))<=64_000);frames.push(frame);total+=stringBytes(frame);}
 const empty=await author(""),available=MAX-total-stringBytes(empty),width=deps[0]!.length;
 const padding=[0,1,2,3].find(n=>available>=n*width&&(available-n*width)%4===0);assert.notEqual(padding,undefined);assert.equal(width,43);
 const payload="z".repeat((available-padding!*width)/4*3);assert.ok(payload.length>=96);
 frames.push(await author(payload,padding));
 const overFrame=await author(payload.slice(0,-96),padding!+3);
 return {...b,at:{...baseline,frames},overFrame,frameCount:frames.length};
}
export async function check(b:Bundle){
 const initial=await install(b),at=b.at,frames=at.frames,over={...at,frames:[...frames.slice(0,-1),b.overFrame]};
 const predicted={...initial.next,histories:[at]},predictedOver={...initial.next,histories:[over]};
 assert.equal(stringBytes(predicted),MAX);assert.equal(stringBytes(predictedOver),MAX+1);
 assert.equal(withinCatalogRawEvidenceBounds(predicted),true);assert.equal(withinCatalogRawEvidenceBounds(predictedOver),false);
 for(const h of [at,over]){assert.equal(withinCatalogRawEvidenceBounds(page(h)),true);assert.equal(withinCatalogRawHistoriesBounds([h]),true);const cutoff=await deriveTreehouseCatalogCutoff(h);assert.equal(cutoff.ok,true,"portable genuine history is required, not unsupported padding");}
 const original=JSON.stringify(initial.next);
 const accepted=await evaluateTreehouseCatalogTrust({installed:initial.next,expected,incoming:page(at)});assert.equal(accepted.kind,"propose");assert.equal(accepted.reason,null);assert.equal(accepted.routes.length,1);assert.equal(stringBytes(accepted.next),MAX);assert.equal(accepted.next.histories[0]!.frames.length,b.frameCount);assert.deepEqual(accepted.next.accepted,initial.next.accepted);assert.equal(accepted.next.cutoffProofs.length,1);
 const reopened=await evaluateTreehouseCatalogTrust({installed:accepted.next,expected,incoming:page()});assert.equal(reopened.kind,"unchanged");assert.equal(reopened.reason,null);assert.equal(reopened.routes.length,1);
 const proposedOver=await evaluateTreehouseCatalogTrust({installed:initial.next,expected,incoming:page(over)});assert.equal(proposedOver.kind,"reject");assert.equal(proposedOver.reason,"invalid_verified_history");assert.deepEqual(proposedOver.detail.ids,[]);
 const savedOver=await evaluateTreehouseCatalogTrust({installed:predictedOver,expected,incoming:page(b.baseline)});assert.equal(savedOver.kind,"reject");assert.equal(savedOver.reason,"trust_recovery_required");assert.deepEqual(savedOver.detail.ids,[]);
 for(const decision of [proposedOver,savedOver])assert.deepEqual(resolveTreehouseCatalogRoute({decision,replica:b.review.space}),{ok:false,reason:"trust_recovery_required"});
 assert.equal(JSON.stringify(initial.next),original);
 return {initial,accepted,reopened,proposedOver,savedOver};
}
