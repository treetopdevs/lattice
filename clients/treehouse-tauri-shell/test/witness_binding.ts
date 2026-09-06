import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";
import { canonicalBytesForWitnessBinding } from "../src/witness_binding";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/witness_binding_v1.json", import.meta.url), "utf8"));
for (const { name, fields, canonicalBase64, signatureBase64 } of fixture.vectors) {
  const bytes = canonicalBytesForWitnessBinding(fields);
  assert.equal(Buffer.from(bytes).toString("base64"), canonicalBase64, name);
  const key = createPublicKey({key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(fields.actualWitnessPublicKey, "base64")]), format: "der", type: "spki"});
  assert(verify(null, bytes, key, Buffer.from(signatureBase64, "base64")));
  for (const field of Object.keys(fields)) {
    const changed = {...fields, [field]: field === "replica" ? "other" : Buffer.alloc(32, 42).toString("base64")};
    assert(!verify(null, canonicalBytesForWitnessBinding(changed), key, Buffer.from(signatureBase64, "base64")), field);
  }
  bytes.fill(0);
  assert.equal(Buffer.from(canonicalBytesForWitnessBinding(fields)).toString("base64"), canonicalBase64);
}
const fields = fixture.vectors[0].fields;
for (const bad of [null, [], {}, {...fields, extra: 1}, {...fields, product: "township"},
  {...fields, replica: ""}, {...fields, replica: "a".repeat(513)}, {...fields, replica: "🌲".repeat(129)},
  {...fields, replica: "\ud800"}, {...fields, replica: "\udc00"},
  ...Object.keys(fields).filter(k => k !== "replica").flatMap(k => [
    {...fields, [k]: fields[k] + "\n"}, {...fields, [k]: Buffer.alloc(31).toString("base64")},
    {...fields, [k]: Buffer.alloc(33).toString("base64")}, {...fields, [k]: 1},
    Object.fromEntries(Object.entries(fields).filter(([name]) => name !== k)),
  ])]) assert.throws(() => canonicalBytesForWitnessBinding(bad), TypeError);
console.log("PASS three BEAM binding vectors, 27 signed field substitutions, copy isolation and closed shape/UTF-8/Base64 refusals");
