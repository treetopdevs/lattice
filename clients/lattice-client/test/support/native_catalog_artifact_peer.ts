// Reuse the real public-owner corpus, then probe foreign grammar explicitly.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {prepareTreehouseCatalogInstallation,evaluateTreehouseCatalogTrust} from "../../src/treehouse_catalog_trust";
const output=execFileSync(process.execPath,["--import","tsx",fileURLToPath(new URL("./catalog_artifact_integer_peer.ts",import.meta.url))],{maxBuffer:4*1024*1024});
const table=JSON.parse(output.toString("utf8"));
const b=table.bundle,expected={trustRevision:0,historyGeneration:0};
const p=await prepareTreehouseCatalogInstallation({review:b.review,history:b.histories[0],store:{kind:"verified_fresh",expected}});
assert.equal(p.kind,"propose");
const base=await evaluateTreehouseCatalogTrust({installed:p.next,expected,incoming:{catalogs:[b.catalogJson],rotations:[],histories:b.histories,cutoffProofs:[]}});
assert.equal(base.kind,"propose");
table.foreign=[];
for(const expires_epoch of [5,"5"]){
 const json=JSON.stringify(["delegation",{id:"",replica:"",issuer:Buffer.alloc(32,7).toString("base64"),audience:Buffer.alloc(32,7).toString("base64"),parent_id:null,ops:["int","5"],roles:[],live:true,sig:Buffer.alloc(64,9).toString("base64"),expires_epoch}]);
 const d=await evaluateTreehouseCatalogTrust({installed:p.next,expected,incoming:{catalogs:[json],rotations:[],histories:b.histories,cutoffProofs:[]}});
 assert.equal(d.kind,"reject");assert.equal(d.reason,"malformed_catalog");
 table.foreign.push({json,result:{kind:d.kind,reason:d.reason}});
 for(const rotation of [false,true]){
  const original=rotation?b.rotationJson:b.catalogJson;
  const nested=original.replace('["int",1]',json);
  assert.notEqual(nested,original);
  const result=await evaluateTreehouseCatalogTrust({installed:rotation?base.next:p.next,expected,incoming:{catalogs:rotation?[]:[nested],rotations:rotation?[nested]:[],histories:b.histories,cutoffProofs:[]}});
  assert.equal(result.kind,"reject");assert.equal(result.reason,"malformed_catalog");
  table.foreign.push({json:nested,result:{kind:result.kind,reason:result.reason}});
 }
}
console.log(JSON.stringify(table));
