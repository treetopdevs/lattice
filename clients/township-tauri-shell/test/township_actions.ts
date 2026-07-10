import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  carrierOpsToSemanticOps,
  type CarrierOpFrame,
  type TauriInvoke,
} from "@treetopdevs/lattice-client";
import {
  TOWNSHIP_CARRIER_OUTBOX_KEY,
  TOWNSHIP_DELEGATION_FRAMES_KEY,
  TOWNSHIP_LOCAL_OP_LOG_KEY,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_STORAGE_NAMESPACE,
} from "../src/native_workflow";
import {
  loadTownshipActionAvailability,
  submitTownshipDelegation,
  submitTownshipCommand,
  submitTownshipPost,
  submitTownshipRevocation,
  TOWNSHIP_REALM_BY_PUBKEY,
  TOWNSHIP_REPLICA,
} from "../src/township_actions";
import { assertTownshipKvStoresNoSecrets } from "../src/storage_contract";

interface TownshipCarrierVector {
  replica: string;
  realmByPubkey: Record<string, string>;
  client: { realm: string; sessionSeed: string };
  clientDivergedCarrierOps: CarrierOpFrame[];
  oracleCarrierOps: CarrierOpFrame[];
  authorityRevocation: {
    delegationId: string;
    revokeOp: CarrierOpFrame;
  };
  expectAfterSync: {
    frontier: string[];
  };
}

interface NativeIdentity {
  publicKey: Uint8Array;
  publicKeyBase64: string;
  privateSeedBase64: string;
  privateSeedHex: string;
  sign(bytes: Uint8Array): Uint8Array;
}

console.log("\n▸ Township Vue post action");

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(join(here, "..", "..", "lattice-client", "test", "vectors", "township_carrier_w1.json"), "utf8"),
) as TownshipCarrierVector;
const residentIdentity = seededEd25519Identity(`${vector.client.sessionSeed}:${vector.client.realm}`);
const clerkIdentity = seededEd25519Identity(`${vector.client.sessionSeed}:clerk`);
const postFixture = vector.clientDivergedCarrierOps.find(
  (frame) => frame.author === residentIdentity.publicKeyBase64 && frame.id === "xmret5C7xMai04EQDm1cEX1dDjeBqxPM7-TcDN8cfhI",
);
if (!postFixture) throw new Error("missing resident post fixture");
const summaryFixture = vector.clientDivergedCarrierOps.find(
  (frame) => frame.author === residentIdentity.publicKeyBase64 && frame.id === "05op_edpvoZmeWwBMx-mTAtBcoqIcWdUcb2gIoX3Iy4",
);
if (!summaryFixture) throw new Error("missing resident summary fixture");
const grantFixture = vector.clientDivergedCarrierOps.find((frame) => frameCommandName(frame) === "grant");
if (!grantFixture) throw new Error("missing resident grant fixture");
const genesisFixture = vector.clientDivergedCarrierOps.at(0);
if (!genesisFixture) throw new Error("missing genesis fixture");

assert.equal(TOWNSHIP_REPLICA, vector.replica);
assert.deepEqual(TOWNSHIP_REALM_BY_PUBKEY, vector.realmByPubkey);

const framesBeforePost = vector.clientDivergedCarrierOps.filter((frame) => frame.id !== postFixture.id);
const localOpsBeforePost = carrierOpsToSemanticOps(framesBeforePost, vector.realmByPubkey);
const values = new Map<string, string>([
  [storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY), JSON.stringify(localOpsBeforePost)],
  [storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY), "[]"],
  [storageKey(TOWNSHIP_DELEGATION_FRAMES_KEY), JSON.stringify(framesBeforePost)],
]);
const calls: string[] = [];
const invoke = nativeInvoke(values, residentIdentity, calls);

const submitted = await submitTownshipPost({
  invoke,
  text: "  resident: posted while offline  ",
});

assert.equal(submitted.ok, true);
if (!submitted.ok) throw new Error(submitted.message);
assert.equal(submitted.text, "resident: posted while offline");
assert.equal(submitted.frameId, postFixture.id);
assert.equal(submitted.opId, postFixture.id);
assert.equal(submitted.capId, "gN9aanNVZeHWsS1vU8KxjyqVrWdC0VwPIzilL_QX2n0");
assert.equal(submitted.localOpCount, vector.clientDivergedCarrierOps.length);
assert.equal(submitted.carrierFrameCount, 1);

