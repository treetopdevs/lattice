// Fresh authenticated large-history inputs for isolated native resource accounting.
import assert from "node:assert/strict";
import {trustFixture,fixtureSigner} from "./export_treehouse_catalog_trust";
import {authorTreehouseRoleTransfer} from "../../src/treehouse";
import {authorCarrierOpUnchecked} from "./unchecked_author";
import {deriveTreehouseCatalogCutoff} from "../../src/treehouse_catalog_cutoff";
import {prepareTreehouseCatalogInstallation,evaluateTreehouseCatalogTrust} from "../../src/treehouse_catalog_trust";
const profile=process.argv[2]==="input",mib=profile?Number(process.argv[3]??1):0;
const copies=profile?Number(process.argv[4]??4):4;
const aliases=profile&&process.argv[5]==="aliases";
const saved=profile&&process.argv[5]==="saved";
const frozen=profile&&process.argv[5]==="frozen";
const fallback=profile&&process.argv[5]==="fallback";
assert.ok(Number.isInteger(mib)&&mib>=0&&mib<=16);
assert.ok(Number.isInteger(copies)&&copies>=0&&copies<=4);
const f=await trustFixture(0),expected={trustRevision:0,historyGeneration:0};
const empty=()=>({catalogs:[],rotations:[],histories:[],cutoffProofs:[]});
const prepared=await prepareTreehouseCatalogInstallation({review:f.review,history:f.histories[0]!,store:{kind:"verified_fresh",expected}});
assert.equal(prepared.kind,"propose");
const accepted=await evaluateTreehouseCatalogTrust({installed:prepared.next,expected,incoming:{...empty(),catalogs:[f.catalogJson],histories:f.histories}});
assert.equal(accepted.kind,"propose");
const baseline=f.histories[0]!,frames=structuredClone(baseline.frames);
let bytes=Buffer.byteLength(JSON.stringify(baseline));
const target=mib*1024*1024||12_000;
while(bytes<target){
 const text=`resource:${frames.length}:`+"x".repeat(mib?44_000:256);
 const frame=await authorCarrierOpUnchecked({replica:f.space.replica,signer:f.root,deps:[f.bootstrap.id],kind:"command",cap:["nil"],
   body:["tuple",[["atom","create_space"],["list",[["bin",Buffer.from(text).toString("base64")]]]]]});
 assert.ok(Buffer.byteLength(JSON.stringify({type:"push",ops:[frame]}))<=64_000);
 bytes+=Buffer.byteLength(JSON.stringify(frame))+1;frames.push(frame);
}
const history={...baseline,frames};
const cutoff=await deriveTreehouseCatalogCutoff(history);assert.equal(cutoff.ok,true);
if(!cutoff.ok)throw Error("genuine portable history prerequisite");
const proof={cutoff:cutoff.cutoff,history};
const input={installed:structuredClone(accepted.next),expected,incoming:{...empty(),histories:[structuredClone(history)],cutoffProofs:Array.from({length:copies},()=>structuredClone(proof))}};
if(aliases){
 for(const row of input.incoming.cutoffProofs.slice(1)){
  const frame=row.history.frames.find(f=>f.deps.length>0)!;
  assert.ok(frame);frame.deps.push(frame.deps[0]!);
 }
}
const decision=await evaluateTreehouseCatalogTrust(input);
assert.equal(decision.kind,"propose");assert.equal(decision.reason,null);assert.equal(decision.routes.length,1);
assert.deepEqual(decision.next.accepted,accepted.next.accepted);
assert.equal(decision.next.cutoffProofs.length,copies?1:0);
const savedInput={installed:structuredClone(decision.next),expected,incoming:empty()};
const savedDecision=await evaluateTreehouseCatalogTrust(savedInput);
assert.equal(savedDecision.kind,"unchanged");assert.equal(savedDecision.reason,null);
assert.deepEqual(savedDecision.next,decision.next);
const {frame:transfer}=await authorTreehouseRoleTransfer({replica:f.space.replica,deps:[f.space.creation.id],signer:f.root,parent:f.space.delegation,
 recipient:fixtureSigner("resource-role-successor").publicKey,action:"transfer_admin"});
const frozenInput={...savedInput,incoming:{...empty(),histories:[{...history,frames:[...frames,transfer]}]}};
const frozenDecision=await evaluateTreehouseCatalogTrust(frozenInput);
assert.equal(frozenDecision.kind,"retain_blocked");assert.equal(frozenDecision.reason,"authority_changed");
const fallbackInput={...frozenInput,incoming:{...frozenInput.incoming,catalogs:["not JSON"]}};
const fallbackDecision=await evaluateTreehouseCatalogTrust(fallbackInput);
assert.equal(fallbackDecision.kind,"retain_blocked");assert.equal(fallbackDecision.reason,"authority_changed");
const badProofInput={...frozenInput,incoming:{...frozenInput.incoming,cutoffProofs:[{} as never]}};
const badProofDecision=await evaluateTreehouseCatalogTrust(badProofInput);
assert.equal(badProofDecision.kind,"retain_blocked");assert.equal(badProofDecision.reason,"authority_changed");
console.log(JSON.stringify(profile?(saved?savedInput:frozen?frozenInput:fallback?fallbackInput:input):{cases:[
 {name:"authenticated-resource-context",input,decision},
 {name:"authenticated-resource-saved-reopen",input:savedInput,decision:savedDecision},
 {name:"authenticated-resource-security-success",input:frozenInput,decision:frozenDecision},
 {name:"authenticated-resource-security-fallback-artifact",input:fallbackInput,decision:fallbackDecision},
 {name:"authenticated-resource-security-fallback-proof",input:badProofInput,decision:badProofDecision},
]}));
