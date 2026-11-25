import assert from "node:assert/strict";
import WebSocket from "ws";
import {
  base64ToBytes,
  connectCarrierWebSocket,
  verifyEd25519,
} from "@treetopdevs/lattice-client";
import { createIdentityFromSeedHex } from "../src/lib/custody";
import type { DemoEndpointsManifest } from "../src/lib/browser_host";

const origin = (process.argv[2] || process.env.DEMO_WSS_ORIGIN || "https://lattice-demo-wss.fly.dev").replace(
  /\/$/,
  "",
);

const manifestRes = await fetch(`${origin}/demo-endpoints.json`, { cache: "no-store" });
assert.equal(manifestRes.status, 200, `GET ${origin}/demo-endpoints.json failed`);
const manifest = (await manifestRes.json()) as DemoEndpointsManifest;

const seedRes = await fetch(`${origin}/demo-seed/founder`, { cache: "no-store" });
assert.equal(seedRes.status, 200, `GET ${origin}/demo-seed/founder failed`);
const seedJson = (await seedRes.json()) as { realm: string; seedHex: string };
const founder = createIdentityFromSeedHex(seedJson.realm, seedJson.seedHex);

const verifier = {
  verify: (pk: Uint8Array, msg: Uint8Array, sig: Uint8Array) => verifyEd25519(sig, msg, pk),
};

for (const ep of manifest.endpoints) {
  assert.ok(ep.ws_url.startsWith("wss://"), `expected wss:// URL for ${ep.name}, got ${ep.ws_url}`);
  const client = await connectCarrierWebSocket({
    url: ep.ws_url,
    localRealm: founder.realm,
    replica: ep.replica,
    signer: founder.signer,
    expectedPeerRealm: ep.peer_realm,
    expectedPeerPubkey: base64ToBytes(ep.peer_pubkey),
    verifier,
    webSocket: WebSocket as unknown as typeof globalThis.WebSocket,
  });
  const ids = await client.advertise();
  client.close();
  assert.ok(ids.length >= ep.initial_ops, `expected >= ${ep.initial_ops} ops on ${ep.name}, got ${ids.length}`);
  console.log(`WSS OK: ${ep.name} (${ep.ws_url}) -> ${ids.length} ops`);
}

console.log(`PASS: all ${manifest.endpoints.length} authenticated WSS carrier routes verified on ${origin}!`);
