import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalBase64Bytes, canonicalBytesForCarrierOp, canonicalBytesForCarrierTerm, canonicalHash } from "./codec";
import type { CarrierOpFrame, CarrierTerm } from "./carrier";
import { compareUtf8 } from "./op";

export interface TreehouseCutoffOp { id: string; bytes: Uint8Array; sig: Uint8Array; }
export interface TreehouseCutoffRejectedOp extends TreehouseCutoffOp { reason: "bad_signature"; }
export type TreehouseCatalogCutoffResult =
  | { ok: true; cutoff: { replica: string; frontier: string[]; logDigest: string }; canonicalBytes: Uint8Array;
      ops: TreehouseCutoffOp[]; rejected: TreehouseCutoffRejectedOp[] }
  | { ok: false; reason: "invalid_verified_history" | "unsupported_cutoff" };
export interface TreehouseCatalogCutoffInput {
  replica: string; frames: readonly unknown[];
  rejected: readonly { frame: unknown; reason: "bad_signature" }[];
}

// Cutoff-only vocabulary adopted 2026-09-06; identical to the BEAM observation.
// Unknown evidence stays retained and refuses portability; it gains no semantics.
const atoms = new Set([
  "__beacon__",
  "__continuation__",
  "accept",
  "active",
  "admin",
  "admin_actions",
  "admission",
  "admit_member",
  "archive_thread",
  "archived",
  "attest_member_key_v1",
  "audience",
  "author",
  "author_edit",
  "author_tombstone",
  "authority",
  "bad_signature",
  "beacon",
  "binding",
  "bootstrap",
  "bounded_continuation",
  "bounded_space_admin_v1",
  "bytes",
  "cap",
  "catalog",
  "catalog_bootstrap_v1",
  "catalog_key",
  "claim",
  "command",
  "consent",
  "continuation_v1",
  "create_space",
  "create_thread",
  "creation",
  "cutoffs",
  "delegation_id",
  "deps",
  "dormant_ticks",
  "entries",
  "epoch",
  "epoch_basis",
  "expires_epoch",
  "frontier",
  "generation",
  "genesis",
  "grant",
  "heartbeat",
  "holder",
  "holder_epoch",
  "id",
  "inbox",
  "inventory_digest",
  "invitations",
  "issue_invitation",
  "issuer",
  "kind",
  "live",
  "log_digest",
  "max_epoch_step",
  "max_lease_epochs",
  "member",
  "members",
  "membership_events",
  "mode",
  "moderation",
  "moderator",
  "moderator_actions",
  "moderator_tombstone",
  "name",
  "new_catalog_key",
  "new_origin",
  "new_pub",
  "new_service_id",
  "new_service_key",
  "new_signature",
  "nominee",
  "nonce",
  "old_admission",
  "old_membership",
  "old_pub",
  "old_signature",
  "ops",
  "origin",
  "parent",
  "parent_id",
  "parents",
  "policy_id",
  "post",
  "posts",
  "previous",
  "prior_catalog",
  "prior_catalogs",
  "product",
  "profile_genesis",
  "profile_id",
  "reason",
  "recovery",
  "reference",
  "reject",
  "remove_member",
  "removed",
  "replace_catalog_v1",
  "replacement_rule",
  "replica",
  "request",
  "revision",
  "revoke",
  "revoke_invitation",
  "revoked_invitations",
  "role",
  "roles",
  "root",
  "rotation",
  "route",
  "schema",
  "service",
  "service_id",
  "service_key",
  "sig",
  "signature",
  "signatures",
  "space",
  "space_root",
  "succeed",
  "successor",
  "thread",
  "threads",
  "threshold",
  "title",
  "tombstone",
  "transfer",
  "treehouse",
  "treehouse_space_v1",
  "treehouse_thread_v1",
  "version",
  "vouchers",
  "witness",
  "witnessed",
  "witnesses"
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const maxUint64 = 18_446_744_073_709_551_615n;
const frameFields = ["v", "id", "replica", "author", "deps", "kind", "body", "cap", "sig"];
const delegationFields = ["id", "replica", "issuer", "audience", "parent_id", "ops", "roles", "live", "sig"];
const invalid = { ok: false, reason: "invalid_verified_history" } as const;
const unsupported = { ok: false, reason: "unsupported_cutoff" } as const;
class UnsupportedCutoff extends Error {}

/**
 * Exact raw observation of one caller-supplied complete retained snapshot.
 * Does not decode application terms, establish authority, discover withheld
 * history, persist evidence or replace the caller's store/session serialization.
 */
export async function deriveTreehouseCatalogCutoff(input: TreehouseCatalogCutoffInput): Promise<TreehouseCatalogCutoffResult> {
  try {
    const snapshot = structuredClone(input);
    if (!text(snapshot.replica, true) || !Array.isArray(snapshot.frames) || !Array.isArray(snapshot.rejected)) return invalid;
    const acceptedIds = new Set<string>(), rejectedIds = new Set<string>();
    for (const frame of snapshot.frames) {
      if (!header(frame, snapshot.replica) || acceptedIds.has(frame.id)) return invalid;
      acceptedIds.add(frame.id);
    }
    for (const entry of snapshot.rejected) {
      if (!closed(entry, ["frame", "reason"]) || entry.reason !== "bad_signature" ||
        !object(entry.frame) || !text(entry.frame.id) || entry.frame.replica !== snapshot.replica || rejectedIds.has(entry.frame.id)) return invalid;
      rejectedIds.add(entry.frame.id);
    }
    if (snapshot.frames.some((frame) => (frame as CarrierOpFrame).deps.some((dep) => !acceptedIds.has(dep)))) return invalid;
    const ops: TreehouseCutoffOp[] = [], rejected: TreehouseCutoffRejectedOp[] = [];
    let outsideGrammar = false;
    for (const [frames, accepted] of [[snapshot.frames, true], [snapshot.rejected.map((entry) => entry.frame), false]] as const) {
      for (const raw of frames) {
        const checked = await inspectFrame(raw, snapshot.replica, accepted);
        if (checked === "invalid") return invalid;
        if (checked === "unsupported") { outsideGrammar = true; continue; }
        if (!checked.portable) outsideGrammar = true;
        if (accepted) ops.push(checked.record);
        else rejected.push({ ...checked.record, reason: "bad_signature" });
      }
    }
    if (outsideGrammar) return unsupported;
    ops.sort((a, b) => compareUtf8(a.id, b.id));
    rejected.sort((a, b) => compareUtf8(a.id, b.id));
    const referenced = new Set(snapshot.frames.flatMap((frame) => (frame as CarrierOpFrame).deps));
    const frontier = [...acceptedIds].filter((id) => !referenced.has(id)).sort(compareUtf8);
    const bytes = canonicalBytesForCarrierTerm(["list", [binary("lattice-treehouse-recovery-cutoff-v1"), binary(snapshot.replica),
      ["list", ops.map((op) => recordTerm(op))], ["list", rejected.map((op) => recordTerm(op, true))]]]);
    return { ok: true, cutoff: { replica: snapshot.replica, frontier, logDigest: await canonicalHash(bytes) }, canonicalBytes: bytes, ops, rejected };
  } catch { return invalid; }
}

async function inspectFrame(raw: unknown, replica: string, accepted: boolean): Promise<
  "invalid" | "unsupported" | { portable: boolean; record: TreehouseCutoffOp }
> {
  if (!header(raw, replica)) return accepted ? "invalid" : "unsupported";
  const author = canonicalBase64Bytes(raw.author), sig = canonicalBase64Bytes(raw.sig);
  if (author === null || sig === null) return accepted ? "invalid" : "unsupported";
  if (author.length !== 32) return accepted ? "invalid" : "unsupported";
  let portable: boolean;
  try { const body = term(raw.body, 64), cap = term(raw.cap, 64); portable = body && cap; }
  catch (error) { return error instanceof UnsupportedCutoff ? "unsupported" : accepted ? "invalid" : "unsupported"; }
  let bytes: Uint8Array;
  try { bytes = canonicalBytesForCarrierOp(raw); }
  catch { return accepted ? "invalid" : "unsupported"; }
  const hashMatches = await canonicalHash(bytes) === raw.id;
  let signatureMatches = false;
  try { signatureMatches = sig.length === 64 && ed25519.verify(sig, bytes, author, { zip215: false }); } catch { /* invalid signature is retained evidence */ }
  if ((hashMatches && signatureMatches) !== accepted) return "invalid";
  // Check representable authenticity before a portability refusal can hide it.
  portable = portable && ["command", "authority", "inbox", "tombstone"].includes(raw.kind) &&
    encoder.encode(JSON.stringify({ type: "push", ops: [raw] })).length <= 64_000;
  return { portable, record: { id: raw.id, bytes, sig } };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function closed(value: unknown, fields: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return object(value) && fields.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => fields.includes(key) || optional.includes(key));
}
function text(value: unknown, nonempty = false): value is string {
  return typeof value === "string" && (!nonempty || value.length > 0) && decoder.decode(encoder.encode(value)) === value;
}
function header(value: unknown, replica: string): value is CarrierOpFrame {
  return closed(value, frameFields) && value.v === 1 && text(value.id) && value.replica === replica &&
    text(value.author) && text(value.sig) && Array.isArray(value.deps) && value.deps.every((dep) => text(dep)) && text(value.kind);
}

// Validate tags/scalars without semantic conversion; encoder remains codec.ts.
// Return false for representable but nonportable vocabulary, so authentication
// still takes precedence over that refusal. Composite depth matches Wire.
function term(value: unknown, depth: number): boolean {
  if (!Array.isArray(value) || typeof value[0] !== "string") throw new Error("malformed term");
  const [tag, item] = value;
  if (tag === "nil" && value.length === 1) return true;
  if (value.length !== 2) throw new Error("malformed term");
  if (tag === "bool" && typeof item === "boolean") return true;
  if (tag === "int") {
    if (typeof item === "number" && Number.isSafeInteger(item) && item >= 0) return true;
    if (typeof item === "string" && /^(0|[1-9][0-9]*)$/.test(item) && BigInt(item) <= maxUint64) return true;
    throw new Error("malformed integer");
  }
  if (tag === "bin" && canonicalBase64Bytes(item) !== null) return true;
  if (tag === "atom" && text(item)) return atoms.has(item);
  if (tag === "delegation") return delegation(item);
  if (!["list", "tuple", "mapset", "map"].includes(tag) || !Array.isArray(item)) throw new Error("malformed term");
  if (depth <= 0) throw new UnsupportedCutoff();
  let portable = true;
  for (const entry of item) {
    if (tag === "map") {
      if (!Array.isArray(entry) || entry.length !== 2) throw new Error("malformed map pair");
      const key = term(entry[0], depth - 1), value = term(entry[1], depth - 1);
      portable = key && value && portable;
    } else portable = term(entry, depth - 1) && portable;
  }
  return portable;
}
function delegation(value: unknown): boolean {
  if (!closed(value, delegationFields, ["expires_epoch"]) || !text(value.id) || !text(value.replica) ||
    !(value.parent_id === null || text(value.parent_id)) || typeof value.live !== "boolean" ||
    !Array.isArray(value.ops) || !value.ops.every((op) => text(op)) || !Array.isArray(value.roles) || !value.roles.every((role) => text(role))) throw new UnsupportedCutoff();
  if (canonicalBase64Bytes(value.issuer, 32) === null || canonicalBase64Bytes(value.audience, 32) === null || canonicalBase64Bytes(value.sig, 64) === null ||
    (Object.hasOwn(value, "expires_epoch") && !(typeof value.expires_epoch === "number" && Number.isSafeInteger(value.expires_epoch) && value.expires_epoch >= 0))) throw new UnsupportedCutoff();
  return [...value.ops, ...value.roles].every((name) => atoms.has(name));
}
function binary(value: string | Uint8Array): CarrierTerm {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  let raw = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) raw += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return ["bin", btoa(raw)];
}
function recordTerm(op: TreehouseCutoffOp, rejected = false): CarrierTerm {
  const pairs: [CarrierTerm, CarrierTerm][] = [
    [["atom", "id"], binary(op.id)], [["atom", "bytes"], binary(op.bytes)], [["atom", "sig"], binary(op.sig)],
  ];
  if (rejected) pairs.push([["atom", "reason"], ["atom", "bad_signature"]]);
  return ["map", pairs];
}
