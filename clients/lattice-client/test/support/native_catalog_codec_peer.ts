// Independent executable peer for the native authenticity codec; no installed trust.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalBytesForCarrierTerm, carrierTermFromCanonicalBytes, verifyCarrierOp } from "../../src/codec";
import { catalogEnvelopeFromCarrierTerm, canonicalBytesForTransportCatalog, transportCatalogId, verifyCatalogEnvelope } from "../../src/treehouse_catalog_codec";
import { decodeCarrierOpFrame } from "../../src/carrier";
import { trustFixture } from "./export_treehouse_catalog_trust";

if (process.argv[2] === "produce") {
  const f = await trustFixture();
  console.log(JSON.stringify({catalog_envelope_term: JSON.parse(f.catalogJson),
    expected_catalog_key: Buffer.from(f.catalogSigner.publicKey).toString("base64"),
    catalog_id: transportCatalogId(f.catalog),
    catalog_bytes: Buffer.from(canonicalBytesForTransportCatalog(f.catalog)).toString("base64"),
    frames: f.histories.flatMap((history) => history.frames)}));
} else if (process.argv[2] === "boundaries") {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const terms = input.terms.map((item: {term: Parameters<typeof canonicalBytesForCarrierTerm>[0], bytes: string}) => {
    try {
      carrierTermFromCanonicalBytes(Buffer.from(item.bytes,"base64"));
      return {accepted: true, bytes: Buffer.from(canonicalBytesForCarrierTerm(item.term)).toString("base64")};
    } catch { return {accepted: false}; }
  });
  const frames = await Promise.all(input.frames.map(async (item: {frame: Parameters<typeof verifyCarrierOp>[0]}) => {
    let admitted = false, authentic = false;
    try {
      const checked = await verifyCarrierOp(item.frame, {verify: async (author, bytes, sig) =>
        ed25519.verify(sig, bytes, Buffer.from(author,"base64"), {zip215:false})});
      authentic = checked.valid;
      decodeCarrierOpFrame(item.frame);
      admitted = authentic;
    } catch { /* Admission and cryptographic verification are separate observations. */ }
    return {admitted, authentic};
  }));
  console.log(JSON.stringify({terms,frames}));
} else {
  assert.equal(process.argv[2], "consume");
  const f = JSON.parse(readFileSync(0, "utf8"));
  for (const item of f.terms) assert.equal(Buffer.from(canonicalBytesForCarrierTerm(item.term)).toString("base64"), item.bytes);
  const frame = await verifyCarrierOp(f.frame, {verify: async (author, bytes, signature) =>
    ed25519.verify(signature, bytes, Buffer.from(author, "base64"), {zip215: false})});
  assert.equal(frame.valid, true);
  const envelope = catalogEnvelopeFromCarrierTerm(f.catalog_envelope_term);
  assert.ok(envelope);
  assert.equal(verifyCatalogEnvelope(envelope, f.expected_catalog_key), true);
  assert.equal(transportCatalogId(envelope.catalog), f.catalog_id);
  assert.equal(Buffer.from(canonicalBytesForTransportCatalog(envelope.catalog)).toString("base64"), f.catalog_bytes);
  console.log(JSON.stringify({terms: f.terms.length, frame: f.frame.id, catalog: f.catalog_id}));
}