assert.deepEqual(
  JSON.parse(values.get(storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY)) ?? "[]").map((op: { id: string }) => op.id),
  vector.clientDivergedCarrierOps.map((frame) => frame.id),
);
assert.deepEqual(JSON.parse(values.get(storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY)) ?? "[]"), [postFixture]);
assert.equal(calls.filter((command) => command === "lattice_sign_carrier").length, 1);
assert.equal(calls.at(-1), "lattice_kv_get");

const residentAvailabilityValues = new Map<string, string>([
  [storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY), "[]"],
  [storageKey(TOWNSHIP_DELEGATION_FRAMES_KEY), JSON.stringify(vector.clientDivergedCarrierOps)],
]);
const residentAvailability = await loadTownshipActionAvailability({
  invoke: nativeInvoke(residentAvailabilityValues, residentIdentity, []),
});
assert.equal(residentAvailability.ready, true);
if (!residentAvailability.ready) throw new Error(residentAvailability.message);
assert.equal(residentAvailability.publicKeyBase64, residentIdentity.publicKeyBase64);
assert.deepEqual(allowedCommands(residentAvailability.commands), [
  "admit",
  "post",
  "set_summary",
  "set_title",
]);
assert.equal(residentAvailability.commands.close_matter.allowed, false);
assert.equal(residentAvailability.commands.reopen_matter.allowed, false);
assert.equal(residentAvailability.commands.remove_member.allowed, false);
assert.equal(residentAvailability.commands.post.capId, "gN9aanNVZeHWsS1vU8KxjyqVrWdC0VwPIzilL_QX2n0");

const legacyAvailabilityValues = new Map<string, string>([
  [storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY), JSON.stringify(vector.clientDivergedCarrierOps)],
  [storageKey(TOWNSHIP_DELEGATION_FRAMES_KEY), "[]"],
]);
const legacyAvailability = await loadTownshipActionAvailability({
  invoke: nativeInvoke(legacyAvailabilityValues, residentIdentity, []),
});
assert.equal(legacyAvailability.ready, true);
if (!legacyAvailability.ready) throw new Error(legacyAvailability.message);
assert.deepEqual(allowedCommands(legacyAvailability.commands), [
  "admit",
  "post",
  "set_summary",
  "set_title",
]);
assert.equal(legacyAvailability.commands.post.capId, "gN9aanNVZeHWsS1vU8KxjyqVrWdC0VwPIzilL_QX2n0");

const clerkAvailability = await loadTownshipActionAvailability({
  invoke: nativeInvoke(
    new Map([
      [storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY), "[]"],
      [storageKey(TOWNSHIP_DELEGATION_FRAMES_KEY), JSON.stringify(vector.clientDivergedCarrierOps)],
    ]),
    clerkIdentity,
    [],
  ),
});
assert.equal(clerkAvailability.ready, true);
if (!clerkAvailability.ready) throw new Error(clerkAvailability.message);
assert.deepEqual(allowedCommands(clerkAvailability.commands), [
  "admit",
  "close_matter",
  "post",
  "remove_member",
  "reopen_matter",
  "set_summary",
  "set_title",
]);
assert.equal(clerkAvailability.commands.close_matter.capId, "ZOb-qhDcOoM0yStgMMBlYY_IHIw6eX1BcvFx5hb_Hs8");

const clerkGrantValues = townshipValues([genesisFixture]);
const clerkGrantSubmitted = await submitTownshipDelegation({
  invoke: nativeInvoke(clerkGrantValues, clerkIdentity, []),
  audiencePubkey: residentIdentity.publicKeyBase64,
  ops: ["admit", "post", "set_summary", "set_title"],
});

