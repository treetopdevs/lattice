import { readFileSync, readdirSync } from "node:fs";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalBytesForCarrierOp,
  canonicalHash,
  verifyCarrierOp,
} from "../src/index";
import type { CarrierDelegation, CarrierOpFrame, CarrierTerm } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const vectorDirectory = join(here, "vectors");
const carrierVectors = readdirSync(vectorDirectory)
  .filter((filename) => filename.endsWith(".json"))
  .map((filename) => JSON.parse(readFileSync(join(vectorDirectory, filename), "utf8")) as unknown)
  .filter(isCarrierVector);
const canonicalVectors = carrierVectors.filter(isCanonicalVector);
const vector = canonicalVectors.find(({ scenario }) => scenario === "township_carrier_w1");
const leaseVector = canonicalVectors.find(
  ({ scenario }) => scenario === "township_lease_valid_causal",
);

let failures = 0;

function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag} ${name}`);
  if (!ok) {
    console.log(`       got : ${JSON.stringify(got)}`);
    console.log(`       want: ${JSON.stringify(want)}`);
  }
}

interface CarrierVector {
  scenario: string;
  oracleCarrierOps: CarrierOpFrame[];
  canonicalOps?: CanonicalEntry[];
}

interface CanonicalVector extends CarrierVector {
  canonicalOps: CanonicalEntry[];
}

interface CanonicalEntry {
  id: string;
  suite: "lattice-cbor-v1";
  bytesHex: string;
  hash: string;
}

const verifier = { verify: verifyEd25519 };

for (const carrierVector of carrierVectors) {
  const carriesLease = carrierVector.oracleCarrierOps.some(
    (frame) => containsEmbeddedLease(frame.body) || containsEmbeddedLease(frame.cap),
  );

  if (carriesLease && !isCanonicalVector(carrierVector)) {
    failures++;
    console.log(
      `  \x1b[31mFAIL\x1b[0m leased vector ${carrierVector.scenario} has no canonical byte oracle`,
    );
  }
}

for (const canonicalVector of canonicalVectors) {
  console.log(`\n▸ ${canonicalVector.scenario} canonical op bytes`);

  const expectedById = new Map(canonicalVector.canonicalOps.map((entry) => [entry.id, entry]));

  check(
    "canonical vector covers every carrier op",
    expectedById.size,
    canonicalVector.oracleCarrierOps.length,
  );

  for (const frame of canonicalVector.oracleCarrierOps) {
    const expected = expectedById.get(frame.id);
    if (!expected) {
      failures++;
      console.log(`  \x1b[31mFAIL\x1b[0m missing canonical bytes for ${frame.id}`);
      continue;
    }

    const bytes = canonicalBytesForCarrierOp(frame);
    check(`${frame.id}.suite`, expected.suite, "lattice-cbor-v1");
    check(`${frame.id}.bytes`, bytesToHex(bytes), expected.bytesHex);
    check(`${frame.id}.hash`, await canonicalHash(bytes), expected.hash);
    check(`${frame.id}.signature`, await verifyCarrierOp(frame, verifier), {
      hash: true,
      signature: true,
      valid: true,
    });
  }
}

if (!vector) {
  failures++;
  console.log("  \x1b[31mFAIL\x1b[0m township_carrier_w1 canonical vector is missing");
} else {
  const [firstFrame] = vector.oracleCarrierOps;
  if (!firstFrame) {
    failures++;
    console.log("  \x1b[31mFAIL\x1b[0m township_carrier_w1 has no negative-control frame");
  } else {
    const duplicateMap: CarrierTerm = [
      "map",
      [
        [
          ["atom", "duplicate"],
          ["int", 1],
        ],
        [
          ["atom", "duplicate"],
          ["int", 2],
        ],
      ],
    ];
    const duplicateMapset: CarrierTerm = [
      "mapset",
      [
        ["atom", "duplicate"],
        ["atom", "duplicate"],
      ],
    ];
    const delegation: CarrierDelegation = {
      id: "delegation-id",
      replica: firstFrame.replica,
      issuer: firstFrame.author,
      audience: firstFrame.author,
      parent_id: null,
      ops: [],
      roles: [],
      live: true,
      sig: firstFrame.sig,
    };
    const permissiveVerifier = { verify: async () => true };

    await checkThrows(
      "duplicate canonical map key is rejected",
      () => canonicalBytesForCarrierOp({ ...firstFrame, body: duplicateMap }),
      "duplicate canonical map key",
    );
    await checkThrows(
      "duplicate canonical mapset element is rejected",
      () => canonicalBytesForCarrierOp({ ...firstFrame, body: duplicateMapset }),
      "duplicate canonical mapset element",
    );
    await checkThrows("unpadded base64 author is rejected", () =>
      verifyCarrierOp(
        { ...firstFrame, author: withoutPadding(firstFrame.author) },
        permissiveVerifier,
      ),
    );
    await checkThrows("base64 author with trailing newline is rejected", () =>
      verifyCarrierOp({ ...firstFrame, author: `${firstFrame.author}\n` }, permissiveVerifier),
    );
    await checkThrows("base64 author with out-of-alphabet character is rejected", () =>
      verifyCarrierOp(
        { ...firstFrame, author: withOutOfAlphabetCharacter(firstFrame.author) },
        permissiveVerifier,
      ),
    );
    await checkThrows("non-canonical base64 frame signature is rejected", () =>
      verifyCarrierOp({ ...firstFrame, sig: withoutPadding(firstFrame.sig) }, permissiveVerifier),
    );
    await checkThrows("non-canonical base64 delegation issuer is rejected", () =>
      canonicalBytesForCarrierOp({
        ...firstFrame,
        body: [
          "delegation",
          { ...delegation, issuer: withoutPadding(delegation.issuer) },
        ],
      }),
    );
    await checkThrows("non-canonical base64 delegation audience is rejected", () =>
      canonicalBytesForCarrierOp({
        ...firstFrame,
        body: [
          "delegation",
          { ...delegation, audience: `${delegation.audience}\n` },
        ],
      }),
    );
    await checkThrows("non-canonical base64 delegation signature is rejected", () =>
      canonicalBytesForCarrierOp({
        ...firstFrame,
        body: [
          "delegation",
          { ...delegation, sig: withOutOfAlphabetCharacter(delegation.sig) },
        ],
      }),
    );
    await checkThrows("non-canonical base64 bin term is rejected", () =>
      canonicalBytesForCarrierOp({
        ...firstFrame,
        body: ["bin", withoutPadding(firstFrame.author)],
      }),
    );

    for (const length of [31, 33]) {
      const wrongLengthKey = Buffer.alloc(length, 1).toString("base64");
      await checkThrows(`canonical base64 author of ${length} bytes is rejected`, () =>
        canonicalBytesForCarrierOp({ ...firstFrame, author: wrongLengthKey }),
      );
      for (const field of ["issuer", "audience"] as const) {
        await checkThrows(`canonical base64 delegation ${field} of ${length} bytes is rejected`, () =>
          canonicalBytesForCarrierOp({
            ...firstFrame,
            body: ["delegation", { ...delegation, [field]: wrongLengthKey }],
          }),
        );
      }
    }
    for (const length of [63, 65]) {
      const wrongLengthSignature = Buffer.alloc(length, 1).toString("base64");
      await checkThrows(`canonical base64 frame signature of ${length} bytes is rejected`, () =>
        verifyCarrierOp({ ...firstFrame, sig: wrongLengthSignature }, permissiveVerifier),
      );
      await checkThrows(`canonical base64 delegation signature of ${length} bytes is rejected`, () =>
        canonicalBytesForCarrierOp({
          ...firstFrame,
          body: ["delegation", { ...delegation, sig: wrongLengthSignature }],
        }),
      );
    }

    check(
      "canonical base64 frame preserves op id and verification",
      {
        id: await canonicalHash(canonicalBytesForCarrierOp(firstFrame)),
        verification: await verifyCarrierOp(firstFrame, verifier),
      },
      {
        id: firstFrame.id,
        verification: { hash: true, signature: true, valid: true },
      },
    );

    const largeBinaryFrame: CarrierOpFrame = {
      ...firstFrame,
      body: ["bin", Buffer.alloc(256 * 1024, 0xa5).toString("base64")],
    };
    const nodeLargeBinaryBytes = bytesToHex(canonicalBytesForCarrierOp(largeBinaryFrame));
    const bufferDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
    if (!bufferDescriptor) throw new Error("missing Node Buffer descriptor");
    let browserLargeBinaryBytes = "";
    let browserBase64Failure = "";
    try {
      Reflect.deleteProperty(globalThis, "Buffer");
      browserLargeBinaryBytes = bytesToHex(canonicalBytesForCarrierOp(largeBinaryFrame));
    } catch (error) {
      browserBase64Failure = error instanceof Error ? error.message : String(error);
    } finally {
      Object.defineProperty(globalThis, "Buffer", bufferDescriptor);
    }
    check(
      "browser base64 preserves canonical bytes for a 256 KiB binary term",
      { failure: browserBase64Failure, parity: browserLargeBinaryBytes === nodeLargeBinaryBytes },
      { failure: "", parity: true },
    );

    check(
      "tampered signature fails verification",
      await verifyCarrierOp({ ...firstFrame, sig: tamperBase64(firstFrame.sig) }, verifier),
      { hash: true, signature: false, valid: false },
    );

    check(
      "tampered body fails verification",
      await verifyCarrierOp(
        {
          ...firstFrame,
          body: ["tuple", [["atom", "post"], ["list", [["bin", "dGFtcGVyZWQ="]]]]],
        },
        verifier,
      ),
      { hash: false, signature: false, valid: false },
    );
  }
}

const leasedFrame = leaseVector?.oracleCarrierOps.find((frame) => containsEmbeddedLease(frame.body));
if (!leasedFrame) {
  failures++;
  console.log("  \x1b[31mFAIL\x1b[0m lease vector has no embedded leased delegation");
} else {
  const tamperedLease = { ...leasedFrame, body: mutateEmbeddedLease(leasedFrame.body, 99) };
  check(
    "mutating a body-embedded delegation lease changes canonical op bytes",
    bytesToHex(canonicalBytesForCarrierOp(tamperedLease)) !==
      bytesToHex(canonicalBytesForCarrierOp(leasedFrame)),
    true,
  );

  const capOnlyLease = { ...leasedFrame, body: ["nil"] as CarrierTerm, cap: leasedFrame.body };
  const tamperedCapLease = {
    ...capOnlyLease,
    cap: mutateEmbeddedLease(capOnlyLease.cap, 99),
  };
  check(
    "mutating a cap-embedded delegation lease changes canonical op bytes",
    bytesToHex(canonicalBytesForCarrierOp(tamperedCapLease)) !==
      bytesToHex(canonicalBytesForCarrierOp(capOnlyLease)),
    true,
  );
}

console.log(
  `\n${failures === 0 ? "\x1b[32m✓ canonical checks passed\x1b[0m" : `\x1b[31m✗ ${failures} check(s) failed\x1b[0m`}`,
);
process.exit(failures === 0 ? 0 : 1);

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function tamperBase64(encoded: string): string {
  const bytes = Buffer.from(encoded, "base64");
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  return bytes.toString("base64");
}

async function checkThrows(
  name: string,
  action: () => unknown | Promise<unknown>,
  expectedMessage?: string,
) {
  try {
    await action();
    check(name, "accepted", "rejected");
  } catch (error) {
    if (expectedMessage === undefined) {
      check(name, "rejected", "rejected");
    } else {
      check(name, error instanceof Error ? error.message : error, expectedMessage);
    }
  }
}

function withoutPadding(value: string): string {
  return value.replace(/=+$/, "");
}

function withOutOfAlphabetCharacter(value: string): string {
  const paddingOffset = value.indexOf("=");
  const offset = paddingOffset === -1 ? value.length : paddingOffset;
  return `${value.slice(0, offset)}!${value.slice(offset)}`;
}

function isCarrierVector(value: unknown): value is CarrierVector {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Record<string, unknown>;
  return typeof candidate.scenario === "string" && Array.isArray(candidate.oracleCarrierOps);
}

function isCanonicalVector(value: CarrierVector): value is CanonicalVector {
  return Array.isArray(value.canonicalOps);
}

function containsEmbeddedLease(term: CarrierTerm): boolean {
  switch (term[0]) {
    case "delegation":
      return term[1].expires_epoch !== undefined && term[1].expires_epoch !== null;
    case "list":
    case "tuple":
    case "mapset":
      return term[1].some(containsEmbeddedLease);
    case "map":
      return term[1].some(
        ([key, value]) => containsEmbeddedLease(key) || containsEmbeddedLease(value),
      );
    case "nil":
    case "bool":
    case "int":
    case "bin":
    case "atom":
      return false;
  }
}

function mutateEmbeddedLease(term: CarrierTerm, expiresEpoch: number): CarrierTerm {
  switch (term[0]) {
    case "delegation":
      return term[1].expires_epoch === undefined || term[1].expires_epoch === null
        ? term
        : ["delegation", { ...term[1], expires_epoch: expiresEpoch }];
    case "list":
      return ["list", term[1].map((item) => mutateEmbeddedLease(item, expiresEpoch))];
    case "tuple":
      return ["tuple", term[1].map((item) => mutateEmbeddedLease(item, expiresEpoch))];
    case "mapset":
      return ["mapset", term[1].map((item) => mutateEmbeddedLease(item, expiresEpoch))];
    case "map":
      return [
        "map",
        term[1].map(([key, value]) => [
          mutateEmbeddedLease(key, expiresEpoch),
          mutateEmbeddedLease(value, expiresEpoch),
        ]),
      ];
    case "nil":
    case "bool":
    case "int":
    case "bin":
    case "atom":
      return term;
  }
}

async function verifyEd25519(author: string, bytes: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const publicKey = createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(author, "base64")]),
    format: "der",
    type: "spki",
  });

  return edVerify(null, Buffer.from(bytes), publicKey, Buffer.from(signature));
}
