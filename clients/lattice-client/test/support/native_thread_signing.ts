// Reciprocal custody test: only public keys cross into Node; every signature comes from native Rust.
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { ed25519 } from "@noble/curves/ed25519.js";
import { prepareTreehouseBoundedThreadCreation, authorTownshipDelegation, carrierDelegationsFromFrames, verifyCarrierOp } from "../../src/index";
const [childKey, spaceKey, nonce] = process.argv.slice(2);
assert(childKey && spaceKey && nonce);
const inputLines = createInterface({ input: process.stdin });
const input = inputLines[Symbol.asyncIterator]();
const signer = { publicKey: Buffer.from(childKey, "base64"), sign: async (bytes: Uint8Array) => {
  process.stdout.write(JSON.stringify({ sign: Buffer.from(bytes).toString("base64") }) + "\n");
  const reply = await input.next();
  assert(!reply.done, "native signer must answer");
  return Buffer.from(reply.value, "base64");
} };
const pub = (n: number) => ed25519.getPublicKey(new Uint8Array(32).fill(n));
const prepared = await prepareTreehouseBoundedThreadCreation({
  replica: `replica:treehouse:thread:${nonce}`, title: "Native signed", signer, spaceRoot: spaceKey,
  nominee: pub(101), witnesses: [102, 103, 104].map(pub), threshold: 2, maxLeaseEpochs: 7,
});
const leased = await authorTownshipDelegation({ replica: prepared.replica, signer,
  deps: [prepared.pending.at(-1)!.id], audiencePubkey: pub(105),
  parentId: carrierDelegationsFromFrames(prepared.pending)[0]!.id,
  ops: ["post"], roles: [], live: false, expiresEpoch: 7,
});
for (const frame of [...prepared.pending, leased]) {
  const verified = await verifyCarrierOp(frame, { verify: async (pub, bytes, sig) => ed25519.verify(sig, bytes, Buffer.from(pub, "base64"), { zip215: false }) });
  assert(verified.valid, "the real native signature must verify through the client codec");
}
process.stdout.write(JSON.stringify({ done: true, frames: [...prepared.pending, leased] }) + "\n", () => { inputLines.close(); process.stdin.destroy(); });
