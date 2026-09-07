import { ed25519 } from "@noble/curves/ed25519.js";
import { analyzeAuthority } from "./authority";
import { base64ToBytes, carrierOpsToSemanticOps, decodeCarrierOpFrame } from "./carrier";
import type { CommandDecoder, CommandDecoderMap } from "./carrier";
import { verifyCarrierOp } from "./codec";
import { ancestors, canonicalOrder, concurrent } from "./dag";
import { materialize } from "./materialize";
import type { Op } from "./op";
import { frontier } from "./sync";
import { treehouseCommandDecoders, treehouseSpaceSchema } from "./treehouse";
import {
  memberContinuityClaimId,
  memberContinuityCertificateFromDecodedArguments,
  normalizeMemberContinuityCertificate,
  normalizeMemberContinuityClaim,
  verifyMemberContinuityCertificate,
  type MemberContinuityCertificate,
  type MemberContinuityClaim,
} from "./treehouse_member_continuity_codec";

export interface MemberContinuityContext {
  visibleOps: ReadonlyMap<string, Op>;
  verdicts: ReadonlyMap<string, string>;
  validBeacons: readonly Readonly<{opId: string; epoch: number | string}>[];
}

export type MemberContinuityStatus = {ok: true} | {ok: false; reason: string};
export interface MemberContinuityRecord {wrapperId: string; certificate: MemberContinuityCertificate}

export type MemberContinuityObservation =
  | {ok: true; replica: string; verifiedFrontier: string[]; records: Array<{
      claimId: string; claim: MemberContinuityClaim; wrappers: Array<{
        opId: string; author: string; capId: string | null; certificate: MemberContinuityCertificate;
      }>;
    }>; links: Array<{oldPub: string; heads: string[]; status: "unlinked" | "attested" | "contested" | "review_required" | "capacity_stop";
      affectedWrappers: Array<{opId: string; reason: string}>}>; quarantine: Array<{opId: string; reason: string}>}
  | {ok: false; reason: "invalid_verified_history" | "unsupported_continuity_history"};

const allowed: MemberContinuityStatus = {ok: true};
const refuse = (reason: string): MemberContinuityStatus => ({ok: false, reason});

/**
 * The Treehouse.Space application conjunct for one already structurally,
 * capability and holder accepted continuity command. Inputs are judge-produced
 * causal evidence; this function does not authenticate caller-supplied Ops.
 */
export function memberContinuityCommandStatus(
  op: Op,
  visible: ReadonlySet<string>,
  context: MemberContinuityContext,
): MemberContinuityStatus {
  const certificate = certificateFor(op);
  if (certificate === null || certificate.claim.space !== op.replica ||
      !same(certificate.claim.deps, op.deps)) return refuse("application_invalid_continuity");
  const claim = certificate.claim;
  const target = targetStatus(claim, visible, context);
  if (!target.ok) return target;
  if (!eligible(claim, context)) return refuse("application_continuity_ineligible_member");
  if (!epochValid(claim, context.validBeacons)) return refuse("application_continuity_invalid_epoch");
  if (!same(claim.parents, memberContinuityHeads(records(context), claim.oldPub))) {
    return refuse("application_continuity_stale_context");
  }
  return verifyMemberContinuityCertificate(certificate, claim)
    ? allowed : refuse("application_continuity_invalid_certificate");
}

