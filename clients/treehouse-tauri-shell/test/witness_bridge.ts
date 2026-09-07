import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {ed25519} from "@noble/curves/ed25519.js";
import {WitnessAdapter, type WitnessTransport} from "../src/witness_adapter";
import {canonicalBytesForWitnessBinding} from "../src/witness_binding";
const b=(n:number)=>Buffer.alloc(32,n).toString("base64");
const seed=new Uint8Array(32).fill(11),publicKey=Buffer.from(ed25519.getPublicKey(seed)).toString("base64");
const proposal={replica:"line\n\"é😀",enrollmentId:b(1),recipient:b(2)},generation={creationAttemptId:b(3),generationChallenge:b(4)},proof={...proposal,freshValidatorNonce:b(5)};
const metadata={publicKey,spki:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),Buffer.from(publicKey,"base64")]).toString("base64"),appSignerSha256:b(12),creationVersionCode:"9223372036854775807",certificateChain:["AQID"]};
const identity={creationAttemptId:b(3),phase:"generated_unvalidated",generationChallenge:b(4),metadata,revision:"9"};
const identityResult={version:1,status:"identity",eligible:false,identity};
const variables={...proof,creationAttemptId:b(3),actualWitnessPublicKey:publicKey,generationChallengeDigest:createHash("sha256").update(Buffer.alloc(32,4)).digest("base64"),nativeRandomNonce:b(6),nativeCallerSessionDigest:b(8)};
const signed={version:1,status:"signed",eligible:false,identity,binding:{claim:{domain:"lattice-witness-binding-challenge-v1",version:1,product:"treehouse",appId:"dev.treetop.lattice.treehouse",...variables},signature:Buffer.from(ed25519.sign(canonicalBytesForWitnessBinding(variables),seed)).toString("base64")}};
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
class Fake implements WitnessTransport{
 calls:Array<{command:string;args:Record<string,never>|number[]}>=[];callbacks:Array<(value:unknown)=>void>=[];unsubscribed=0;gate:Promise<void>=Promise.resolve();
 reply:(command:string)=>Promise<unknown>=async()=>structuredClone(identityResult);
 async subscribePending(callback:(value:unknown)=>void){this.callbacks.push(callback);await this.gate;return()=>{this.unsubscribed++;};}
 invoke(command:string,args:Record<string,never>|number[]){assert.ok(this.callbacks.length>0);this.calls.push({command,args:structuredClone(args)});return this.reply(command);}
 event(value:unknown,index=this.callbacks.length-1){this.callbacks[index]!(value);}
}
const pending=(attemptId=b(20),phase="review")=>({version:1,attemptId,phase});
const decode=(args:Record<string,never>|number[])=>JSON.parse(new TextDecoder().decode(new Uint8Array(args as number[])));

