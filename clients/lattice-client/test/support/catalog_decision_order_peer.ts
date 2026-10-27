// Fresh actual-owner inputs for plan283 source ordering agreement.
import {authorTreehouseCommand} from "../../src/treehouse";
import {transportCatalogId} from "../../src/treehouse_catalog_codec";
import {trustFixture,signedCatalog,fixtureId} from "./export_treehouse_catalog_trust";
import {prepareTreehouseCatalogInstallation,evaluateTreehouseCatalogTrust} from "../../src/treehouse_catalog_trust";
const f=await trustFixture(1),expected={trustRevision:0,historyGeneration:0};
const empty=()=>({catalogs:[],rotations:[],histories:[],cutoffProofs:[]});
const prepared=await prepareTreehouseCatalogInstallation({review:f.review,history:f.histories[0]!,store:{kind:"verified_fresh",expected}});
if(prepared.kind!=="propose")throw Error("prepare");
const accepted=await evaluateTreehouseCatalogTrust({installed:prepared.next,expected,incoming:{...empty(),catalogs:[f.catalogJson],histories:f.histories}});
if(accepted.kind!=="propose")throw Error("accept");
const raw=JSON.parse(f.catalogJson);raw[1].find((pair:any)=>pair[0][1]==="signature")[1]=["bin",Buffer.alloc(64).toString("base64")];
const bad=JSON.stringify(raw),wrong=fixtureId("native-scope-order-wrong-bootstrap");
const scoped=await signedCatalog({...f.catalog,bootstrap:wrong,entries:f.catalog.entries.map(e=>e.kind==="space"?{...e,reference:wrong}:e)},f.catalogSigner);
type Input=Parameters<typeof evaluateTreehouseCatalogTrust>[0];
const cases:{name:string;input:Input}[]=[false,true].map(reverse=>({name:`scope-signature-order:${reverse}`,input:{installed:accepted.next,expected,incoming:{...empty(),catalogs:reverse?[scoped,bad]:[bad,scoped]}}}));
const one={...f.catalog,revision:1,previous:transportCatalogId(f.catalog),entries:f.catalog.entries.map(e=>e.kind==="thread"?{...e,route:`/r/${fixtureId("route-blame-moved-child")}`}:e)};
const advanced=await evaluateTreehouseCatalogTrust({installed:accepted.next,expected,incoming:{...empty(),catalogs:[await signedCatalog(one,f.catalogSigner)]}});
if(advanced.kind!=="propose")throw Error("advance");
const f2=await trustFixture(2),oldRoute=f.catalog.entries.find(e=>e.kind==="thread")!.route;
let collision:string|undefined;
for(let n=0;n<64;n++){
  const c={...f2.catalog,revision:2,previous:transportCatalogId(one),entries:f2.catalog.entries.map(e=>e.kind==="space"?{...e,route:`/r/${fixtureId(`route-blame-space-${n}`)}`}:
    e.replica===f.threads[0]!.replica?{...e,route:one.entries.find(x=>x.replica===e.replica)!.route}:{...e,route:oldRoute})};
  if(transportCatalogId(c)<transportCatalogId(f.catalog)&&transportCatalogId(c)<transportCatalogId(one)){collision=await signedCatalog(c,f.catalogSigner);break;}
}
if(!collision)throw Error("collision ordering");
for(const reverse of [false,true])cases.push({name:`route-collision-blame:${reverse}`,input:{installed:advanced.next,expected,incoming:{...empty(),catalogs:[collision],histories:reverse?[...f2.histories].reverse():f2.histories}}});
const forkJson=await signedCatalog({...f.catalog,entries:f.catalog.entries.map(e=>({...e,route:`/r/${fixtureId("frozen-witness:"+e.replica)}`}))},f.catalogSigner);
const frozen=await evaluateTreehouseCatalogTrust({installed:accepted.next,expected,incoming:{...empty(),catalogs:[forkJson]}});
if(frozen.kind!=="retain_blocked"||frozen.reason!=="catalog_fork")throw Error("fork");
const boot=await authorTreehouseCommand({product:"Treehouse.Space",replica:f.space.replica,signer:f.root,deps:[f.space.frames.at(-1)!.id],capId:f.space.delegation.id,
  command:{command:"catalog_bootstrap_v1",record:{...f.bootstrapRecord,nonce:fixtureId("new-bootstrap-after-graph-fork")}}});
for(const reverse of [false,true])cases.push({name:`graph-fork-before-bootstrap:${reverse}`,input:{installed:frozen.next,expected,incoming:{...empty(),histories:[{...f.histories[0]!,frames:reverse?[...f.space.frames,boot].reverse():[...f.space.frames,boot]}]}}});
type Decision=Awaited<ReturnType<typeof evaluateTreehouseCatalogTrust>>;
const table:{name:string;orders:{input:Input;decision:Decision}[]}[]=[];
for(let index=0;index<cases.length;index+=2){
  const pair=cases.slice(index,index+2);const orders:{input:Input;decision:Decision}[]=[];
  for(const item of pair)orders.push({input:item.input,decision:await evaluateTreehouseCatalogTrust(item.input)});
  table.push({name:pair[0]!.name.split(":")[0]!,orders});
}
await new Promise<void>(resolve=>process.stdout.write(JSON.stringify({cases:table})+"\n",()=>resolve()));