assert.equal(clerkGrantSubmitted.ok, true);
if (!clerkGrantSubmitted.ok) throw new Error(clerkGrantSubmitted.message);
assert.equal(clerkGrantSubmitted.frameId, grantFixture.id);
assert.equal(clerkGrantSubmitted.opId, grantFixture.id);
assert.equal(clerkGrantSubmitted.delegationId, "gN9aanNVZeHWsS1vU8KxjyqVrWdC0VwPIzilL_QX2n0");
assert.equal(clerkGrantSubmitted.parentId, "ZOb-qhDcOoM0yStgMMBlYY_IHIw6eX1BcvFx5hb_Hs8");
assert.deepEqual(clerkGrantSubmitted.ops, ["admit", "post", "set_summary", "set_title"]);
assert.equal(clerkGrantSubmitted.localOpCount, 2);
assert.equal(clerkGrantSubmitted.carrierFrameCount, 1);
assert.equal(clerkGrantSubmitted.delegationFrameCount, 2);
assert.deepEqual(storedLocalOps(clerkGrantValues).map((op) => op.id), [genesisFixture.id, grantFixture.id]);
assert.deepEqual(storedCarrierFrames(clerkGrantValues), [grantFixture]);
assert.deepEqual(storedDelegationFrames(clerkGrantValues).map((frame) => frame.id), [
  genesisFixture.id,
  grantFixture.id,
]);
assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets(clerkGrantValues, secretNeedles(clerkIdentity, residentIdentity)));

const persistedGrantAvailability = await loadTownshipActionAvailability({
  invoke: nativeInvoke(
    new Map([
      [storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY), "[]"],
      [storageKey(TOWNSHIP_DELEGATION_FRAMES_KEY), JSON.stringify(storedDelegationFrames(clerkGrantValues))],
    ]),
    residentIdentity,
    [],
  ),
});
assert.equal(persistedGrantAvailability.ready, true);
if (!persistedGrantAvailability.ready) throw new Error(persistedGrantAvailability.message);
assert.deepEqual(allowedCommands(persistedGrantAvailability.commands), [
  "admit",
  "post",
  "set_summary",
  "set_title",
]);
assert.equal(persistedGrantAvailability.commands.post.capId, "gN9aanNVZeHWsS1vU8KxjyqVrWdC0VwPIzilL_QX2n0");

assert.deepEqual(vector.authorityRevocation.revokeOp.deps, vector.expectAfterSync.frontier);
const clerkRevokeValues = townshipValues(vector.oracleCarrierOps);
const clerkRevokeCalls: string[] = [];
const clerkRevokeSubmitted = await submitTownshipRevocation({
  invoke: nativeInvoke(clerkRevokeValues, clerkIdentity, clerkRevokeCalls),
  delegationId: vector.authorityRevocation.delegationId,
});

assert.equal(clerkRevokeSubmitted.ok, true);
if (!clerkRevokeSubmitted.ok) throw new Error(clerkRevokeSubmitted.message);
assert.equal(clerkRevokeSubmitted.frameId, vector.authorityRevocation.revokeOp.id);
assert.equal(clerkRevokeSubmitted.opId, vector.authorityRevocation.revokeOp.id);
assert.equal(clerkRevokeSubmitted.delegationId, vector.authorityRevocation.delegationId);
assert.equal(clerkRevokeSubmitted.localOpCount, vector.oracleCarrierOps.length + 1);
assert.equal(clerkRevokeSubmitted.carrierFrameCount, 1);
assert.deepEqual(storedCarrierFrames(clerkRevokeValues), [vector.authorityRevocation.revokeOp]);
assert.deepEqual(storedLocalOps(clerkRevokeValues).map((op) => op.id), [
  ...vector.oracleCarrierOps.map((frame) => frame.id),
  vector.authorityRevocation.revokeOp.id,
]);
assert.deepEqual(
  storedDelegationFrames(clerkRevokeValues).map((frame) => frame.id),
  vector.oracleCarrierOps.map((frame) => frame.id),
);
assert.equal(clerkRevokeCalls.filter((command) => command === "lattice_sign_carrier").length, 1);
assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets(clerkRevokeValues, secretNeedles(clerkIdentity)));

const emptyRevokeCalls: string[] = [];
const emptyRevoke = await submitTownshipRevocation({
  invoke: nativeInvoke(new Map(), clerkIdentity, emptyRevokeCalls),
  delegationId: "   ",
});
assert.equal(emptyRevoke.ok, false);
if (emptyRevoke.ok) throw new Error("empty delegation revoke unexpectedly succeeded");
assert.equal(emptyRevoke.reason, "empty_delegation");
assert.equal(emptyRevokeCalls.length, 0);

