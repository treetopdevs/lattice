import assert from "node:assert/strict";
import {trustFixture} from "./export_treehouse_catalog_trust";
import {authorCarrierOpUnchecked} from "./unchecked_author";
import {prepareTreehouseCatalogInstallation,evaluateTreehouseCatalogTrust} from "../../src/treehouse_catalog_trust";
import type {TreehouseCatalogRawHistory,InstalledTreehouseCatalogTrustV1} from "../../src/treehouse_catalog_trust";
const expected={trustRevision:0,historyGeneration:0};
function strings(value:unknown):number{
 if(typeof value==="string")return Buffer.byteLength(value);
 if(Array.isArray(value))return value.reduce((n,v)=>n+strings(v),0);
 if(value!==null&&typeof value==="object")return Object.entries(value).reduce((n,[k,v])=>n+Buffer.byteLength(k)+strings(v),0);
 return 0;
}
const f=await trustFixture(0), baseline=f.histories[0]!;
const author=(text:string,deps:string[])=>authorCarrierOpUnchecked({replica:f.space.replica,signer:f.root,deps,kind:"command",body:["atom",text],cap:["nil"]});
const deps=[baseline.frames.at(-1)!.id];
const a=await author("",deps),b=await author("",[]);
const empty:TreehouseCatalogRawHistory={...baseline,frames:[...baseline.frames,a,b]};
const available=64*1024*1024-strings([empty]);
const left="q".repeat(Math.floor(available/2)),right="q".repeat(Math.ceil(available/2));
const at:TreehouseCatalogRawHistory={...baseline,frames:[...baseline.frames,await author(left,deps),await author(right,[])]};
assert.equal(strings([at]),64*1024*1024);
const overFrame=await author(right+"z",[]);
const over={...at,frames:[...at.frames.slice(0,-1),overFrame]};
assert.equal(strings([over]),64*1024*1024+1);
const forged={...at,frames:at.frames.map((v,n)=>n===baseline.frames.length?{...(v as object),sig:Buffer.alloc(64).toString("base64")}:v)};
const installed=await prepareTreehouseCatalogInstallation({review:f.review,history:baseline,store:{kind:"verified_fresh",expected}});
assert.equal(installed.kind,"propose");
const results=[];
for(const [name,history,reason] of [["at",at,"unsupported_cutoff"],["over",over,"invalid_verified_history"],["forged",forged,"invalid_verified_history"]] as const){
 const prepare=await prepareTreehouseCatalogInstallation({review:f.review,history,store:{kind:"verified_fresh",expected}});
 const evaluate=await evaluateTreehouseCatalogTrust({installed:installed.next,expected,incoming:{catalogs:[],rotations:[],histories:[history],cutoffProofs:[]}});
 for(const d of [prepare,evaluate]){assert.equal(d.kind,"reject");assert.equal(d.reason,reason);assert.deepEqual(d.detail.ids,[]);}
 results.push({name,reason});
}
console.log(JSON.stringify({review:f.review,baseline,at,overFrame,results}));