/** Complete deterministic loser map over individually honored operations. */
export function memberContinuityCommandConflicts(
  ops: ReadonlyMap<string, Op>,
  verdicts: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const byId = new Map(ops);
  const ancestorCache = new Map<string, Set<string>>();
  const candidates = canonicalOrder([...ops.values()], byId)
    .map((id) => byId.get(id)!)
    .filter((op) => verdicts.get(op.id) === "honored")
    .map((op) => ({op, certificate: certificateFor(op)}))
    .filter((entry): entry is {op: Op; certificate: MemberContinuityCertificate} => entry.certificate !== null);
  const removals = [...ops.values()].filter((op) => verdicts.get(op.id) === "honored");
  const denied = new Map<string, string>();
  for (const candidate of candidates) {
    const stale = candidate.certificate.claim.vouchers.some((voucher) => removals.some((removal) =>
      removalOf(removal, voucher.member) && concurrent(candidate.op.id, removal.id, byId, ancestorCache) &&
      ancestors(removal.id, byId, ancestorCache).has(voucher.admission)));
    const collision = candidates.some((other) =>
      candidate.certificate.claim.oldPub !== other.certificate.claim.oldPub &&
      candidate.certificate.claim.newPub === other.certificate.claim.newPub &&
      concurrent(candidate.op.id, other.op.id, byId, ancestorCache));
    if (stale) denied.set(candidate.op.id, "application_continuity_stale_voucher");
    else if (collision) denied.set(candidate.op.id, "application_continuity_conflicting_target");
  }
  for (const candidate of candidates) {
    const invalid = candidate.certificate.claim.parents.some((parent) => !candidates.some((wrapper) =>
      memberContinuityClaimId(wrapper.certificate.claim) === parent &&
      wrapper.certificate.claim.oldPub === candidate.certificate.claim.oldPub &&
      ancestors(candidate.op.id, byId, ancestorCache).has(wrapper.op.id) && !denied.has(wrapper.op.id)));
    if (invalid && !denied.has(candidate.op.id)) {
      denied.set(candidate.op.id, "application_continuity_invalid_parent");
    }
  }
  return denied;
}

/** Coalesced unresolved claim heads. Wrapper arrival order never selects one. */
export function memberContinuityHeads(records: readonly MemberContinuityRecord[], oldPub: string): string[] {
  const claims = records.filter((record) => record.certificate.claim.oldPub === oldPub)
    .map((record) => record.certificate.claim);
  const superseded = new Set(claims.flatMap((claim) => claim.parents));
  return [...new Set(claims.map(memberContinuityClaimId).filter((id): id is string => id !== null))]
    .filter((id) => !superseded.has(id)).sort();
}

/**
 * Authenticates a complete raw Space history before invoking the ordinary
 * authority/capability judge and this module's application checks. Semantic
 * Ops are never accepted at this public seam.
 */