const unknownRevokeValues = townshipValues(vector.oracleCarrierOps);
const unknownRevokeCalls: string[] = [];
const unknownRevoke = await submitTownshipRevocation({
  invoke: nativeInvoke(unknownRevokeValues, clerkIdentity, unknownRevokeCalls),
  delegationId: "missing-delegation-id",
});
assert.equal(unknownRevoke.ok, false);
if (unknownRevoke.ok) throw new Error("unknown delegation revoke unexpectedly succeeded");
assert.equal(unknownRevoke.reason, "missing_delegation");
assert.equal(unknownRevokeCalls.filter((command) => command === "lattice_sign_carrier").length, 0);
assert.deepEqual(storedCarrierFrames(unknownRevokeValues), []);
assert.deepEqual(storedLocalOps(unknownRevokeValues).map((op) => op.id), vector.oracleCarrierOps.map((frame) => frame.id));

const residentBadRevokeValues = townshipValues(vector.oracleCarrierOps);
const residentBadRevokeCalls: string[] = [];
const residentBadRevoke = await submitTownshipRevocation({
  invoke: nativeInvoke(residentBadRevokeValues, residentIdentity, residentBadRevokeCalls),
  delegationId: vector.authorityRevocation.delegationId,
});
assert.equal(residentBadRevoke.ok, false);
if (residentBadRevoke.ok) throw new Error("resident bad revoke unexpectedly succeeded");
assert.equal(residentBadRevoke.reason, "not_issuer");
assert.equal(residentBadRevokeCalls.filter((command) => command === "lattice_sign_carrier").length, 0);
assert.deepEqual(storedCarrierFrames(residentBadRevokeValues), []);
assert.deepEqual(storedLocalOps(residentBadRevokeValues).map((op) => op.id), vector.oracleCarrierOps.map((frame) => frame.id));
assert.deepEqual(
  storedDelegationFrames(residentBadRevokeValues).map((frame) => frame.id),
  vector.oracleCarrierOps.map((frame) => frame.id),
);

const emptyGrantAudienceCalls: string[] = [];
const emptyGrantAudience = await submitTownshipDelegation({
  invoke: nativeInvoke(new Map(), clerkIdentity, emptyGrantAudienceCalls),
  audiencePubkey: "   ",
});
assert.equal(emptyGrantAudience.ok, false);
if (emptyGrantAudience.ok) throw new Error("empty-audience grant unexpectedly succeeded");
assert.equal(emptyGrantAudience.reason, "empty_audience");
assert.equal(emptyGrantAudienceCalls.length, 0);

const invalidGrantAudienceCalls: string[] = [];
const invalidGrantAudience = await submitTownshipDelegation({
  invoke: nativeInvoke(new Map(), clerkIdentity, invalidGrantAudienceCalls),
  audiencePubkey: "not base64",
});
assert.equal(invalidGrantAudience.ok, false);
if (invalidGrantAudience.ok) throw new Error("invalid-audience grant unexpectedly succeeded");
assert.equal(invalidGrantAudience.reason, "invalid_audience");
assert.equal(invalidGrantAudienceCalls.length, 0);

const missingGrantParentValues = new Map<string, string>();
const missingGrantParent = await submitTownshipDelegation({
  invoke: nativeInvoke(missingGrantParentValues, clerkIdentity, []),
  audiencePubkey: residentIdentity.publicKeyBase64,
});
assert.equal(missingGrantParent.ok, false);
if (missingGrantParent.ok) throw new Error("missing-parent grant unexpectedly succeeded");
assert.equal(missingGrantParent.reason, "missing_delegation");
assert.match(missingGrantParent.message, /No local delegation/);
assert.deepEqual(storedLocalOps(missingGrantParentValues), []);
assert.deepEqual(storedCarrierFrames(missingGrantParentValues), []);
assert.deepEqual(storedDelegationFrames(missingGrantParentValues), []);

const residentEscalationValues = townshipValues(vector.clientDivergedCarrierOps);
const residentEscalationCalls: string[] = [];
const residentEscalation = await submitTownshipDelegation({
  invoke: nativeInvoke(residentEscalationValues, residentIdentity, residentEscalationCalls),
  audiencePubkey: clerkIdentity.publicKeyBase64,
  ops: ["close_matter"],
  roles: ["clerk"],
});
assert.equal(residentEscalation.ok, false);
if (residentEscalation.ok) throw new Error("resident escalation grant unexpectedly succeeded");
assert.equal(residentEscalation.reason, "missing_delegation");
assert.equal(residentEscalationCalls.filter((command) => command === "lattice_sign_carrier").length, 0);
assert.deepEqual(storedCarrierFrames(residentEscalationValues), []);
assert.deepEqual(
  storedDelegationFrames(residentEscalationValues).map((frame) => frame.id),
  vector.clientDivergedCarrierOps.map((frame) => frame.id),
);
assert.doesNotThrow(() =>
  assertTownshipKvStoresNoSecrets(residentEscalationValues, secretNeedles(residentIdentity, clerkIdentity)),
);

