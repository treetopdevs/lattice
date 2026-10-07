import { ed25519 } from "@noble/curves/ed25519.js";
import type { CarrierOpSigner } from "./codec";
import { canonicalBase64Bytes } from "./codec";
import { carrierDelegationsFromFrames, carrierOpsToSemanticOps } from "./carrier";
import type { CarrierDelegation, CarrierOpFrame } from "./carrier";
import type { Op } from "./op";
import { compareUtf8 } from "./op";
import { materialize } from "./materialize";
import { frontier } from "./sync";
import { authorTownshipDelegation } from "./township";
import {
  acceptTreehouseInvitation, authorTreehouseCommand, observeTreehouse, treehouseCommandDecoders,
  treehouseInvitationAcceptanceBytes, treehouseSpaceSchema, treehouseThreadSchema,
} from "./treehouse";
import type { TreehouseProduct } from "./treehouse";

// Plan 181 slice 1b: pure invitation and join helpers over frames and artifacts. No storage, no network,
// no route handling (the shell validates routes) and no signing material in any artifact.

/** The lite shell configures the Space plus at most this many Threads (four routes in all). */
export const TREEHOUSE_LITE_THREAD_CAP = 3;
/** Upper bound on the pasted offer text, prefix included. */
export const TREEHOUSE_OFFER_MAX_CHARS = 16384;
/** Upper bound on the pasted join request and acceptance texts. */
export const TREEHOUSE_REQUEST_MAX_CHARS = 4096;

const MEMBER_OPS = ["post", "author_edit", "author_tombstone"] as const;
const PRODUCT_MARKER = "treehouse";
const MAX_OFFER_ROUTES = 16;
const MAX_OFFER_THREADS = 16;
const MAX_ROUTE_KEYS = 8;

export interface TreehouseJoinRequest { publicKey: string }
/** A route entry is an opaque record of text fields here. The shell owns its validation. */
export type TreehouseOfferRoute = Record<string, string>;
export interface TreehouseOfferThread { replica: string; archived: boolean }
export interface TreehouseOffer {
  space: string; invitationId: string; localRealm: string;
  routes: TreehouseOfferRoute[]; threads: TreehouseOfferThread[];
}
export interface TreehouseAcceptanceArtifact { replica: string; invitationId: string; recipient: string; acceptance: string }

export type TreehouseArtifactError =
  | "wrong_product" | "invalid_artifact_format" | "unsupported_artifact_version"
  | "invalid_artifact_payload" | "artifact_too_large" | "secret_field";

type ArtifactKind = "join_request" | "offer" | "acceptance";
const PREFIX: Record<ArtifactKind, string> = {
  join_request: "treehouse-join-request:v1:", offer: "treehouse-offer:v1:", acceptance: "treehouse-acceptance:v1:",
};
const MAX_CHARS: Record<ArtifactKind, number> = {
  join_request: TREEHOUSE_REQUEST_MAX_CHARS, offer: TREEHOUSE_OFFER_MAX_CHARS, acceptance: TREEHOUSE_REQUEST_MAX_CHARS,
};
const SECRET_KEY = /seed|secret|priv|passw|token|bearer|mnemonic|credential|signing|apikey|api_key/i;

// ---- Artifact codecs -------------------------------------------------------------------------------------

export function encodeTreehouseJoinRequest(request: TreehouseJoinRequest): string {
  return encodeArtifact("join_request", { publicKey: validPublicKey(request.publicKey) });
}

export function decodeTreehouseJoinRequest(text: string): TreehouseJoinRequest {
  const body = decodeArtifact("join_request", text, ["publicKey"]);
  return { publicKey: validPublicKey(body.publicKey) };
}

export function encodeTreehouseOffer(offer: TreehouseOffer): string {
  return encodeArtifact("offer", offerFields(offer));
}

export function decodeTreehouseOffer(text: string): TreehouseOffer {
  const body = decodeArtifact("offer", text, ["space", "invitationId", "localRealm", "routes", "threads"]);
  return offerFields(body as unknown as TreehouseOffer);
}

export function encodeTreehouseAcceptance(acceptance: TreehouseAcceptanceArtifact): string {
  return encodeArtifact("acceptance", acceptanceFields(acceptance));
}

