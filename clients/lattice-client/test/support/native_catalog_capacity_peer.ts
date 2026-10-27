// Fresh maximum-size source values; files keep large evidence out of the IPC response.
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {produce,check} from "./catalog_valid_capacity_fixture";
function digest(value:unknown):string {
 const hash=createHash("sha256");
 const walk=(v:unknown):void=>{
  if(Array.isArray(v)){hash.update("[");v.forEach((x,i)=>{if(i)hash.update(",");walk(x);});hash.update("]");}
  else if(v!==null&&typeof v==="object"){hash.update("{");Object.keys(v).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))).forEach((k,i)=>{if(i)hash.update(",");hash.update(JSON.stringify(k)+":");walk((v as Record<string,unknown>)[k]);});hash.update("}");}
  else { if(typeof v==="number")assert.ok(Number.isSafeInteger(v),"capacity digest fixture uses safe integers only"); hash.update(JSON.stringify(v)); }
 };walk(value);return hash.digest("base64url");
}
const {directory}=JSON.parse(readFileSync(0,"utf8")) as {directory:string};
assert.equal(typeof directory,"string");
const bundle=await produce(),results=await check(bundle);
const path=join(directory,"capacity.json");
writeFileSync(path,JSON.stringify({...bundle,initial:results.initial.next}),{flag:"wx"});
const names=["accepted","reopened","proposedOver","savedOver"] as const;
console.log(JSON.stringify({path,frameCount:bundle.frameCount,cases:names.map(name=>({name,
 kind:results[name].kind,reason:results[name].reason,decisionSha256:digest(results[name])}))}));