const clerkCloseValues = townshipValues(vector.clientDivergedCarrierOps);
const clerkCloseSubmitted = await submitTownshipCommand({
  invoke: nativeInvoke(clerkCloseValues, clerkIdentity, []),
  command: { command: "close_matter" },
});

assert.equal(clerkCloseSubmitted.ok, true);
if (!clerkCloseSubmitted.ok) throw new Error(clerkCloseSubmitted.message);
assert.deepEqual(clerkCloseSubmitted.command, { command: "close_matter" });
assert.equal(clerkCloseSubmitted.capId, "ZOb-qhDcOoM0yStgMMBlYY_IHIw6eX1BcvFx5hb_Hs8");
assert.equal(clerkCloseSubmitted.localOpCount, vector.clientDivergedCarrierOps.length + 1);
assert.equal(clerkCloseSubmitted.carrierFrameCount, 1);
assert.equal(storedLocalOps(clerkCloseValues).at(-1)?.command, "close_matter");
assert.equal(frameCommandName(storedCarrierFrames(clerkCloseValues).at(-1)), "close_matter");
assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets(clerkCloseValues, secretNeedles(clerkIdentity)));

const clerkReopenValues = townshipValues(vector.clientDivergedCarrierOps);
const clerkReopenSubmitted = await submitTownshipCommand({
  invoke: nativeInvoke(clerkReopenValues, clerkIdentity, []),
  command: { command: "reopen_matter" },
});

assert.equal(clerkReopenSubmitted.ok, true);
if (!clerkReopenSubmitted.ok) throw new Error(clerkReopenSubmitted.message);
assert.deepEqual(clerkReopenSubmitted.command, { command: "reopen_matter" });
assert.equal(clerkReopenSubmitted.capId, "ZOb-qhDcOoM0yStgMMBlYY_IHIw6eX1BcvFx5hb_Hs8");
assert.equal(clerkReopenSubmitted.localOpCount, vector.clientDivergedCarrierOps.length + 1);
assert.equal(clerkReopenSubmitted.carrierFrameCount, 1);
assert.equal(storedLocalOps(clerkReopenValues).at(-1)?.command, "reopen_matter");
assert.equal(frameCommandName(storedCarrierFrames(clerkReopenValues).at(-1)), "reopen_matter");

const residentAdmitValues = townshipValues(vector.clientDivergedCarrierOps);
const residentAdmitSubmitted = await submitTownshipCommand({
  invoke: nativeInvoke(residentAdmitValues, residentIdentity, []),
  command: { command: "admit", member: "neighbor" },
});

assert.equal(residentAdmitSubmitted.ok, true);
if (!residentAdmitSubmitted.ok) throw new Error(residentAdmitSubmitted.message);
assert.deepEqual(residentAdmitSubmitted.command, { command: "admit", member: "neighbor" });
assert.equal(residentAdmitSubmitted.capId, "gN9aanNVZeHWsS1vU8KxjyqVrWdC0VwPIzilL_QX2n0");
assert.equal(residentAdmitSubmitted.localOpCount, vector.clientDivergedCarrierOps.length + 1);
assert.equal(residentAdmitSubmitted.carrierFrameCount, 1);
assert.equal(storedLocalOps(residentAdmitValues).at(-1)?.command, "admit");
assert.equal(frameCommandName(storedCarrierFrames(residentAdmitValues).at(-1)), "admit");

const clerkRemoveValues = townshipValues(vector.clientDivergedCarrierOps);
const clerkRemoveSubmitted = await submitTownshipCommand({
  invoke: nativeInvoke(clerkRemoveValues, clerkIdentity, []),
  command: { command: "remove_member", member: "resident" },
});

