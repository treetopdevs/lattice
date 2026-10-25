import { authorCarrierOpUnchecked } from "./unchecked_author";
import { canonicalBytesForCarrierTerm, canonicalHash } from "../../src/codec";
import type { CarrierTerm } from "../../src/carrier";
import type { trustFixture } from "./export_treehouse_catalog_trust";
export type ProbeInput = [string, unknown[], unknown[]?];
type Fixture = Awaited<ReturnType<typeof trustFixture>>;
const bin = (value: Uint8Array | string): CarrierTerm => ["bin", Buffer.from(value).toString("base64")];

export async function boundaryCases(f: Fixture): Promise<ProbeInput[]> {
  const missing = "A".repeat(43);
  const cap: CarrierTerm = ["nil"];
  const raw = async (kind: string, body: CarrierTerm, deps: string[] = []) => {
    const bytes = canonicalBytesForCarrierTerm(["list", [bin("lattice-op-v2"), bin(f.space.replica), bin(f.root.publicKey), ["list", [...new Set(deps)].sort().map(bin)], ["atom", kind], body, cap]]);
    return {v: 1, id: await canonicalHash(bytes), replica: f.space.replica, author: Buffer.from(f.root.publicKey).toString("base64"), deps, kind, body, cap, sig: Buffer.from(await f.root.sign(bytes)).toString("base64")};
  };
  const atSize = async (size: number, deps: string[] = []) => {
    for (const marker of [0, 10, 100, 1000]) {
      const body = (value: Uint8Array): CarrierTerm => ["tuple", [["atom", "post"], ["list", [bin(value), ["int", marker]]]]];
      const empty = await authorCarrierOpUnchecked({replica:f.space.replica, signer:f.root, deps, kind:"command", body:body(Buffer.alloc(0)), cap});
      const available = size - Buffer.byteLength(JSON.stringify({type:"push",ops:[empty]}));
      if (available >= 0 && available % 4 === 0) {
        const frame = await authorCarrierOpUnchecked({replica:f.space.replica, signer:f.root, deps, kind:"command", body:body(Buffer.alloc(available / 4 * 3, 120)), cap});
        if (Buffer.byteLength(JSON.stringify({type:"push",ops:[frame]})) !== size) throw new Error("exact push size producer");
        return frame;
      }
    }
    throw new Error("no exact push size encoding");
  };
  const results: ProbeInput[] = [];
  for (const deps of [[], [missing]]) {
    const suffix = deps.length === 0 ? "complete" : "partial";
    const nil = await raw("command", ["nil"], deps);
    results.push([`malformed-scalar-arity-${suffix}`,[...f.histories[0]!.frames,{...nil,body:["nil",0]}]]);
    const unknown = await raw("future_incoming_kind", ["nil"], deps);
    results.push([`unknown-kind-${suffix}`, [...f.histories[0]!.frames, unknown]]);
    results.push([`forged-unknown-kind-${suffix}`, [...f.histories[0]!.frames, {...unknown,sig:Buffer.alloc(64).toString("base64")}]]);
    for (const size of [64000,64001]) {
      const frame = await atSize(size,deps);
      results.push([`push-${size}-${suffix}`,[...f.histories[0]!.frames,frame]]);
    }
    let delegated:CarrierTerm=["delegation",f.space.delegation];
    for(let n=0;n<64;n++) delegated=["map",[[["nil"],delegated]]];
    results.push([`map-64-delegation-leaf-${suffix}`,[...f.histories[0]!.frames,await raw("command",delegated,deps)]]);
    delegated=["map",[[["nil"],delegated]]];
    results.push([`map-65-delegation-leaf-${suffix}`,[...f.histories[0]!.frames,await raw("command",delegated,deps)]]);
    for (const depth of [64,65,66]) {
      let body:CarrierTerm=["nil"];
      for(let n=0;n<depth;n++) body=["map",[[["nil"],body]]];
      const frame=await raw("command",body,deps);
      results.push([`map-depth-${depth}-${suffix}`,[...f.histories[0]!.frames,frame]]);
    }
    for (const depth of [64,65,66]) {
      let body: CarrierTerm = ["nil"];
      for (let n=0;n<depth;n++) body=["list",[body]];
      const frame=await raw("command",body,deps);
      results.push([`depth-${depth}-${suffix}`,[...f.histories[0]!.frames,frame]]);
      results.push([`forged-depth-${depth}-${suffix}`,[...f.histories[0]!.frames,{...frame,sig:Buffer.alloc(64).toString("base64")}]]);
    }
  }
  return results;
}