export async function observeMemberContinuityFromFrames(input: {
  replica: string; frames: readonly unknown[]; oldPub?: string;
}): Promise<MemberContinuityObservation> {
  const invalid = {ok: false, reason: "invalid_verified_history"} as const;
  try {
    const snapshot = structuredClone(input);
    const frames = snapshot.frames.map(decodeCarrierOpFrame);
    const ids = new Set(frames.map((frame) => frame.id));
    if (ids.size !== frames.length || frames.some((frame) => frame.replica !== snapshot.replica ||
      frame.deps.some((dependency) => !ids.has(dependency)))) return invalid;
    for (const frame of frames) {
      const verified = await verifyCarrierOp(frame, {verify: async (author, bytes, signature) =>
        ed25519.verify(signature, bytes, base64ToBytes(author), {zip215: false})});
      if (!verified.valid) return invalid;
    }
    const ops = carrierOpsToSemanticOps(frames, {}, continuityDecoders());
    const byId = new Map(ops.map((op) => [op.id, op]));
    const order = canonicalOrder(ops, byId);
    if (order.length !== ops.length) return invalid;
    const base = materialize(treehouseSpaceSchema, ops, ids, null, snapshot.replica);
    const authority = analyzeAuthority(treehouseSpaceSchema, ops, ids, order, byId, snapshot.replica);
    const verdicts = new Map(order.map((id) => [id, base.quarantineReasons.get(id) ?? "honored"]));
    const ancestorCache = new Map<string, Set<string>>();
    for (const id of order) {
      const op = byId.get(id)!;
      if (verdicts.get(id) !== "honored" || claimFor(op) === null) continue;
      const visible = ancestors(id, byId, ancestorCache);
      const visibleOps = new Map([...visible].map((target) => [target, byId.get(target)!]));
      const visibleVerdicts = new Map([...visible].map((target) => [target, verdicts.get(target) ?? "honored"]));
      const validBeacons = authority.security.validBeacons.filter((beacon) => visible.has(beacon.opId));
      const status = memberContinuityCommandStatus(op, visible, {visibleOps, verdicts: visibleVerdicts, validBeacons});
      if (!status.ok) verdicts.set(id, status.reason);
    }
    const conflicts = memberContinuityCommandConflicts(byId, verdicts);
    for (const [id, reason] of conflicts) if (verdicts.get(id) === "honored") verdicts.set(id, reason);
    const grouped = new Map<string, {claim: MemberContinuityClaim; wrappers: Array<{
      opId: string; author: string; capId: string | null; certificate: MemberContinuityCertificate;
    }>} >();
    for (const id of order) {
      const op = byId.get(id)!; const certificate = certificateFor(op);
      if (certificate === null || verdicts.get(id) !== "honored") continue;
      const claimId = memberContinuityClaimId(certificate.claim)!;
      const group = grouped.get(claimId) ?? {claim: certificate.claim, wrappers: []};
      group.wrappers.push({opId: id, author: op.authorPubkey ?? op.author, capId: op.cap ?? null, certificate});
      grouped.set(claimId, group);
    }
    const rawRecords: MemberContinuityRecord[] = [...grouped].flatMap(([, group]) =>
      group.wrappers.map((wrapper) => ({wrapperId: wrapper.opId, certificate: wrapper.certificate})));
    const oldKeys = new Set([...grouped.values()].map((group) => group.claim.oldPub));
    if (snapshot.oldPub !== undefined) oldKeys.add(snapshot.oldPub);
    const links = [...oldKeys].sort().map((oldPub) => {
      const heads = memberContinuityHeads(rawRecords, oldPub);
      const affectedWrappers = order.filter((id) => claimFor(byId.get(id)!)?.oldPub === oldPub && verdicts.get(id) !== "honored")
        .map((opId) => ({opId, reason: verdicts.get(opId)!}));
      const reviewRequired = affectedWrappers.some((item) => item.reason === "application_continuity_invalid_parent");
      const status: "unlinked" | "attested" | "contested" | "review_required" | "capacity_stop" =
        heads.length === 0 ? "unlinked" : heads.length > 16 ? "capacity_stop" :
        reviewRequired ? "review_required" : heads.length === 1 ? "attested" : "contested";
      return {oldPub, heads, status, affectedWrappers};
    });
    return {ok: true, replica: snapshot.replica, verifiedFrontier: frontier(ops).sort(),
      records: [...grouped].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([claimId, group]) => ({claimId, claim: group.claim, wrappers: group.wrappers.sort((a, b) => a.opId < b.opId ? -1 : 1)})),
      links, quarantine: order.filter((id) => verdicts.get(id) !== "honored").map((opId) => ({opId, reason: verdicts.get(opId)!}))};
  } catch { return invalid; }
}

function continuityDecoders(): CommandDecoderMap {
  const decoders = new Map(treehouseCommandDecoders("Treehouse.Space"));
  const continuity: CommandDecoder = {arity: 3, decode: (args) => {
    const certificate = normalizeDecodedCertificate(args);
    const marker = {field: "admin_actions", mutation: "write" as const, value: "attest_member_key_v1"};
    return {...marker, command: "attest_member_key_v1", effects: [marker],
      commandArgs: certificate === null ? [null] : [certificate.claim, certificate.possession, certificate.vouches]};
  }};
  decoders.set("attest_member_key_v1", continuity);
  return Object.assign(decoders, {product: "Treehouse.Space"});
}

function normalizeDecodedCertificate(args: unknown[]): MemberContinuityCertificate | null {
  // Kept behind a tiny indirection so the public frame decoder remains the
  // sole raw-term parser for this semantic module.
  return memberContinuityCertificateFromDecodedArguments(args);
}

function targetStatus(claim: MemberContinuityClaim, visible: ReadonlySet<string>, context: MemberContinuityContext): MemberContinuityStatus {
  const admissions: [string, string][] = [[claim.oldAdmission, claim.oldPub],
    ...claim.vouchers.map((voucher) => [voucher.admission, voucher.member] as [string, string])];
  const parentGroups = claim.parents.map((parent) => ({parent, wrappers: [...context.visibleOps.values()].filter((op) => {
    const candidate = claimFor(op); return candidate !== null && memberContinuityClaimId(candidate) === parent;
  })}));
  const ids = [...admissions.map(([id]) => id), ...claim.epochBasis];
  if (ids.some((id) => !visible.has(id)) || parentGroups.some((group) => group.wrappers.length === 0)) {
    return refuse("application_target_not_visible");
  }
  if (ids.some((id) => context.verdicts.get(id) !== "honored") || parentGroups.some((group) =>
    !group.wrappers.some((wrapper) => context.verdicts.get(wrapper.id) === "honored"))) {
    return refuse("application_target_quarantined");
  }
  if (admissions.some(([id, key]) => !admissionOf(context.visibleOps.get(id), claim.space, key)) ||
      claim.epochBasis.some((id) => !beaconOf(context.visibleOps.get(id), claim.space)) ||
      parentGroups.some((group) => !group.wrappers.some((wrapper) => {
        const certificate = certificateFor(wrapper)!;
        return context.verdicts.get(wrapper.id) === "honored" && wrapper.replica === claim.space &&
          certificate.claim.oldPub === claim.oldPub;
      }))) return refuse("application_wrong_target");
  return allowed;
}