export function decodeTreehouseAcceptance(text: string): TreehouseAcceptanceArtifact {
  const body = decodeArtifact("acceptance", text, ["replica", "invitationId", "recipient", "acceptance"]);
  return acceptanceFields(body as unknown as TreehouseAcceptanceArtifact);
}

function offerFields(offer: TreehouseOffer): TreehouseOffer {
  scanSecretKeys(offer);
  const record = plain(offer);
  const routes = record.routes, threads = record.threads;
  if (!Array.isArray(routes) || routes.length > MAX_OFFER_ROUTES || !Array.isArray(threads) || threads.length > MAX_OFFER_THREADS) throw artifactError("invalid_artifact_payload");
  const seen = new Set<string>();
  return {
    space: text(record.space), invitationId: text(record.invitationId), localRealm: text(record.localRealm),
    routes: routes.map((route) => {
      const entry = plain(route), keys = Object.keys(entry);
      if (keys.length === 0 || keys.length > MAX_ROUTE_KEYS) throw artifactError("invalid_artifact_payload");
      return Object.fromEntries(keys.map((key) => {
        if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key)) throw artifactError("invalid_artifact_payload");
        return [key, text(entry[key])];
      }));
    }),
    threads: threads.map((thread) => {
      const entry = plain(thread);
      if (Object.keys(entry).length !== 2 || typeof entry.archived !== "boolean") throw artifactError("invalid_artifact_payload");
      const replica = text(entry.replica);
      if (seen.has(replica)) throw artifactError("invalid_artifact_payload");
      seen.add(replica);
      return { replica, archived: entry.archived };
    }),
  };
}

function acceptanceFields(acceptance: TreehouseAcceptanceArtifact): TreehouseAcceptanceArtifact {
  scanSecretKeys(acceptance);
  const record = plain(acceptance);
  if (canonicalBase64Bytes(record.recipient, 32) === null || canonicalBase64Bytes(record.acceptance, 64) === null) throw artifactError("invalid_artifact_payload");
  return { replica: text(record.replica), invitationId: text(record.invitationId),
    recipient: record.recipient as string, acceptance: record.acceptance as string };
}

function validPublicKey(value: unknown): string {
  if (canonicalBase64Bytes(value, 32) === null) throw artifactError("invalid_artifact_payload");
  return value as string;
}

function encodeArtifact(kind: ArtifactKind, fields: object): string {
  const payload = canonicalJson({ ...fields, kind, product: PRODUCT_MARKER, v: 1 });
  const out = `${PREFIX[kind]}${toBase64Url(new TextEncoder().encode(payload))}`;
  if (out.length > MAX_CHARS[kind]) throw artifactError("artifact_too_large");
  return out;
}

function decodeArtifact(kind: ArtifactKind, input: string, fields: string[]): Record<string, unknown> {
  if (typeof input !== "string") throw artifactError("invalid_artifact_format");
  const raw = input.trim();
  if (raw.length > MAX_CHARS[kind]) throw artifactError("artifact_too_large");
  const prefix = PREFIX[kind];
  if (!raw.startsWith(prefix)) {
    const family = /^([a-z][a-z-]*):v(\d+):/.exec(raw);
    if (family === null) throw artifactError("invalid_artifact_format");
    if (`${family[1]}:` !== prefix.slice(0, prefix.indexOf(":v") + 1)) throw artifactError("wrong_product");
    throw artifactError("unsupported_artifact_version");
  }
  const encoded = raw.slice(prefix.length);
  let parsed: unknown;
  try {
    if (!/^[A-Za-z0-9_-]*$/.test(encoded)) throw new Error("alphabet");
    const bytes = fromBase64Url(encoded);
    if (toBase64Url(bytes) !== encoded) throw new Error("non-canonical base64url");
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw artifactError("invalid_artifact_payload"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw artifactError("invalid_artifact_payload");
  const body = parsed as Record<string, unknown>;
  if (body.product !== PRODUCT_MARKER) throw artifactError("wrong_product");
  scanSecretKeys(body);
  const expected = [...fields, "kind", "product", "v"].sort();
  const keys = Object.keys(body).sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i]) || body.kind !== kind || body.v !== 1) throw artifactError("invalid_artifact_payload");
  if (raw !== `${prefix}${toBase64Url(new TextEncoder().encode(canonicalJson(body)))}`) throw artifactError("invalid_artifact_payload");
  const { kind: _kind, product: _product, v: _v, ...rest } = body;
  return rest;
}

