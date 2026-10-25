import assert from "node:assert/strict";
import test from "node:test";
import {withinCatalogRawObservationBounds as bounded} from "../src/treehouse_catalog_raw_bounds";
import {canonicalBytesForCarrierTerm,canonicalHash,authorCarrierDelegation} from "../src/codec";
import type {CarrierTerm} from "../src/carrier";
import {trustFixture,fixtureId} from "./support/export_treehouse_catalog_trust";
import {prepareTreehouseCatalogInstallation,evaluateTreehouseCatalogTrust} from "../src/treehouse_catalog_trust";
const fixture=trustFixture(0),expected={trustRevision:0,historyGeneration:0};
const bin=(value:string|Uint8Array):CarrierTerm=>["bin",Buffer.from(value).toString("base64")];
async function setup(){
 const f=await fixture, deps=[fixtureId("observation-safety-missing")];
 const baseline=await prepareTreehouseCatalogInstallation({review:f.review,history:f.histories[0]!,store:{kind:"verified_fresh",expected}});
 assert.equal(baseline.kind,"propose");
 const raw=async(kind:string,body:CarrierTerm)=>{
  const cap:CarrierTerm=["nil"];
  const bytes=canonicalBytesForCarrierTerm(["list",[bin("lattice-op-v2"),bin(f.space.replica),bin(f.root.publicKey),["list",deps.map(bin)],["atom",kind],body,cap]]);
  return {v:1,id:await canonicalHash(bytes),replica:f.space.replica,author:Buffer.from(f.root.publicKey).toString("base64"),deps,kind,body,cap,sig:Buffer.from(await f.root.sign(bytes)).toString("base64")};
 };
 const decisions=async(frame:unknown)=>{
  const history={replica:f.space.replica,frames:[frame],rejected:[]};
  return [await prepareTreehouseCatalogInstallation({review:f.review,history,store:{kind:"verified_fresh",expected}}),await evaluateTreehouseCatalogTrust({installed:baseline.next,expected,incoming:{catalogs:[],rotations:[],histories:[history],cutoffProofs:[]}})];
 };
 return {f,raw,decisions};
}
test("raw strings must be lossless UTF-16, preserving real surrogate pairs",()=>{
 for(const value of ["\ud800","\udfff","a\ud800b"]){assert.equal(bounded({body:["atom",value],cap:["nil"]}),false);}
 assert.equal(bounded({body:["atom","\ud83d\ude00"],cap:["nil"]}),true);
});
test("signed replacement-character controls cannot authenticate lone-surrogate aliases",async()=>{
 const {f,raw,decisions}=await setup();
 const kind=await raw("future\ufffd",["nil"]),atom=await raw("command",["atom","future\ufffd"]);
 const delegation=await authorCarrierDelegation({replica:f.space.replica,signer:f.root,audiencePubkey:f.root.publicKey,ops:["create_space"],roles:["future\ufffd"]});
 const delegated=await raw("command",["delegation",delegation]);
 const aliases=[{...kind,kind:"future\ud800"},{...atom,body:["atom","future\ud800"]},{...delegated,body:["delegation",{...delegation,roles:["future\ud800"]}]}];
 for(const control of [kind,atom,delegated,await raw("future\ud83d\ude00",["nil"])])for(const d of await decisions(control)){assert.equal(d.kind,"reject");assert.equal(d.reason,"trust_pending");assert.deepEqual(d.detail.ids,control.deps);}
 for(const alias of aliases)for(const d of await decisions(alias)){assert.equal(d.kind,"reject");assert.equal(d.reason,"invalid_verified_history");assert.deepEqual(d.detail.ids,[]);}
});
test("raw integer scalars are canonical uint64 before canonical allocation",()=>{
 for(const value of [0,Number.MAX_SAFE_INTEGER,"0","18446744073709551615"])assert.equal(bounded({body:["int",value],cap:["nil"]}),true);
 for(const value of ["","00","01","1\n"," 1","+1","-1","18446744073709551616","9".repeat(1_048_576),1.5,Number.MAX_SAFE_INTEGER+1,Infinity,NaN])assert.equal(bounded({body:["int",value],cap:["nil"]}),false);
});
test("public raw authentication never attempts BigInt conversion of an oversized decimal",async()=>{
 const {f,raw,decisions}=await setup(),control=await raw("command",["int","1"]);
 const frame={...control,body:["int","9".repeat(1_048_576)]};
 const delegated=await raw("command",["delegation",f.space.delegation]);
 const epoch={...delegated,body:["delegation",{...f.space.delegation,expires_epoch:"9".repeat(1_048_576)}]};
 const original=globalThis.BigInt;let oversized=0;
 globalThis.BigInt=new Proxy(original,{apply(target,receiver,args){if(typeof args[0]==="string"&&args[0].length>20&&/^[0-9]+$/.test(args[0])){oversized++;throw new Error("oversized decimal conversion attempted");}return Reflect.apply(target,receiver,args);}});
 try{for(const term of [frame.body,epoch.body])assert.throws(()=>canonicalBytesForCarrierTerm(JSON.parse(JSON.stringify(term))),/unsupported canonical integer/);for(const candidate of [frame,epoch])for(const d of await decisions(candidate)){assert.equal(d.kind,"reject");assert.equal(d.reason,"invalid_verified_history");}assert.equal(oversized,0);}finally{globalThis.BigInt=original;}
});

test("flat delegation primitives cannot be coerced into a different signed representation",async()=>{
 const {f,raw,decisions}=await setup();
 const letters=await authorCarrierDelegation({replica:f.space.replica,signer:f.root,audiencePubkey:f.root.publicKey,ops:["create_space"],roles:["o","p","s","t"],live:true});
 const typed=await raw("command",["delegation",letters]);
 const leased=await authorCarrierDelegation({replica:f.space.replica,signer:f.root,audiencePubkey:f.root.publicKey,ops:["create_space"],roles:["admin"],expiresEpoch:0});
 const epoch=await raw("command",["delegation",leased]);
 const base=await raw("command",["delegation",f.space.delegation]);
 const absentParent={...f.space.delegation} as Partial<typeof f.space.delegation>;delete absentParent.parent_id;
 for(const value of [typed,epoch,{...base,body:["delegation",{...f.space.delegation,expires_epoch:null}]}])for(const d of await decisions(value)){assert.equal(d.kind,"reject");assert.equal(d.reason,"trust_pending");}
 const bad=[{...typed,body:["delegation",{...letters,roles:"post"}]},{...typed,body:["delegation",{...letters,live:"true"}]},{...epoch,body:["delegation",{...leased,expires_epoch:"0"}]},{...base,body:["delegation",absentParent]}];
 for(const value of bad)for(const d of await decisions(value)){assert.equal(d.kind,"reject");assert.equal(d.reason,"invalid_verified_history");assert.deepEqual(d.detail.ids,[]);}
});