assert.equal(clerkRemoveSubmitted.ok, true);
if (!clerkRemoveSubmitted.ok) throw new Error(clerkRemoveSubmitted.message);
assert.deepEqual(clerkRemoveSubmitted.command, { command: "remove_member", member: "resident" });
assert.equal(clerkRemoveSubmitted.capId, "ZOb-qhDcOoM0yStgMMBlYY_IHIw6eX1BcvFx5hb_Hs8");
assert.equal(clerkRemoveSubmitted.localOpCount, vector.clientDivergedCarrierOps.length + 1);
assert.equal(clerkRemoveSubmitted.carrierFrameCount, 1);
assert.equal(storedLocalOps(clerkRemoveValues).at(-1)?.command, "remove_member");
assert.equal(frameCommandName(storedCarrierFrames(clerkRemoveValues).at(-1)), "remove_member");

const availabilityNativeUnavailable = await loadTownshipActionAvailability({
  async invoke(command: string): Promise<never> {
    throw new Error(`no native runtime for ${command}`);
  },
});
assert.equal(availabilityNativeUnavailable.ready, false);
if (availabilityNativeUnavailable.ready) throw new Error("availability unexpectedly ready");
assert.equal(availabilityNativeUnavailable.reason, "native_unavailable");

const framesBeforeSummary = vector.clientDivergedCarrierOps.filter(
  (frame) => frame.id !== summaryFixture.id && frame.id !== postFixture.id,
);
const summaryValues = new Map<string, string>([
  [storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY), JSON.stringify(carrierOpsToSemanticOps(framesBeforeSummary, vector.realmByPubkey))],
  [storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY), "[]"],
  [storageKey(TOWNSHIP_DELEGATION_FRAMES_KEY), JSON.stringify(framesBeforeSummary)],
]);
const summarySubmitted = await submitTownshipCommand({
  invoke: nativeInvoke(summaryValues, residentIdentity, []),
  command: { command: "set_summary", text: "  Needs traffic study  " },
});

assert.equal(summarySubmitted.ok, true);
if (!summarySubmitted.ok) throw new Error(summarySubmitted.message);
assert.deepEqual(summarySubmitted.command, { command: "set_summary", text: "Needs traffic study" });
assert.equal(summarySubmitted.frameId, summaryFixture.id);
assert.equal(summarySubmitted.opId, summaryFixture.id);
assert.equal(summarySubmitted.capId, "gN9aanNVZeHWsS1vU8KxjyqVrWdC0VwPIzilL_QX2n0");
assert.deepEqual(
  JSON.parse(summaryValues.get(storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY)) ?? "[]").map((op: { id: string }) => op.id),
  [...framesBeforeSummary.map((frame) => frame.id), summaryFixture.id],
);
assert.deepEqual(JSON.parse(summaryValues.get(storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY)) ?? "[]"), [summaryFixture]);

const legacySummaryValues = new Map<string, string>([
  [storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY), JSON.stringify(carrierOpsToSemanticOps(framesBeforeSummary, vector.realmByPubkey))],
  [storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY), JSON.stringify(framesBeforeSummary)],
  [storageKey(TOWNSHIP_DELEGATION_FRAMES_KEY), "[]"],
]);
const legacySummarySubmitted = await submitTownshipCommand({
  invoke: nativeInvoke(legacySummaryValues, residentIdentity, []),
  command: { command: "set_summary", text: "  Needs traffic study  " },
});

assert.equal(legacySummarySubmitted.ok, true);
if (!legacySummarySubmitted.ok) throw new Error(legacySummarySubmitted.message);
assert.equal(legacySummarySubmitted.frameId, summaryFixture.id);
assert.deepEqual(
  storedCarrierFrames(legacySummaryValues).map((frame) => frame.id),
  [...framesBeforeSummary.map((frame) => frame.id), summaryFixture.id],
);

const missingCapValues = new Map<string, string>([
  [storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY), "[]"],
  [storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY), "[]"],
  [storageKey(TOWNSHIP_DELEGATION_FRAMES_KEY), "[]"],
]);
const missingCap = await submitTownshipCommand({
  invoke: nativeInvoke(missingCapValues, residentIdentity, []),
  command: { command: "close_matter" },
});

assert.equal(missingCap.ok, false);
if (missingCap.ok) throw new Error("missing-cap command unexpectedly succeeded");
assert.equal(missingCap.reason, "missing_delegation");
assert.equal(missingCap.commandName, "close_matter");
assert.match(missingCap.message, /No local delegation/);

const emptySummary = await submitTownshipCommand({
  invoke: nativeInvoke(new Map(), residentIdentity, []),
  command: { command: "set_summary", text: "   " },
});

