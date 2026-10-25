import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fixtureId,fixtureSigner} from "./export_treehouse_catalog_trust";
import {authorCarrierDelegation,authorCarrierOp,verifyCarrierOp} from "../../src/codec";
import {carrierOpsToSemanticOps,decodeCarrierOpFrame} from "../../src/carrier";
import type {CarrierOpFrame,CarrierTerm} from "../../src/carrier";
import {treehouseCommandDecoders,treehouseSpaceSchema,treehouseThreadSchema} from "../../src/treehouse";
import {materialize} from "../../src/materialize";
import {bindTownshipReplica} from "../../src/township";
import {ed25519} from "@noble/curves/ed25519.js";

interface History {name:string;replica:string;frames:CarrierOpFrame[];}
async function judge(h:History){
 const ids=new Set(h.frames.map(f=>f.id));assert.equal(ids.size,h.frames.length);
 for(const raw of h.frames){
  const f=decodeCarrierOpFrame(raw);assert.equal(f.replica,h.replica);assert.ok(f.deps.every(id=>ids.has(id)));
  assert.equal((await verifyCarrierOp(f,{verify:async(key,bytes,sig)=>ed25519.verify(sig,bytes,Buffer.from(key,"base64"),{zip215:false})})).valid,true);
 }
 const space=h.replica.startsWith("replica:treehouse:space:");
 const ops=carrierOpsToSemanticOps(h.frames,{},treehouseCommandDecoders(space?"Treehouse.Space":"Treehouse.Thread"));
 const result=materialize(space?treehouseSpaceSchema:treehouseThreadSchema,ops);
 return Object.fromEntries(ops.map(op=>[op.id,result.quarantineReasons.get(op.id)??null]));
}
if(process.argv[2]==="--consume"){
 const input=JSON.parse(readFileSync(process.argv[3]!,"utf8")) as {histories:History[]};
 console.log(JSON.stringify({results:await Promise.all(input.histories.map(judge))}));process.exit(0);
}
const text=(s:string):CarrierTerm=>["bin",Buffer.from(s).toString("base64")];
const histories:History[]=[];
for(const kind of ["space","thread"] as const){
 const root=fixtureSigner(`lifecycle-root-${kind}`),member=fixtureSigner(`lifecycle-member-${kind}`);
 const replica=await bindTownshipReplica(`replica:treehouse:${kind}:${fixtureId(`lifecycle-${kind}`)}#authority:bounded-continuation-v1`,root.publicKey);
 const names=[...treehouseCommandDecoders(kind==="space"?"Treehouse.Space":"Treehouse.Thread").keys()];
 const cap=await authorCarrierDelegation({replica,signer:root,audiencePubkey:root.publicKey,ops:names,roles:kind==="space"?["admin","moderator"]:["moderator"],live:true});
 const genesis=await authorCarrierOp({replica,signer:root,deps:[],kind:"authority",cap:["nil"],body:["tuple",[["atom","genesis"],["delegation",cap],["map",[]]]]});
 const post=await authorCarrierOp({replica,signer:root,deps:[genesis.id],kind:"command",cap:text(cap.id),body:["tuple",[["atom",kind==="space"?"create_space":"post"],["list",[text("retained")]]]]});
 for(const [label,signer] of [["root",root],["nonroot",member]] as const){
  for(const cite of [false,true]){
   const lifecycle=await authorCarrierOp({replica,signer,deps:[post.id],kind:"tombstone",body:["nil"],cap:cite?text(cap.id):["nil"]});
   const frames=[genesis,post,lifecycle];
   if(kind==="thread")frames.push(await authorCarrierOp({replica,signer:root,deps:[lifecycle.id],kind:"command",cap:text(cap.id),body:["tuple",[["atom","author_edit"],["list",[text(post.id),text(lifecycle.id),text("wrong type")]]]]}));
   histories.push({name:`${kind}-${label}-${cite?"cap":"no-cap"}`,replica,frames});
  }
 }
 const noRoot=await authorCarrierOp({replica,signer:root,deps:[],kind:"tombstone",body:["nil"],cap:["nil"]});
 histories.push({name:`${kind}-no-genesis`,replica,frames:[noRoot]});
 const delegated=await authorCarrierDelegation({replica,signer:root,audiencePubkey:member.publicKey,parentId:cap.id,ops:names,roles:kind==="space"?["admin","moderator"]:["moderator"],live:false});
 const grant=await authorCarrierOp({replica,signer:root,deps:[post.id],kind:"authority",cap:["nil"],body:["tuple",[["atom","grant"],["delegation",delegated]]]});
 const lifecycle=await authorCarrierOp({replica,signer:member,deps:[grant.id],kind:"tombstone",body:["nil"],cap:text(delegated.id)});
 const frames=[genesis,post,grant,lifecycle];
 if(kind==="thread")frames.push(await authorCarrierOp({replica,signer:root,deps:[lifecycle.id],kind:"command",cap:text(cap.id),body:["tuple",[["atom","author_edit"],["list",[text(post.id),text(lifecycle.id),text("delegation cannot authorize lifecycle")]]]]}));
 histories.push({name:`${kind}-delegated-nonroot`,replica,frames});
}
console.log(JSON.stringify({histories:await Promise.all(histories.map(async h=>({...h,reasons:await judge(h)})))}));