function eligible(claim: MemberContinuityClaim, context: MemberContinuityContext): boolean {
  const admitted = [...context.visibleOps.values()].filter((op) => context.verdicts.get(op.id) === "honored" &&
    admissionOf(op, claim.space, claim.oldPub));
  const active = admitted.some((op) => !removed(op.id, claim.oldPub, context));
  const prior = records(context);
  const parentTarget = prior.some((record) => claim.parents.includes(memberContinuityClaimId(record.certificate.claim)!) &&
    record.certificate.claim.oldPub === claim.oldPub && record.certificate.claim.newPub === claim.newPub);
  const used = [...context.visibleOps.values()].some((op) => context.verdicts.get(op.id) === "honored" &&
    admissionOf(op, claim.space, claim.newPub));
  const otherOld = prior.some((record) => record.certificate.claim.oldPub !== claim.oldPub &&
    record.certificate.claim.newPub === claim.newPub);
  return (active ? "active" : "removed") === claim.oldMembership &&
    claim.vouchers.every((voucher) => !removed(voucher.admission, voucher.member, context)) &&
    (!used || parentTarget) && !otherOld;
}

function epochValid(claim: MemberContinuityClaim, beacons: MemberContinuityContext["validBeacons"]): boolean {
  const values = beacons.map((beacon) => typeof beacon.epoch === "number" ? beacon.epoch : Number(beacon.epoch));
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0) || values.length === 0) return false;
  const maximum = Math.max(...values);
  const basis = beacons.filter((_beacon, index) => values[index] === maximum).map((beacon) => beacon.opId).sort();
  return claim.epoch === maximum && same(claim.epochBasis, basis);
}

function removed(tag: string, key: string, context: MemberContinuityContext): boolean {
  const byId = new Map(context.visibleOps);
  return [...context.visibleOps.values()].some((op) => context.verdicts.get(op.id) === "honored" &&
    removalOf(op, key) && ancestors(op.id, byId).has(tag));
}

function admissionOf(op: Op | undefined, replica: string, key: string): boolean {
  return op?.replica === replica && op.kind === "command" && op.command === "admit_member" && op.commandArgs?.[1] === key;
}
function removalOf(op: Op, key: string): boolean {
  return op.kind === "command" && op.command === "remove_member" && op.commandArgs?.[0] === key;
}
function beaconOf(op: Op | undefined, replica: string): boolean {
  return op?.replica === replica && op.kind === "authority" && op.authority?.type === "beacon";
}
function certificateFor(op: Op): MemberContinuityCertificate | null {
  if (op.kind !== "command" || op.command !== "attest_member_key_v1" || op.commandArgs?.length !== 3) return null;
  return normalizeMemberContinuityCertificate({claim: op.commandArgs[0], possession: op.commandArgs[1], vouches: op.commandArgs[2]});
}
function claimFor(op: Op): MemberContinuityClaim | null {
  if (op.kind !== "command" || op.command !== "attest_member_key_v1" || op.commandArgs?.length !== 3) return null;
  return normalizeMemberContinuityClaim(op.commandArgs[0]);
}
function records(context: MemberContinuityContext): MemberContinuityRecord[] {
  const result: MemberContinuityRecord[] = [];
  for (const op of context.visibleOps.values()) {
    if (context.verdicts.get(op.id) !== "honored") continue;
    const certificate = certificateFor(op);
    if (certificate !== null) result.push({wrapperId: op.id, certificate});
  }
  return result;
}
function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