test("typed commands use subscribed identity object or owned numeric UTF8 transport",async()=>{
 const bridge=new Fake(),adapter=new WitnessAdapter(bridge);
 assert.deepEqual(await adapter.publicIdentity(),identityResult);assert.deepEqual(bridge.calls[0],{command:"treehouse_witness_public_identity",args:{}});
 bridge.reply=async()=>({version:1,status:"prepared",eligible:false,identity,enrollment:{...proposal,creationAttemptId:b(3)}});
 const input={...proposal},running=adapter.prepareCreation(input);input.replica="mutated";assert.equal((await running).status,"prepared");assert.deepEqual(decode(bridge.calls[1]!.args),proposal);
 bridge.reply=async()=>({version:1,status:"generated_unvalidated",eligible:false,identity});assert.equal((await adapter.generate(generation)).status,"generated_unvalidated");
 bridge.reply=async()=>structuredClone(signed);assert.deepEqual(await adapter.proveBinding(proof),signed);assert.equal(bridge.unsubscribed,4);
 assert.deepEqual(bridge.calls.map(call=>call.command),["treehouse_witness_public_identity","treehouse_witness_prepare_creation","treehouse_witness_generate","treehouse_witness_prove_binding"]);
 assert.deepEqual(decode(bridge.calls[2]!.args),generation);assert.deepEqual(decode(bridge.calls[3]!.args),proof);
 for(const call of bridge.calls.slice(1))assert.ok(Array.isArray(call.args)&&call.args.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255));
});
test("malformed requests refuse before subscription or native invocation",async()=>{
 const bridge=new Fake(),adapter=new WitnessAdapter(bridge);
 for(const input of [{...proposal,extra:true},{...proposal,replica:"\ud800"},{...proposal,replica:"é".repeat(257)},{...proposal,enrollmentId:b(1).slice(0,-1)},{...proposal,recipient:"AA=="}])await assert.rejects(adapter.prepareCreation(input as never),/invalid_witness_request/);
 await assert.rejects(adapter.generate({...generation,purpose:"other"} as never),/invalid_witness_request/);
 await assert.rejects(adapter.proveBinding({...proof,freshValidatorNonce:3} as never),/invalid_witness_request/);
 assert.equal(bridge.calls.length,0);assert.equal(bridge.callbacks.length,0);
});
test("incomplete identity stays incomplete and missing cannot stand for prepare generate or proof",async()=>{
 const bridge=new Fake(),adapter=new WitnessAdapter(bridge);
 for(const phase of ["prepared","generation_started"]){const incomplete={...identity,phase,metadata:null,generationChallenge:phase==="prepared"?null:b(4)};
 bridge.reply=async()=>({version:1,status:"incomplete",eligible:false,identity:incomplete});assert.equal((await adapter.publicIdentity()).status,"incomplete");
 bridge.reply=async()=>({version:1,status:"identity",eligible:false,identity:incomplete});await assert.rejects(adapter.publicIdentity(),/invalid_witness_result/);}
 bridge.reply=async()=>({version:1,status:"missing"});assert.equal((await adapter.publicIdentity()).status,"missing");
 await assert.rejects(adapter.prepareCreation(proposal),/invalid_witness_result/);await assert.rejects(adapter.generate(generation),/invalid_witness_result/);await assert.rejects(adapter.proveBinding(proof),/invalid_witness_result/);
});
test("closed results reject eligibility extra fields malformed metadata and substituted proof facts",async()=>{
 const bridge=new Fake(),adapter=new WitnessAdapter(bridge);
 for(const bad of [{...identityResult,eligible:true},{...identityResult,handle:b(1)},{...identityResult,identity:{...identity,revision:"01"}},{...identityResult,identity:{...identity,metadata:{...metadata,extra:true}}},{...identityResult,identity:{...identity,metadata:{...metadata,certificateChain:[]}}},{...identityResult,identity:{...identity,metadata:{...metadata,spki:b(1)}}},{...identityResult,identity:{...identity,generationChallenge:undefined}}]){bridge.reply=async()=>bad;await assert.rejects(adapter.publicIdentity(),/invalid_witness_result/);}
 for(const bad of [{...signed,binding:{...signed.binding,signature:Buffer.alloc(64).toString("base64")}},{...signed,binding:{...signed.binding,claim:{...signed.binding.claim,version:2}}},{...signed,binding:{...signed.binding,claim:{...signed.binding.claim,nativeRandomNonce:b(42)}}},{...signed,identity:{...identity,creationAttemptId:b(42)}},{...signed,identity:{...identity,generationChallenge:b(42)}}]){bridge.reply=async()=>bad;await assert.rejects(adapter.proveBinding(proof),/invalid_witness_result/);}
 bridge.reply=async()=>signed;await assert.rejects(adapter.proveBinding({...proof,freshValidatorNonce:b(42)}),/invalid_witness_result/);
});
test("cancel selects only current ephemeral native pending ID, never creation ID",async()=>{
 const bridge=new Fake(),operation=deferred<unknown>(),adapter=new WitnessAdapter(bridge);
 bridge.reply=command=>command==="treehouse_witness_cancel"?Promise.resolve({version:1,status:"cancelled"}):operation.promise;
 const running=adapter.generate(generation);await tick();await assert.rejects(adapter.cancel(),/witness_pending_unavailable/);assert.equal(bridge.calls.length,1);
 bridge.event(pending());bridge.event(pending());bridge.event(pending(b(20),"presence"));assert.equal((await adapter.cancel()).status,"cancelled");
 assert.deepEqual(decode(bridge.calls[1]!.args),{attemptId:b(20)});assert.notEqual(b(20),generation.creationAttemptId);
 operation.resolve({version:1,status:"cancelled"});assert.equal((await running).status,"cancelled");await assert.rejects(adapter.cancel(),/witness_pending_unavailable/);assert.equal(bridge.unsubscribed,1);
});
test("changed ID or regressed/malformed events refuse and cancel only previously known ID",async()=>{
 for(const invalid of [pending(b(21)),pending(b(20),"review"),{...pending(),extra:true}]){
 const bridge=new Fake(),operation=deferred<unknown>(),adapter=new WitnessAdapter(bridge);bridge.reply=command=>command==="treehouse_witness_cancel"?Promise.resolve({version:1,status:"cancelled"}):operation.promise;
 const running=adapter.proveBinding(proof),rejected=assert.rejects(running,/invalid_witness_pending_event/);await tick();bridge.event(pending(b(20),"presence"));bridge.event(invalid);await rejected;
 assert.deepEqual(decode(bridge.calls[1]!.args),{attemptId:b(20)});operation.resolve(signed);await tick();assert.equal(bridge.unsubscribed,1);}
});
test("stop before listener readiness prevents invoke and unsubscribes late listener",async()=>{
 const bridge=new Fake(),gate=deferred<void>();bridge.gate=gate.promise;const adapter=new WitnessAdapter(bridge),running=adapter.publicIdentity(),rejected=assert.rejects(running,/witness_stopped/);
 adapter.stop();await rejected;gate.resolve();await tick();assert.equal(bridge.calls.length,0);assert.equal(bridge.unsubscribed,1);await assert.rejects(adapter.publicIdentity(),/witness_stopped/);
});
test("old listener callbacks cannot retarget later operation and stop cancels once",async()=>{
 const bridge=new Fake(),adapter=new WitnessAdapter(bridge);await adapter.publicIdentity();const operation=deferred<unknown>();
 bridge.reply=command=>command==="treehouse_witness_cancel"?Promise.resolve({version:1,status:"cancelled"}):operation.promise;
 const running=adapter.proveBinding(proof),rejected=assert.rejects(running,/witness_stopped/);await tick();bridge.event(pending(b(90)),0);await assert.rejects(adapter.cancel(),/witness_pending_unavailable/);
 bridge.event(pending(),1);adapter.stop();adapter.stop();await rejected;const cancellations=bridge.calls.filter(call=>call.command==="treehouse_witness_cancel");assert.equal(cancellations.length,1);assert.deepEqual(decode(cancellations[0]!.args),{attemptId:b(20)});
 operation.resolve(signed);bridge.event(pending(b(99)),1);await tick();assert.equal(bridge.unsubscribed,2);
});
test("unsupported and native refusal remain refusals and release listeners",async()=>{
 const bridge=new Fake(),adapter=new WitnessAdapter(bridge);for(const reason of ["unsupported_platform","storage_busy","native_consent_required"]){bridge.reply=async()=>{throw reason;};await assert.rejects(adapter.publicIdentity(),new RegExp(reason));}assert.equal(bridge.unsubscribed,3);
});

