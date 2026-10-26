// Fresh full-resolver requests and actual public decisions. No saved verdict is
// consumed by a native evaluator; this is the executable acceptance contract.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {trustFixture, signedCatalog, fixtureId} from "./export_treehouse_catalog_trust";
import {catalogRotationEnvelopeFromCarrierTerm, catalogRotationId, transportCatalogId} from "../../src/treehouse_catalog_codec";
import {prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust} from "../../src/treehouse_catalog_trust";
import type {TreehouseCatalogEvidencePage, InstalledTreehouseCatalogTrustV1} from "../../src/treehouse_catalog_trust";
type Input = Parameters<typeof evaluateTreehouseCatalogTrust>[0];
type Decision = Awaited<ReturnType<typeof evaluateTreehouseCatalogTrust>>;
const expected = {trustRevision: 0, historyGeneration: 0};
const empty = ():TreehouseCatalogEvidencePage => ({catalogs: [], rotations: [], histories: [], cutoffProofs: []});
if (process.argv[2] === "consume") {
  const requests = JSON.parse(readFileSync(0,"utf8")) as {cases:{name:string;input:Input}[]};
  const results:{name:string;decision:Decision}[]=[];
  for (const item of requests.cases) results.push({name:item.name,decision:await evaluateTreehouseCatalogTrust(item.input)});
  await new Promise<void>(resolve=>process.stdout.write(JSON.stringify({results})+"\n",()=>resolve()));
} else {
  const f = await trustFixture(1);
  const prepared = await prepareTreehouseCatalogInstallation({review:f.review,history:f.histories[0]!,store:{kind:"verified_fresh",expected}});
  assert.equal(prepared.kind,"propose");
  const inputs:{name:string;input:Input}[]=[];
  const add=(name:string, installed:InstalledTreehouseCatalogTrustV1, incoming:TreehouseCatalogEvidencePage)=>inputs.push({name,input:{installed:structuredClone(installed),expected:{...expected},incoming:structuredClone(incoming)}});
  add("empty-installed-inventory",prepared.next,empty());
  add("complete-acceptance",prepared.next,{...empty(),catalogs:[f.catalogJson],histories:f.histories});
  add("genuine-pending-entry",prepared.next,{...empty(),catalogs:[f.catalogJson]});
  const bad=await signedCatalog({...f.catalog,entries:f.catalog.entries.map(e=>e.kind==="thread"?{...e,root:f.bootstrapRecord.spaceRoot,creation:fixtureId("resolver-missing-creation")}:e)},f.catalogSigner);
  add("available-invalid-before-missing",prepared.next,{...empty(),catalogs:[bad],histories:f.histories});
  const accepted=await evaluateTreehouseCatalogTrust(inputs.find(c=>c.name==="complete-acceptance")!.input);
  assert.equal(accepted.kind,"propose");assert.notEqual(accepted.next.accepted,null);
  add("accepted-reopen",accepted.next,empty());
  const corrupt=structuredClone(accepted.next);
  corrupt.histories[0]!.frames=corrupt.histories[0]!.frames.map((frame,n)=>n===0?{...(frame as object),sig:Buffer.alloc(64).toString("base64")}:frame);
  add("corrupt-original-cannot-be-repaired",corrupt,{...empty(),catalogs:[f.catalogJson],histories:f.histories});
  const rotation=catalogRotationEnvelopeFromCarrierTerm(JSON.parse(f.rotationJson))!;
  const rotatedJson=await signedCatalog({...f.catalog,binding:catalogRotationId(rotation)},f.nextCatalogSigner);
  add("rotation-missing-proof",accepted.next,{...empty(),catalogs:[rotatedJson],rotations:[f.rotationJson]});
  add("rotation-with-proof",accepted.next,{...empty(),catalogs:[rotatedJson],rotations:[f.rotationJson],cutoffProofs:f.cutoffProofs});
  const rotated=await evaluateTreehouseCatalogTrust(inputs.find(c=>c.name==="rotation-with-proof")!.input);
  assert.equal(rotated.kind,"propose");assert.equal(rotated.next.accepted!.generation,1);
  const forkJson=await signedCatalog({...f.catalog,revision:1,previous:transportCatalogId(f.catalog)},f.catalogSigner);
  const forkInput={installed:rotated.next,expected,incoming:{...empty(),catalogs:[forkJson]}};
  add("historical-catalog-fork",forkInput.installed,forkInput.incoming);
  const frozen=await evaluateTreehouseCatalogTrust(forkInput);
  assert.equal(frozen.kind,"retain_blocked");assert.equal(frozen.reason,"catalog_fork");
  add("blocked-reopen",frozen.next,empty());
  const cases:{name:string;orders:{input:Input;decision:Decision}[]}[]=[];
  for (const item of inputs) {
    const orders:{input:Input;decision:Decision}[]=[];
    for (const reverse of [false,true]) {
      const input=structuredClone(item.input);
      if(reverse) {
        input.installed.catalogs.reverse();input.installed.rotations.reverse();input.installed.histories.reverse();input.installed.cutoffProofs.reverse();
        input.incoming.catalogs=[...input.incoming.catalogs].reverse();input.incoming.rotations=[...input.incoming.rotations].reverse();
        input.incoming.histories=[...input.incoming.histories].reverse();input.incoming.cutoffProofs=[...input.incoming.cutoffProofs].reverse();
        for(const h of [...input.installed.histories,...input.incoming.histories]){h.frames=[...h.frames].reverse();h.rejected=[...h.rejected].reverse();}
      }
      const before=JSON.stringify(input),decision=await evaluateTreehouseCatalogTrust(input);
      assert.equal(JSON.stringify(input),before,"public owner mutates input");
      if(item.name==="available-invalid-before-missing")assert.equal(decision.reason,"invalid_catalog_transition");
      if(item.name==="corrupt-original-cannot-be-repaired")assert.equal(decision.reason,"trust_recovery_required");
      orders.push({input,decision});
    }
    cases.push({name:item.name,orders});
  }
  assert.equal(cases.length,10);
  await new Promise<void>(resolve=>process.stdout.write(JSON.stringify({cases})+"\n",()=>resolve()));
}
