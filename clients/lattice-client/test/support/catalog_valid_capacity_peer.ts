import assert from "node:assert/strict";
import {trustFixture} from "./export_treehouse_catalog_trust";
import {authorCarrierOpUnchecked} from "./unchecked_author";
import {prepareTreehouseCatalogInstallation,evaluateTreehouseCatalogTrust} from "../../src/treehouse_catalog_trust";
import {deriveTreehouseCatalogCutoff} from "../../src/treehouse_catalog_cutoff";
import {withinCatalogRawEvidenceBounds,withinCatalogRawHistoriesBounds} from "../../src/treehouse_catalog_raw_bounds";
const MAX=67_108_864,expected={trustRevision:0,historyGeneration:0};
function stringBytes(root:unknown){let count=0;const pending=[root];while(pending.length){const v=pending.pop();if(typeof v==="string")count+=Buffer.byteLength(v);else if(Array.isArray(v))pending.push(...v);else if(v&&typeof v==="object")for(const [k,x] of Object.entries(v)){count+=Buffer.byteLength(k);pending.push(x);}}return count;}
const f=await trustFixture(0),baseline=f.histories[0]!;
const page=(history=baseline)=>({catalogs:[] as string[],rotations:[] as string[],histories:[history],cutoffProofs:[]});
const prepared=await prepareTreehouseCatalogInstallation({review:f.review,history:baseline,store:{kind:"verified_fresh",expected}});assert.equal(prepared.kind,"propose");
const initial=await evaluateTreehouseCatalogTrust({installed:prepared.next,expected,incoming:{...page(),catalogs:[f.catalogJson]}});assert.equal(initial.kind,"propose");assert.equal(initial.routes.length,1);
const deps=[baseline.frames.at(-1)!.id];
const author=async(text:string,padding=0)=>{
 const frame=await authorCarrierOpUnchecked({replica:f.space.replica,signer:f.root,deps,kind:"command",body:["tuple",[["atom","create_space"],["list",[["bin",Buffer.from(text).toString("base64")]]]]],cap:["nil"]});
 return {...frame,deps:[...frame.deps,...Array(padding).fill(deps[0])]};
};
const frames=[...baseline.frames];let total=stringBytes(initial.next);
while(MAX-total>62_000){const frame=await author(`${frames.length}:`+"x".repeat(44_000));assert.ok(Buffer.byteLength(JSON.stringify({type:"push",ops:[frame]}))<=64_000);frames.push(frame);total+=stringBytes(frame);}
const empty=await author(""),available=MAX-total-stringBytes(empty);assert.ok(available>=0);
const width=deps[0]!.length,padding=[0,1,2,3].find(n=>available>=n*width&&(available-n*width)%4===0);assert.notEqual(padding,undefined);
const payload="z".repeat((available-padding!*width)/4*3);
const last=await author(payload,padding);assert.ok(Buffer.byteLength(JSON.stringify({type:"push",ops:[last]}))<=64_000);frames.push(last);
// Three extra duplicate deps add 129 string bytes; removing 96 binary bytes removes 128 Base64 bytes.
// Dependency-set normalization is already part of the signed carrier contract.
assert.equal(width,43);assert.ok(payload.length>=96);
const at={...baseline,frames},overFrame=await author(payload.slice(0,-96),padding!+3),over={...at,frames:[...frames.slice(0,-1),overFrame]};
const predicted={...initial.next,histories:[at]},predictedOver={...initial.next,histories:[over]};
assert.equal(stringBytes(predicted),MAX);assert.equal(stringBytes(predictedOver),MAX+1);
assert.equal(withinCatalogRawEvidenceBounds(predicted),true);assert.equal(withinCatalogRawEvidenceBounds(predictedOver),false);
for(const h of [at,over]){assert.equal(withinCatalogRawEvidenceBounds(page(h)),true);assert.equal(withinCatalogRawHistoriesBounds([h]),true);const cutoff=await deriveTreehouseCatalogCutoff(h);assert.equal(cutoff.ok,true,"portable genuine history is required, not unsupported padding");}
const original=JSON.stringify(initial.next);
const accepted=await evaluateTreehouseCatalogTrust({installed:initial.next,expected,incoming:page(at)});assert.equal(accepted.kind,"propose");assert.equal(accepted.reason,null);assert.equal(accepted.routes.length,1);assert.equal(stringBytes(accepted.next),MAX);assert.equal(accepted.next.histories[0]!.frames.length,frames.length);assert.deepEqual(accepted.next.accepted,initial.next.accepted);
const reopened=await evaluateTreehouseCatalogTrust({installed:accepted.next,expected,incoming:{...page(),histories:[]}});assert.equal(reopened.kind,"unchanged");assert.equal(reopened.reason,null);assert.equal(reopened.routes.length,1);
const proposedOver=await evaluateTreehouseCatalogTrust({installed:initial.next,expected,incoming:page(over)});assert.equal(proposedOver.kind,"reject");assert.equal(proposedOver.reason,"invalid_verified_history");assert.deepEqual(proposedOver.detail.ids,[]);
const savedOver=await evaluateTreehouseCatalogTrust({installed:predictedOver,expected,incoming:page()});assert.equal(savedOver.kind,"reject");assert.equal(savedOver.reason,"trust_recovery_required");assert.deepEqual(savedOver.detail.ids,[]);
assert.equal(JSON.stringify(initial.next),original);
console.log(JSON.stringify({review:f.review,baseline,catalogJson:f.catalogJson,at,overFrame,frameCount:frames.length}));
