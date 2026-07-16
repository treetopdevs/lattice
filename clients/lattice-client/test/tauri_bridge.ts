import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  authorAndPersistTownshipCommand,
  carrierOpsToSemanticOps,
  carrierTranscriptBytes,
  createJsonCarrierFrameStore,
  createJsonLocalOpLogStore,
  createTauriCarrierSigner,
  createTauriKeyValueStore,
  createTauriNativeCarrierSigner,
  signCarrierChallenge,
} from "../src/index";
import type { CarrierOpFrame, TauriInvoke } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(join(here, "vectors", "township_carrier_w1.json"), "utf8"),
) as TownshipCarrierVector;

let failures = 0;

function check(name: string, got: unknown, want: unknown) {
  const ok = isDeepStrictEqual(got, want);
  if (!ok) failures++;
  const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag} ${name}`);
  if (!ok) {
    console.log(`       got : ${JSON.stringify(got)}`);
    console.log(`       want: ${JSON.stringify(want)}`);
  }
}

interface TownshipCarrierVector {
  scenario: string;
  replica: string;
  realmByPubkey: Record<string, string>;
  client: { realm: string; sessionSeed: string; sessionPubkey: string };
  clientDivergedCarrierOps: CarrierOpFrame[];
}

interface InvokeCall {
  command: string;
  args: Record<string, unknown>;
}

console.log(`\n▸ ${vector.scenario} Tauri bridge`);

const sessionIdentity = seededEd25519Identity(vector.client.sessionSeed);
const residentIdentity = seededEd25519Identity(`${vector.client.sessionSeed}:${vector.client.realm}`);
const nativeKeys = new Map([
  ["session", sessionIdentity],
  ["resident", residentIdentity],
]);
const values = new Map<string, string>();
const calls: InvokeCall[] = [];

const invoke: TauriInvoke = async <T = unknown>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> => {
  calls.push({ command, args });

  let result: unknown;
  switch (command) {
    case "lattice_kv_get": {
      result = values.get(String(args.key)) ?? null;
      break;
    }
    case "lattice_kv_set":
      values.set(String(args.key), String(args.value));
      result = null;
      break;
    case "lattice_ensure_carrier_key": {
      const key = nativeKeys.get(String(args.keyId));
      if (!key) throw new Error(`missing native key ${String(args.keyId)}`);
      result = key.publicKeyBase64;
      break;
    }
    case "lattice_sign_carrier": {
      const key = nativeKeys.get(String(args.keyId));
      if (!key) throw new Error(`missing native key ${String(args.keyId)}`);
      result = bytesBase64(key.sign(base64Bytes(String(args.bytes))));
      break;
    }
    default:
      throw new Error(`unexpected command ${command}`);
  }
  return result as T;
};

const challenge = {
  type: "carrier_challenge",
  local_realm: vector.client.realm,
  replica: vector.replica,
  nonce: "fixed-nonce",
  server_nonce: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
  wire_version: 1,
  session_version: 2,
} as const;

const nativeSessionSigner = await createTauriNativeCarrierSigner(invoke, { keyId: "session" });
check("native signer public key", bytesBase64(nativeSessionSigner.publicKey), vector.client.sessionPubkey);
const nativeSigned = await signCarrierChallenge(challenge, nativeSessionSigner);
check("native signer challenge signature", nativeSigned.signature, "Ac2Re1+OPsZQswnGgsJ2+dqxJnr77kFuEhHUsYNVa9a5Puc2Se3mpO/rom/J5qTt9M1fWX+sMHAPhTwHOUk4BA==");
const ensureCall = calls.find((call) => call.command === "lattice_ensure_carrier_key");
check("ensure key command key id", ensureCall?.args.keyId, "session");

const sessionSigner = createTauriCarrierSigner(invoke, {
  keyId: "session",
  publicKey: sessionIdentity.publicKeyBase64,
});
const signed = await signCarrierChallenge(challenge, sessionSigner);
check("async challenge signature", signed.signature, "Ac2Re1+OPsZQswnGgsJ2+dqxJnr77kFuEhHUsYNVa9a5Puc2Se3mpO/rom/J5qTt9M1fWX+sMHAPhTwHOUk4BA==");

const signCall = calls.find((call) => call.command === "lattice_sign_carrier");
check("sign command key id", signCall?.args.keyId, "session");
check(
  "sign command transcript bytes",
  signCall?.args.bytes,
  bytesBase64(carrierTranscriptBytes(challenge, vector.client.realm, sessionIdentity.publicKey)),
);

const keyValue = createTauriKeyValueStore(invoke, { namespace: "township:resident" });
await keyValue.setItem("probe", "value");
check("tauri key-value set", values.get("township:resident:probe"), "value");
check("tauri key-value get", await keyValue.getItem("probe"), "value");

const residentPostFixture = vector.clientDivergedCarrierOps.find(
  (frame) =>
    frame.author === residentIdentity.publicKeyBase64 &&
    frame.body[0] === "tuple" &&
    frame.body[1][0]?.[0] === "atom" &&
    frame.body[1][0][1] === "post",
);
if (!residentPostFixture) throw new Error("missing resident post fixture");

const localOpsBeforePost = carrierOpsToSemanticOps(
  vector.clientDivergedCarrierOps.filter((frame) => frame.id !== residentPostFixture.id),
  vector.realmByPubkey,
);
const localLog = createJsonLocalOpLogStore(keyValue, "ops");
const carrierFrames = createJsonCarrierFrameStore(keyValue, "frames");
await localLog.save(localOpsBeforePost);
await carrierFrames.save(vector.clientDivergedCarrierOps.filter((frame) => frame.id !== residentPostFixture.id));

const residentSigner = createTauriCarrierSigner(invoke, {
  keyId: "resident",
  publicKey: residentIdentity.publicKey,
});
const authored = await authorAndPersistTownshipCommand({
  replica: residentPostFixture.replica,
  command: { command: "post", text: "resident: posted while offline" },
  signer: residentSigner,
  localLog,
  carrierFrames,
  realmByPubkey: vector.realmByPubkey,
});
check("tauri workflow frame", authored.frame, residentPostFixture);
check("tauri workflow local op ids", (await localLog.load()).map((op) => op.id), vector.clientDivergedCarrierOps.map((frame) => frame.id));
check("tauri workflow frame outbox", await carrierFrames.load(), vector.clientDivergedCarrierOps);

console.log(
  `\n${failures === 0 ? "\x1b[32m✓ Tauri bridge checks passed\x1b[0m" : `\x1b[31m✗ ${failures} check(s) failed\x1b[0m`}`,
);
process.exit(failures === 0 ? 0 : 1);

function seededEd25519Identity(seed: string) {
  const privateSeed = createHash("sha256").update(seed).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), privateSeed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyDer = (createPublicKey as (key: unknown) => ReturnType<typeof createPublicKey>)(privateKey).export({
    format: "der",
    type: "spki",
  });
  const publicKey = new Uint8Array(Buffer.from(publicKeyDer).subarray(12));

  return {
    publicKey,
    publicKeyBase64: bytesBase64(publicKey),
    sign(bytes: Uint8Array): Uint8Array {
      return new Uint8Array(edSign(null, Buffer.from(bytes), privateKey));
    },
  };
}

function base64Bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function bytesBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