test("duplicate phase callbacks are idempotent and malformed first events cannot invent cancel IDs",async()=>{
 const bridge=new Fake(),operation=deferred<unknown>();const events:unknown[]=[];
 bridge.reply=()=>operation.promise;const adapter=new WitnessAdapter(bridge,value=>events.push(value));
 const running=adapter.proveBinding(proof),rejected=assert.rejects(running,/invalid_witness_pending_event/);await tick();
 bridge.event(pending());bridge.event(pending());assert.equal(events.length,1);
 bridge.event(pending(b(20),"presence"));assert.equal(events.length,2);
 bridge.event({version:1,attemptId:b(20),phase:{toString:()=>"presence"}});await rejected;
 operation.resolve(signed);
 const second=new Fake(),never=deferred<unknown>();second.reply=()=>never.promise;const other=new WitnessAdapter(second);
 const action=other.generate(generation),failure=assert.rejects(action,/invalid_witness_pending_event/);await tick();
 second.event({version:1,attemptId:"AA==",phase:"review"});await failure;assert.equal(second.calls.length,1);never.resolve({version:1,status:"cancelled"});
});

test("stop remains fail closed if best effort cancellation throws synchronously",async()=>{
 const bridge=new Fake(),operation=deferred<unknown>(),adapter=new WitnessAdapter(bridge);
 bridge.reply=()=>operation.promise;const running=adapter.generate(generation),rejected=assert.rejects(running,/witness_stopped/);await tick();bridge.event(pending());
 bridge.invoke=()=>{throw new Error("unsupported_platform");};adapter.stop();await rejected;await tick();assert.equal(bridge.unsubscribed,1);operation.resolve({version:1,status:"cancelled"});
});

test("listener failure and concurrent requests never invoke another operation",async()=>{
 const bridge=new Fake(),operation=deferred<unknown>(),adapter=new WitnessAdapter(bridge);bridge.reply=()=>operation.promise;
 const running=adapter.publicIdentity();await tick();await assert.rejects(adapter.generate(generation),/witness_busy/);assert.equal(bridge.calls.length,1);
 operation.resolve({version:1,status:"missing"});await running;
 const broken=new Fake();broken.subscribePending=async()=>{throw new Error("unsupported_platform");};
 await assert.rejects(new WitnessAdapter(broken).publicIdentity(),/unsupported_platform/);assert.equal(broken.calls.length,0);
});
test("event delivered before subscription readiness cannot supply a cancellation target",async()=>{
 const bridge=new Fake(),operation=deferred<unknown>(),gate=deferred<void>(),adapter=new WitnessAdapter(bridge);
 bridge.gate=gate.promise;bridge.reply=()=>operation.promise;const running=adapter.publicIdentity();
 bridge.event(pending());gate.resolve();await tick();await assert.rejects(adapter.cancel(),/witness_pending_unavailable/);
 operation.resolve({version:1,status:"missing"});await running;
});
