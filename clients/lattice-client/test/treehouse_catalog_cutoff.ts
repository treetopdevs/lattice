import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalBytesForCarrierOp, canonicalBytesForCarrierTerm, canonicalHash } from "../src/codec";
import type { CarrierTerm } from "../src/carrier";
import { cutoffFixture } from "./support/export_treehouse_catalog_cutoff";

// Integrator-adopted cutoff-only scope, 2026-09-06: raw authenticated history,
// separately validated bad_signature evidence, 64 generic composites, exact
// uint64 tagged decimals, actual {type:"push",ops:[frame]} <=64,000 bytes, and
// fixed130 atom vocabulary (artifact SHA256 a66d085dd185091d745d933c3145101a97b3306406aba905af07ca051d09506c).
// No semantic decoding, generic ingress changes, persistence or trust promotion.
const module = await import("../src/treehouse_catalog_cutoff").catch(() => null);
const bin = (value: Uint8Array | string): CarrierTerm => ["bin", Buffer.from(value).toString("base64")];

test("public cutoff commits exact authenticated payloads including a semantic refusal and uint64 legacy epoch", async () => {
  const f = await cutoffFixture();
  assert.ok(module, "raw authenticated cutoff observation is not implemented");
  const result = await module.deriveTreehouseCatalogCutoff({ replica: f.replica, frames: f.frames, rejected: [] });
  const records = [...f.frames].sort((a, b) => a.id.localeCompare(b.id, "en", { sensitivity: "variant" }));
  // IDs use unsigned UTF8 ordering, independently from JSON object presentation.
  records.sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
  const ops = records.map((frame) => ({ id: frame.id, bytes: canonicalBytesForCarrierOp(frame), sig: Buffer.from(frame.sig, "base64") }));
  const terms: CarrierTerm[] = ops.map((op) => ["map", [
    [["atom", "id"], bin(op.id)], [["atom", "bytes"], bin(op.bytes)], [["atom", "sig"], bin(op.sig)],
  ]]);
  const bytes = canonicalBytesForCarrierTerm(["list", [bin("lattice-treehouse-recovery-cutoff-v1"), bin(f.replica), ["list", terms], ["list", []]]]);
  assert.deepEqual(result, { ok: true, cutoff: { replica: f.replica, frontier: [f.genuine.id], logDigest: await canonicalHash(bytes) },
    canonicalBytes: bytes, ops, rejected: [] });
});