assert.equal(emptySummary.ok, false);
if (emptySummary.ok) throw new Error("empty summary unexpectedly succeeded");
assert.equal(emptySummary.reason, "empty_text");
assert.equal(emptySummary.commandName, "set_summary");

const emptyMember = await submitTownshipCommand({
  invoke: nativeInvoke(new Map(), residentIdentity, []),
  command: { command: "admit", member: "   " },
});

assert.equal(emptyMember.ok, false);
if (emptyMember.ok) throw new Error("empty member unexpectedly succeeded");
assert.equal(emptyMember.reason, "empty_member");
assert.equal(emptyMember.commandName, "admit");

const empty = await submitTownshipPost({
  invoke: nativeInvoke(new Map(), residentIdentity, []),
  text: "   ",
});

assert.equal(empty.ok, false);
if (empty.ok) throw new Error("empty post unexpectedly succeeded");
assert.equal(empty.reason, "empty_post");

const nativeUnavailable = await submitTownshipPost({
  async invoke(command: string): Promise<never> {
    throw new Error(`no native runtime for ${command}`);
  },
  text: "resident: from browser",
});

assert.equal(nativeUnavailable.ok, false);
if (nativeUnavailable.ok) throw new Error("native-unavailable post unexpectedly succeeded");
assert.equal(nativeUnavailable.reason, "native_unavailable");
assert.equal(nativeUnavailable.message, "Open in the Tauri shell to sign and save local posts.");

console.log("\x1b[32m✓ Township post action checks passed\x1b[0m");

function storageKey(key: string): string {
  return `${TOWNSHIP_STORAGE_NAMESPACE}:${key}`;
}

function townshipValues(frames: CarrierOpFrame[]): Map<string, string> {
  return new Map([
    [storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY), JSON.stringify(carrierOpsToSemanticOps(frames, vector.realmByPubkey))],
    [storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY), "[]"],
    [storageKey(TOWNSHIP_DELEGATION_FRAMES_KEY), JSON.stringify(frames)],
  ]);
}

function storedLocalOps(values: Map<string, string>): Array<{ id: string; command?: string }> {
  return JSON.parse(values.get(storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY)) ?? "[]");
}

function storedCarrierFrames(values: Map<string, string>): CarrierOpFrame[] {
  return JSON.parse(values.get(storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY)) ?? "[]");
}

function storedDelegationFrames(values: Map<string, string>): CarrierOpFrame[] {
  return JSON.parse(values.get(storageKey(TOWNSHIP_DELEGATION_FRAMES_KEY)) ?? "[]");
}

function frameCommandName(frame: CarrierOpFrame | undefined): string | undefined {
  const body = frame?.body;
  return body?.[0] === "tuple" && body[1][0]?.[0] === "atom" ? body[1][0][1] : undefined;
}

function allowedCommands(commands: Record<string, { allowed: boolean }>): string[] {
  return Object.entries(commands)
    .filter(([, command]) => command.allowed)
    .map(([command]) => command)
    .sort();
}

function secretNeedles(...identities: NativeIdentity[]): string[] {
  return identities.flatMap((identity) => [identity.privateSeedBase64, identity.privateSeedHex]);
}

function nativeInvoke(
  values: Map<string, string>,
  identity: NativeIdentity,
  calls: string[],
): TauriInvoke {
  return async <T = unknown>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> => {
    calls.push(command);

    let result: unknown;
    switch (command) {
      case "lattice_ensure_carrier_key":
        assert.equal(args.keyId, TOWNSHIP_NATIVE_KEY_ID);
        result = identity.publicKeyBase64;
        break;
      case "lattice_kv_get":
        result = values.get(String(args.key)) ?? null;
        break;
      case "lattice_kv_set":
        values.set(String(args.key), String(args.value));
        result = null;
        break;
      case "lattice_sign_carrier":
        assert.equal(args.keyId, TOWNSHIP_NATIVE_KEY_ID);
        result = bytesBase64(identity.sign(base64Bytes(String(args.bytes))));
        break;
      default:
        throw new Error(`unexpected command ${command}`);
    }

    return result as T;
  };
}

function seededEd25519Identity(seed: string): NativeIdentity {
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
    privateSeedBase64: bytesBase64(privateSeed),
    privateSeedHex: privateSeed.toString("hex"),
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