function scanSecretKeys(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(scanSecretKeys); return; }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw artifactError("secret_field");
    scanSecretKeys(item);
  }
}

function plain(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw artifactError("invalid_artifact_payload");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw artifactError("invalid_artifact_payload");
  return value;
}

function artifactError(reason: TreehouseArtifactError): Error { return new Error(reason); }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): Uint8Array {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (encoded.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

// ---- Frame helpers ---------------------------------------------------------------------------------------

const schemaOf = (product: TreehouseProduct) => product === "Treehouse.Space" ? treehouseSpaceSchema : treehouseThreadSchema;
const opsOf = (product: TreehouseProduct, frames: readonly CarrierOpFrame[]) => carrierOpsToSemanticOps([...frames], {}, treehouseCommandDecoders(product));
const verdicts = (product: TreehouseProduct, ops: Op[]) => materialize(schemaOf(product), ops).quarantineReasons;
const honoredOps = (ops: Op[], reasons: ReadonlyMap<string, string>) => ops.filter((op) => !reasons.has(op.id));
const pubkeyBase64 = (key: string | Uint8Array) => typeof key === "string" ? key : btoa(String.fromCharCode(...key));

/** Honored `create_thread` references, de-duplicated and sorted exactly like the BEAM invitation scope. */
function threadScope(ops: Op[], reasons: ReadonlyMap<string, string>): string[] {
  return [...new Set(honoredOps(ops, reasons).filter((op) => op.kind === "command" && op.command === "create_thread")
    .map((op) => op.commandArgs![0] as string))].sort(compareUtf8);
}

/**
 * The delegation naming `publicKey` as audience in `replica`'s frames, optionally one that carries `command`.
 * This generalizes the issuer-root lookup: a joiner's capability is an exact-audience grant, not the root.
 * `product` is required: only delegations carried by honored frames qualify, so a quarantined grant is never
 * offered.
 */
export function memberCapability(
  frames: readonly CarrierOpFrame[], publicKey: string | Uint8Array, replica: string,
  options: { product: TreehouseProduct; command?: string },
): CarrierDelegation | null {
  const audience = pubkeyBase64(publicKey);
  const reasons = verdicts(options.product, opsOf(options.product, frames));
  for (const frame of frames) {
    if (frame.replica !== replica || reasons.has(frame.id)) continue;
    for (const delegation of carrierDelegationsFromFrames([frame])) {
      if (delegation.audience !== audience || delegation.replica !== replica) continue;
      if (options.command !== undefined && !delegation.ops.includes(options.command)) continue;
      return delegation;
    }
  }
  return null;
}

// ---- Review ----------------------------------------------------------------------------------------------

export type TreehouseInvitationReview =
  | { ok: true; invitationId: string; recipient: string; threads: string[]; admitted: boolean }
  | { ok: false; reason: string };

/**
 * Review one invitation against retained Space frames. The scope returned is the signed scope, every honored
 * Thread (archived included). Pure: it signs and stores nothing.
 */
export function reviewTreehouseInvitation(input: {
  replica: string; frames: readonly CarrierOpFrame[]; invitationId: string; recipient: string; offerThreads?: readonly string[];
}): TreehouseInvitationReview {
  const refuse = (reason: string): TreehouseInvitationReview => ({ ok: false, reason });
  if (input.frames.some((frame) => frame.replica !== input.replica)) return refuse("wrong_replica");
  const ops = opsOf("Treehouse.Space", input.frames);
  const reasons = verdicts("Treehouse.Space", ops);
  const invitation = ops.find((op) => op.id === input.invitationId && op.kind === "command" && op.command === "issue_invitation");
  if (invitation === undefined) return refuse("invitation_not_found");
  if (reasons.has(invitation.id)) return refuse("invitation_not_honored");
  const [recipient, signed] = invitation.commandArgs as [string, string[]];
  if (recipient !== input.recipient) return refuse("wrong_recipient");
  const honored = honoredOps(ops, reasons);
  if (honored.some((op) => op.kind === "command" && op.command === "revoke_invitation" && op.commandArgs?.[0] === invitation.id)) return refuse("revoked");
  if (JSON.stringify(signed) !== JSON.stringify(threadScope(ops, reasons))) return refuse("stale_scope");
  if (input.offerThreads !== undefined && JSON.stringify([...input.offerThreads].sort(compareUtf8)) !== JSON.stringify(signed)) return refuse("offer_scope_mismatch");
  const admitted = honored.some((op) => op.kind === "command" && op.command === "admit_member" &&
    op.commandArgs?.[0] === invitation.id && op.commandArgs[1] === recipient);
  return { ok: true, invitationId: invitation.id, recipient, threads: [...signed], admitted };
}

/** Joiner side: review, then sign the recipient-bound acceptance. Nothing is persisted or sent. */
export async function signTreehouseAcceptance(input: {
  replica: string; frames: readonly CarrierOpFrame[]; invitationId: string; signer: CarrierOpSigner;
}): Promise<TreehouseAcceptanceArtifact> {
  const recipient = pubkeyBase64(input.signer.publicKey);
  const review = reviewTreehouseInvitation({ replica: input.replica, frames: input.frames, invitationId: input.invitationId, recipient });
  if (!review.ok) throw new Error(review.reason);
  const invitation = opsOf("Treehouse.Space", input.frames).find((op) => op.id === input.invitationId)!;
  return { replica: input.replica, invitationId: input.invitationId, recipient,
    acceptance: await acceptTreehouseInvitation(input.replica, invitation, input.signer) };
}

// ---- Founder authoring -----------------------------------------------------------------------------------

function requireFrames(frames: readonly CarrierOpFrame[] | undefined, replica: string): readonly CarrierOpFrame[] {
  if (frames === undefined || frames.length === 0 || frames.some((frame) => frame.replica !== replica)) throw new Error("thread_not_available");
  return frames;
}

function assertHonored(product: TreehouseProduct, frames: readonly CarrierOpFrame[], authored: CarrierOpFrame): void {
  const reason = verdicts(product, opsOf(product, [...frames, authored])).get(authored.id);
  if (reason !== undefined) throw new Error(reason);
}

/**
 * Founder side: one `issue_invitation` over the full honored Thread scope, archived Threads included.
 * Refuses `thread_scope_exceeds_routes` above the lite cap or when a Thread in scope has no supplied route.
 */
export async function authorTreehouseIssueInvitation(input: {
  signer: CarrierOpSigner; replica: string; frames: readonly CarrierOpFrame[];
  threadFrames: Readonly<Record<string, readonly CarrierOpFrame[]>>; routes: readonly { replica: string }[]; recipient: string;
}): Promise<{ frame: CarrierOpFrame; threads: TreehouseOfferThread[] }> {
  if (canonicalBase64Bytes(input.recipient, 32) === null) throw new Error("invalid_recipient");
  if (input.frames.some((frame) => frame.replica !== input.replica)) throw new Error("wrong_replica");
  const ops = opsOf("Treehouse.Space", input.frames);
  const scope = threadScope(ops, verdicts("Treehouse.Space", ops));
  const routed = new Set(input.routes.map((route) => route.replica));
  if (scope.length > TREEHOUSE_LITE_THREAD_CAP || scope.some((replica) => !routed.has(replica))) throw new Error("thread_scope_exceeds_routes");
  const threads = scope.map((replica) => {
    const view = observeTreehouse("Treehouse.Thread", opsOf("Treehouse.Thread", requireFrames(input.threadFrames[replica], replica)));
    return { replica, archived: (view.state as { archived?: boolean }).archived === true };
  });
  const capability = memberCapability(input.frames, input.signer.publicKey, input.replica, { command: "issue_invitation", product: "Treehouse.Space" });
  if (capability === null) throw new Error("no_capability");
  const frame = await authorTreehouseCommand({ product: "Treehouse.Space", replica: input.replica, deps: frontier(ops), signer: input.signer,
    capId: capability.id, command: { command: "issue_invitation", recipient: input.recipient, threads: scope } });
  assertHonored("Treehouse.Space", input.frames, frame);
  return { frame, threads };
}

export interface TreehouseThreadGrant { replica: string; frame: CarrierOpFrame; delegation: CarrierDelegation }

/**
 * Founder side: the `admit_member` op plus one exact-audience Thread grant per Thread in the invitation scope,
 * each parented on the founder's own Thread delegation. Everything is authored or nothing is: all reviews and
 * lookups run before the first signature. Parts already present in the frames are skipped, so a retry after a
 * partial landing authors only what is missing (`admit` is null when the admission is already honored).
 */
export async function authorTreehouseAdmitAndGrant(input: {
  signer: CarrierOpSigner; replica: string; frames: readonly CarrierOpFrame[];
  threadFrames: Readonly<Record<string, readonly CarrierOpFrame[]>>; acceptance: TreehouseAcceptanceArtifact;
}): Promise<{ admit: CarrierOpFrame | null; grants: TreehouseThreadGrant[] }> {
  const { acceptance } = input;
  if (acceptance.replica !== input.replica) throw new Error("wrong_replica");
  const review = reviewTreehouseInvitation({ replica: input.replica, frames: input.frames, invitationId: acceptance.invitationId, recipient: acceptance.recipient });
  if (!review.ok) throw new Error(review.reason);
  const ops = opsOf("Treehouse.Space", input.frames);
  const invitation = ops.find((op) => op.id === acceptance.invitationId)!;
  const signature = canonicalBase64Bytes(acceptance.acceptance, 64), key = canonicalBase64Bytes(acceptance.recipient, 32);
  let signed = false;
  try { signed = signature !== null && key !== null && ed25519.verify(signature, treehouseInvitationAcceptanceBytes(input.replica, invitation), key, { zip215: false }); } catch { signed = false; }
  if (!signed) throw new Error("invalid_acceptance");

  const plans = review.threads.map((replica) => {
    const frames = requireFrames(input.threadFrames[replica], replica);
    if (honoredDelegations(frames, replica).some((delegation) => delegation.audience === acceptance.recipient &&
      MEMBER_OPS.every((name) => delegation.ops.includes(name)))) return null;
    const parent = honoredDelegations(frames, replica).find((delegation) => delegation.audience === pubkeyBase64(input.signer.publicKey) &&
      MEMBER_OPS.every((name) => delegation.ops.includes(name)));
    if (parent === undefined) throw new Error("no_capability");
    return { replica, frames, parent };
  });
  const admitCap = review.admitted ? null : memberCapability(input.frames, input.signer.publicKey, input.replica, { command: "admit_member", product: "Treehouse.Space" });
  if (!review.admitted && admitCap === null) throw new Error("no_capability");

  let admit: CarrierOpFrame | null = null;
  if (admitCap !== null) {
    admit = await authorTreehouseCommand({ product: "Treehouse.Space", replica: input.replica, deps: frontier(ops), signer: input.signer, capId: admitCap.id,
      command: { command: "admit_member", invitationId: acceptance.invitationId, recipient: acceptance.recipient, level: "member", acceptance: acceptance.acceptance } });
    assertHonored("Treehouse.Space", input.frames, admit);
  }
  const grants: TreehouseThreadGrant[] = [];
  for (const plan of plans) {
    if (plan === null) continue;
    const frame = await authorTownshipDelegation({ replica: plan.replica, deps: frontier(opsOf("Treehouse.Thread", plan.frames)),
      audiencePubkey: acceptance.recipient, parentId: plan.parent.id, ops: [...MEMBER_OPS], roles: [], live: false, signer: input.signer });
    assertHonored("Treehouse.Thread", plan.frames, frame);
    grants.push({ replica: plan.replica, frame, delegation: carrierDelegationsFromFrames([frame])[0]! });
  }
  return { admit, grants };
}

function honoredDelegations(frames: readonly CarrierOpFrame[], replica: string): CarrierDelegation[] {
  const reasons = verdicts("Treehouse.Thread", opsOf("Treehouse.Thread", frames));
  return frames.filter((frame) => frame.replica === replica && !reasons.has(frame.id)).flatMap((frame) => carrierDelegationsFromFrames([frame]));
}
