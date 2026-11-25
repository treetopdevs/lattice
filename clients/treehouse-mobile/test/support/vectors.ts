import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  carrierOpsToSemanticOps,
  materialize,
  observeTreehouse,
  treehouseCommandDecoders,
  treehouseSpaceSchema,
  treehouseThreadSchema,
  verifyCarrierOp,
  verifyEd25519,
} from "@treetopdevs/lattice-client";
import type { CarrierOpFrame, TreehouseProduct } from "@treetopdevs/lattice-client";

// Sim vectors from lattice-client. Every expected value is read from the JSON that `Lattice.Sim`
// generated; nothing here is derived from lattice-client, so a test that compares a reduction with
// `expected` compares the app's reducer path with Sim, never with itself.
//
//   expected.state       = expectAtFullFrontier.state
//   expected.order       = treehouseObservation.posts[].id (the timeline order Sim observed)
//   expected.quarantined = expectAtFullFrontier.authorityQuarantine as { id: reason }
//                          (its ids equal expectAtFullFrontier.quarantine in all four vectors)

const VECTOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../lattice-client/test/vectors");

export interface TreehouseVector {
  replica: string;
  product: TreehouseProduct;
  frames: CarrierOpFrame[];
  realmByPubkey: Record<string, string>;
  expected: { state: unknown; order: string[]; quarantined: Record<string, string> };
}

interface RawVector {
  replica: string;
  schema: { name: TreehouseProduct };
  oracleCarrierOps: CarrierOpFrame[];
  realmByPubkey: Record<string, string>;
  expectAtFullFrontier: { state: unknown; quarantine: string[]; authorityQuarantine?: [string, string][] };
  treehouseObservation?: { posts: { id: string }[] };
}

export function loadTreehouseVector(name: string): TreehouseVector {
  if (!/^treehouse_[a-z_]+$/.test(name)) throw new Error(`not a Treehouse vector name: ${name}`);
  const raw = JSON.parse(readFileSync(join(VECTOR_DIR, `${name}.json`), "utf8")) as RawVector;
  const quarantined = Object.fromEntries(raw.expectAtFullFrontier.authorityQuarantine ?? []);
  const listed = [...raw.expectAtFullFrontier.quarantine].sort();
  if (JSON.stringify(Object.keys(quarantined).sort()) !== JSON.stringify(listed))
    throw new Error(`${name}: quarantine and authorityQuarantine disagree`);
  return {
    replica: raw.replica,
    product: raw.schema.name,
    frames: raw.oracleCarrierOps,
    realmByPubkey: raw.realmByPubkey,
    expected: {
      state: raw.expectAtFullFrontier.state,
      order: (raw.treehouseObservation?.posts ?? []).map((post) => post.id),
      quarantined,
    },
  };
}

/** The product a replica id names; vector replicas use `treehouse:<kind>:` and app replicas `replica:treehouse:<kind>:`. */
export function productOf(replica: string): TreehouseProduct {
  if (/^(replica:)?treehouse:space:/.test(replica)) return "Treehouse.Space";
  if (/^(replica:)?treehouse:thread:/.test(replica)) return "Treehouse.Thread";
  throw new Error(`not a Treehouse replica: ${replica}`);
}

export interface Judged {
  state: unknown;
  /** Visible post ids in timeline order (empty for a Space). */
  order: string[];
  quarantined: Record<string, string>;
}

/** Reduce frames through lattice-client's decoders and judge. This file adds no reducer of its own. */
export function judgeTreehouseFrames(
  replica: string,
  frames: readonly CarrierOpFrame[],
  realmByPubkey: Record<string, string> = {},
): Judged {
  const product = productOf(replica);
  const ops = carrierOpsToSemanticOps([...frames], realmByPubkey, treehouseCommandDecoders(product));
  const schema = product === "Treehouse.Space" ? treehouseSpaceSchema : treehouseThreadSchema;
  const result = materialize(schema, ops);
  return {
    state: result.state,
    order: observeTreehouse(product, ops).posts.map((post) => post.id),
    quarantined: Object.fromEntries([...result.quarantineReasons.entries()]),
  };
}

const fromBase64 = (value: string) => Uint8Array.from(Buffer.from(value, "base64"));

/** Strict Ed25519 check of every frame's hash and signature; throws on the first failure. */
export async function verifyFrames(frames: readonly CarrierOpFrame[]): Promise<void> {
  for (const frame of frames) {
    const result = await verifyCarrierOp(frame, {
      verify: async (pub, bytes, sig) => verifyEd25519(sig, bytes, fromBase64(pub)),
    });
    if (!result.valid) throw new Error(`frame ${frame.id} failed verification`);
  }
}
