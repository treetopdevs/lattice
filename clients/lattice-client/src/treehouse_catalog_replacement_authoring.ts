// TS twin of Treehouse.CatalogReplacementAuthoring (plan 316 PR 2): freeze, derive, review, sign last.
// Unsigned intents are private full-judge inputs; they are never appended or exported. A Core-honored
// result is an authorized signed proposal, not a route switch or installed catalog trust.
// Retained rotations and catalogs pass an interim structural mirror of the CatalogTrust resolver before they can become
// nodes or heads; any failure refuses. Non-claim: entry-fact observation, D-276 node eligibility, the D-275 closing rule
// and full §4 refusal precedence are Stage B resolver semantics owned by plan 316 PR 4, whose binding-graph function
// replaces this mirror once it lands (row 354).
import { verifyEd25519 } from "./signature";
import { analyzeAuthority, resolveContinuationProfileFromFrames } from "./authority";
import { base64ToBytes, carrierOpsToSemanticOps, decodeCarrierOpFrame } from "./carrier";
import type { CarrierOpFrame, CarrierTerm } from "./carrier";
import { authorCarrierOp, canonicalBase64Bytes, verifyCarrierOp } from "./codec";
import type { CarrierOpSigner } from "./codec";
import { ancestors, canonicalOrder } from "./dag";
import { materialize } from "./materialize";
import { compareUtf8 } from "./op";
import { frontier } from "./sync";
import { townshipCapTerm } from "./township";
import { treehouseCatalogBootstrapsFromFrames, treehouseCommandDecoders, treehouseSpaceSchema } from "./treehouse";
import { deriveTreehouseCatalogCutoff } from "./treehouse_catalog_cutoff";
import {
  canonicalBytesForCatalogReplacementClaim, canonicalBytesForCatalogReplacementPossession, catalogInventoryId,
  catalogReplacementClaimToCarrierTerm, catalogRotationId, normalizeCatalogEnvelope, normalizeCatalogReplacementClaim,
  normalizeCatalogRotationEnvelope, transportCatalogId, verifyCatalogEnvelope, verifyCatalogReplacementPossession,
  verifyCatalogRotationEnvelope, canonicalBytesForCatalogRotation,
} from "./treehouse_catalog_codec";
import type {
  CatalogCutoff, CatalogEntry, CatalogEnvelope, CatalogPriorCatalog, CatalogReplacementClaim, CatalogRotationEnvelope,
} from "./treehouse_catalog_codec";

/** One retained complete history: authenticated frames plus retained bad-signature evidence. */
export interface TreehouseCatalogReplacementHistory {
  frames: readonly unknown[];
  rejected: readonly { frame: unknown; reason: "bad_signature" }[];
}

export interface TreehouseCatalogReplacementRequest {
  author: string;
  nonce: string;
  parents: string[];
  priorCatalogs: CatalogPriorCatalog[];
  generation: number;
  newCatalogKey: string;
  newServiceId: string;
  newServiceKey: string;
  newOrigin: string;
  /** The exact first-catalog entry list under the new binding. */
  entries: CatalogEntry[];
  /** Thread replica → retained history; the Space cutoff comes from the frozen Space frames. */
  replicaHistories: Record<string, TreehouseCatalogReplacementHistory>;
  /** Retained catalog rotations (off-Space binding nodes); verified and chained from a known node. */
  rotations: CatalogRotationEnvelope[];
  /** Retained signed catalogs; verified under their binding's key. */
  catalogs: CatalogEnvelope[];
}

export type TreehouseCatalogReplacementStatus = "awaiting_possession" | "cancelled" | "cancelled_after_signature" | "signed";
/** Caller-owned journal entry keyed by the claim nonce; never persisted here. */
export interface TreehouseCatalogReplacementJournalEntry {
  attemptId: string | null;
  claimBytes: Uint8Array | null;
  status: TreehouseCatalogReplacementStatus;
  reason: string | null;
  opId: string | null;
}
export type TreehouseCatalogReplacementJournal = Readonly<Record<string, TreehouseCatalogReplacementJournalEntry>>;

export interface TreehouseCatalogReplacementAttempt {
  attemptId: string;
  status: "awaiting_possession";
  replica: string;
  request: TreehouseCatalogReplacementRequest;
  claim: CatalogReplacementClaim;
  claimBytes: Uint8Array;
  catalogPossessionBytes: Uint8Array;
  servicePossessionBytes: Uint8Array;
  author: string;
  cap: string;
  frozenFrontier: string[];
  journalEntry: TreehouseCatalogReplacementJournalEntry;
}

export type TreehouseCatalogReplacementPrepareResult =
  | { ok: true; attempt: TreehouseCatalogReplacementAttempt }
  | { ok: false; reason: string };
export type TreehouseCatalogReplacementAuthorResult =
  | { ok: true; frame: CarrierOpFrame; bindingId: string; attemptId: string; journalEntry: TreehouseCatalogReplacementJournalEntry }
  | { ok: false; reason: string; journalEntry: TreehouseCatalogReplacementJournalEntry };

/** Current Space history: frames alone, or frames with retained bad-signature evidence. */
export type TreehouseCatalogReplacementCurrent = readonly unknown[] | TreehouseCatalogReplacementHistory;

const requestFields = ["author", "nonce", "parents", "priorCatalogs", "generation", "newCatalogKey", "newServiceId",
  "newServiceKey", "newOrigin", "entries", "replicaHistories", "rotations", "catalogs"].sort();
const zero = () => new Uint8Array(64);
const tooLarge = "catalog_command_too_large";

type Prepared = Omit<TreehouseCatalogReplacementAttempt, "journalEntry">;
type Refusal = { ok: false; reason: string };
const refuse = (reason: string): Refusal => ({ ok: false, reason });

/**
 * Review step; signs nothing. Freezes the frontier and derives the authority and recovery claim fields from the
 * judged history; the caller-chosen parents, priorCatalogs and generation are checked against the binding graph
 * (honored bootstrap, retained rotations and catalogs, on-Space replacements honored at their strict prefix).
 */
export async function prepareTreehouseCatalogReplacementFromFrames(input: {
  replica: string; frames: readonly unknown[]; rejected?: TreehouseCatalogReplacementHistory["rejected"];
  request: TreehouseCatalogReplacementRequest; journal: TreehouseCatalogReplacementJournal;
}): Promise<TreehouseCatalogReplacementPrepareResult> {
  // Snapshot every input first: a caller mutation while derivation awaits must never mix snapshots, and the attempt
  // must retain the exact request its claim was derived from.
  let snapshot: typeof input;
  try { snapshot = structuredClone(input); } catch { return refuse("application_invalid_catalog"); }
  try {
    if (!object(snapshot.journal)) return refuse("application_invalid_catalog");
    const prepared = await derive(snapshot.replica, {frames: snapshot.frames, rejected: snapshot.rejected ?? []}, snapshot.request,
      snapshot.journal);
    if (!prepared.ok) return prepared;
    const attempt = {...prepared.attempt, journalEntry: entry(prepared.attempt, "awaiting_possession", null, null)};
    return {ok: true, attempt};
  } catch { return refuse("invalid_verified_history"); }
}

/** Re-read, refuse reclassification or a moved claim, verify both possessions, preflight, then sign once. */
export async function authorTreehouseCatalogReplacementFromFrames(input: {
  currentFrames: () => TreehouseCatalogReplacementCurrent | Promise<TreehouseCatalogReplacementCurrent>;
  attempt: TreehouseCatalogReplacementAttempt; possession: {catalog: string; service: string}; signer: CarrierOpSigner;
}): Promise<TreehouseCatalogReplacementAuthorResult> {
  // Snapshot the caller's attempt: a mutation during the async signer must never reach the post-sign checks.
  // Possessions are snapshotted with it, so validation, preflight and signing all see the same signatures.
  let attempt: TreehouseCatalogReplacementAttempt, possessionInput: unknown;
  try { attempt = structuredClone(input.attempt); possessionInput = structuredClone(input.possession); } catch {
    return {ok: false, reason: "stale_verified_state", journalEntry: entry(null, "cancelled", "stale_verified_state", null)};
  }
  if (!attemptShape(attempt)) return {ok: false, reason: "stale_verified_state", journalEntry: entry(null, "cancelled", "stale_verified_state", null)};
  const cancel = (reason: string) => ({ok: false as const, reason, journalEntry: entry(attempt, "cancelled", reason, null)});
  let candidate: CarrierOpFrame, claim: CatalogReplacementClaim;
  try {
    const current = await read(input.currentFrames, attempt.replica);
    if (!current.ok) return cancel(current.reason);
    const before = await reclassified(current.history, attempt, null);
    if (before !== null) return cancel(before);
    const fresh = await derive(attempt.replica, current.raw, attempt.request, null);
    if (!fresh.ok) return cancel(fresh.reason === "invalid_verified_history" ? fresh.reason : "stale_verified_state");
    if (!samePrepared(fresh.attempt, attempt)) return cancel("stale_verified_state");
    // Sign only the freshly derived claim, never the caller-held copy.
    claim = fresh.attempt.claim;
    const possession = possessionInput;
    if (!object(possession) || !same(Object.keys(possession).sort(), ["catalog", "service"]) ||
        !verifyCatalogReplacementPossession(claim, possession.catalog, possession.service)) return cancel("invalid_possession");
    const author = canonicalBase64Bytes(attempt.author, 32);
    if (author === null || !equalBytes(input.signer.publicKey, author)) return cancel("wrong_signer");
    candidate = await intent(claim, possession.catalog as string, possession.service as string, {publicKey: author, sign: zero});
    if (envelopeBytes(candidate) > 64_000) return cancel(tooLarge);
    const reason = (await judgeCandidate(current.history.frames, candidate)).quarantineReasons.get(candidate.id);
    if (reason !== undefined) return cancel(reason);
  } catch { return cancel("invalid_verified_history"); }
  let frame: CarrierOpFrame;
  try {
    const possession = possessionInput as {catalog: string; service: string};
    frame = await intent(claim, possession.catalog, possession.service, input.signer);
  } catch { return cancel("signer_failed"); }
  try {
    if (frame.id !== candidate.id || !(await verifyCarrierOp(frame, {verify: async (author, bytes, signature) =>
      verifyEd25519(signature, bytes, base64ToBytes(author))})).valid) return cancel("invalid_signer_signature");
  } catch { return cancel("invalid_signer_signature"); }
  // The signed frame leaves only if the freshly re-read frozen state is still unreclassified.
  const late = (reason: string) => ({ok: false as const, reason, journalEntry: entry(attempt, "cancelled_after_signature", reason, null)});
  try {
    const current = await read(input.currentFrames, attempt.replica);
    if (!current.ok) return late(current.reason);
    const after = await reclassified(current.history, attempt, frame);
    if (after !== null) return late(after);
    // The signed claim must still be the one a fresh preparation derives now.
    const again = await derive(attempt.replica, current.raw, attempt.request, null);
    if (!again.ok) return late(again.reason === "invalid_verified_history" ? again.reason : "stale_verified_state");
    if (!samePrepared(again.attempt, attempt)) return late("stale_verified_state");
    if (envelopeBytes(frame) > 64_000) return late(tooLarge);
    return {ok: true, frame, bindingId: frame.id, attemptId: attempt.attemptId, journalEntry: entry(attempt, "signed", null, frame.id)};
  } catch { return late("stale_verified_state"); }
}

// --- derive -------------------------------------------------------------------

async function derive(replica: string, space: TreehouseCatalogReplacementHistory, value: unknown,
  journal: TreehouseCatalogReplacementJournal | null): Promise<{ok: true; attempt: Prepared} | Refusal> {
  if (!requestShape(value)) return refuse("application_invalid_catalog");
  const request = value;
  const history = await authenticateJudgedHistory(replica, space.frames);
  if (history === null) return refuse("invalid_verified_history");
  const deps = history.frontier;
  const observed = await treehouseCatalogBootstrapsFromFrames({replica, frames: history.frames});
  if (!observed.ok) return observed;
  if (observed.bootstraps.length !== 1) return refuse("application_invalid_catalog");
  const bootstrap = observed.bootstraps[0]!;
  // Plan 316 §3 step 4: the claim's profile fields must be the pin selected at this frozen prefix, not the one the
  // bootstrap was honored under.
  const profile = await resolveContinuationProfileFromFrames({replica, frames: space.frames});
  if (!profile.ok || profile.profileGenesis !== bootstrap.record.profileGenesis || profile.profileId !== bootstrap.record.profileId) {
    return refuse("wrong_catalog_scope");
  }
  // Holder and capability come from the judge only; the caller never supplies either.
  const acquire = history.authority.acquiresByRole.get("admin")?.at(-1);
  if (acquire === undefined || acquire.holderPubkey !== request.author) return refuse("not_holder");
  const evidence = history.byId.get(acquire.opId)?.authority;
  const cap = evidence !== undefined && "delegation" in evidence ? evidence.delegation.id : undefined;
  if (typeof cap !== "string") return refuse("not_holder");
  const beacons = history.authority.security.validBeacons;
  if (beacons.length === 0) return refuse("catalog_epoch_missing");
  const values = beacons.map((beacon) => typeof beacon.epoch === "number" ? beacon.epoch : Number(beacon.epoch));
  const epoch = Math.max(...values);
  const epochBasis = beacons.filter((_beacon, index) => values[index] === epoch).map((beacon) => beacon.opId).sort(compareUtf8);
  // Plan 316 §3 step 4 resolver predicates on the selected acquisition: it grants replace_catalog_v1, is not live and
  // carries a finite lease unexpired at the claim epoch. A root holder or live/unleased capability is refused.
  const granted = evidence !== undefined && "delegation" in evidence ? evidence.delegation : undefined;
  if (granted === undefined || granted.live || typeof granted.expiresEpoch !== "number" || granted.expiresEpoch < epoch ||
    !granted.ops.includes("replace_catalog_v1")) return refuse("catalog_authority_refused");
  let inventoryDigest: string;
  try {
    if (!request.entries.every((item) => object(item) && item.serviceId === request.newServiceId && item.serviceKey === request.newServiceKey) ||
        !request.entries.some((item) => item.kind === "space") ||
        // The Space entry is the one a first catalog can carry: its reference must be the bootstrap.
        !request.entries.every((item) => item.kind !== "space" || (item.replica === replica && item.reference === bootstrap.id))) {
      return refuse("application_invalid_catalog");
    }
    inventoryDigest = catalogInventoryId(request.entries);
  } catch { return refuse("application_invalid_catalog"); }
  const cutoffs = await deriveCutoffs(replica, space, request);
  if (!cutoffs.ok) return cutoffs;
  const claim = normalizeCatalogReplacementClaim({version: 1, product: "treehouse", space: replica, bootstrap: bootstrap.id,
    profileGenesis: bootstrap.record.profileGenesis, profileId: bootstrap.record.profileId, parents: request.parents,
    priorCatalogs: request.priorCatalogs, generation: request.generation, nonce: request.nonce, newCatalogKey: request.newCatalogKey,
    newServiceId: request.newServiceId, newServiceKey: request.newServiceKey, newOrigin: request.newOrigin, inventoryDigest,
    cutoffs: cutoffs.cutoffs, author: request.author, cap, holderEpoch: acquire.opId, deps, epoch, epochBasis});
  if (claim === null) return refuse("malformed_catalog");
  const covered = coverage(history, replica, bootstrap, claim, request);
  if (covered !== null) return refuse(covered);
  const claimBytes = canonicalBytesForCatalogReplacementClaim(claim);
  // The journal is caller-owned and may be lost or belong to another device, so a nonce already carried by a retained
  // replacement of this Space and bootstrap that Core honored at its strict prefix (binding-node eligibility) is reused
  // regardless of the journal. A raw, unauthorized proposal reserves nothing.
  if (history.ops.some((op) => {
    if (op.command !== "replace_catalog_v1") return false;
    const cited = normalizeCatalogReplacementClaim(op.commandArgs?.[0]);
    return cited !== null && cited.nonce === claim.nonce && cited.space === replica && cited.bootstrap === bootstrap.id &&
      honoredAtPrefix(history, op.id, replica);
  })) return refuse("attempt_nonce_reused");
  // The attempt journal is keyed by the claim nonce; identical bytes are an idempotent retry.
  const prior = journal === null ? undefined : Object.hasOwn(journal, claim.nonce) ? journal[claim.nonce] : undefined;
  if (prior !== undefined && !(prior.claimBytes instanceof Uint8Array && equalBytes(prior.claimBytes, claimBytes))) {
    return refuse("attempt_nonce_reused");
  }
  // The possession and op-signature slots are fixed at 64 bytes, so the placeholder sizes the frame exactly.
  const zeroB64 = b64(zero());
  const placeholder = await intent(claim, zeroB64, zeroB64, {publicKey: base64ToBytes(request.author), sign: zero});
  if (envelopeBytes(placeholder) > 64_000) return refuse(tooLarge);
  const reason = (await judgeCandidate(history.frames, placeholder)).quarantineReasons.get(placeholder.id);
  if (reason !== "application_invalid_catalog") return refuse(reason ?? "invalid_review_intent");
  return {ok: true, attempt: {attemptId: claim.nonce, status: "awaiting_possession", replica, request, claim, claimBytes,
    catalogPossessionBytes: canonicalBytesForCatalogReplacementPossession("catalog", claim),
    servicePossessionBytes: canonicalBytesForCatalogReplacementPossession("service", claim),
    author: request.author, cap, frozenFrontier: deps}};
}

// --- retained-evidence coverage (plan 316 §3: parents, priorCatalogs, generation) ----------

type BindingNode = {generation: number; key: string; parents: readonly string[]; inventory: string | null;
  serviceId: string; serviceKey: string};
type BootstrapRecord = {catalogKey: string; serviceId: string; serviceKey: string};
type HeldCatalog = CatalogEnvelope;
class CoverageRefusal { constructor(readonly reason: string) {} }
const refuseCoverage = (reason: string): never => { throw new CoverageRefusal(reason); };
const maxSafe = Number.MAX_SAFE_INTEGER;
const maxArtifacts = 1_024;
const safe = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= maxSafe;

// Nodes: the honored bootstrap (generation 0), every on-Space replacement honored at its strict prefix (D-276,
// refused-on-the-union nodes included) and every retained rotation that resolves under the Stage B structural rules.
// Retained rotations and catalogs are hostile until resolved: each must pass the checks CatalogTrust applies (chain,
// generation/revision step, key separation, both signatures, prior/previous presence, binding, inventory and cutoff
// agreement) before it may become a node, a held catalog or a head; any failure refuses the whole preflight.
// Entry-fact observation against the retained histories stays with the PR 4 resolver (row 354).
function coverage(history: JudgedHistory, replica: string, bootstrap: {id: string; record: BootstrapRecord},
  claim: CatalogReplacementClaim, request: TreehouseCatalogReplacementRequest): string | null {
  const record = bootstrap.record;
  const nodes = new Map<string, BindingNode>();
  for (const op of history.ops) {
    if (op.command !== "replace_catalog_v1") continue;
    const cited = normalizeCatalogReplacementClaim(op.commandArgs?.[0]);
    if (cited === null || cited.space !== replica || cited.bootstrap !== bootstrap.id || !honoredAtPrefix(history, op.id, replica)) continue;
    nodes.set(op.id, {generation: cited.generation, key: cited.newCatalogKey, parents: cited.parents, inventory: cited.inventoryDigest,
      serviceId: cited.newServiceId, serviceKey: cited.newServiceKey});
  }
  nodes.set(bootstrap.id, {generation: 0, key: record.catalogKey, parents: [], inventory: null, serviceId: record.serviceId,
    serviceKey: record.serviceKey});
  // CatalogTrust refuses more than 1,024 retained artifacts; its JSON byte budgets are not mirrored here (row 355).
  if (request.catalogs.length + request.rotations.length > maxArtifacts) return "control_history_limit";
  const rotations = new Map<string, CatalogRotationEnvelope>();
  for (const value of request.rotations as unknown[]) {
    const envelope = normalizeCatalogRotationEnvelope(value);
    if (envelope === null) return "malformed_catalog";
    if (envelope.rotation.space !== replica || envelope.rotation.bootstrap !== bootstrap.id) return "wrong_catalog_scope";
    rotations.set(catalogRotationId(envelope), envelope);
  }
  // A catalog id covers the payload only. As in CatalogTrust addCatalog, a repeated id must carry the identical
  // signature; any differing copy (even a second valid one) refuses.
  const catalogs = new Map<string, HeldCatalog>();
  for (const value of request.catalogs as unknown[]) {
    const envelope = normalizeCatalogEnvelope(value);
    if (envelope === null) return "malformed_catalog";
    if (envelope.catalog.space !== replica || envelope.catalog.bootstrap !== bootstrap.id) return "wrong_catalog_scope";
    const id = transportCatalogId(envelope.catalog), known = catalogs.get(id);
    if (known === undefined) catalogs.set(id, envelope);
    else if (known.signature !== envelope.signature) return "invalid_catalog_signature";
  }
  try { resolveGraph(nodes, rotations, catalogs); } catch (error) {
    if (error instanceof CoverageRefusal) return error.reason;
    throw error;
  }
  if ([...nodes.values()].some((node) => node.parents.some((parent) => !nodes.has(parent)))) return "trust_pending";
  const held = [...catalogs].map(([id, item]) => ({id, binding: item.catalog.binding, previous: item.catalog.previous}));
  // D-275: every ancestor-or-self of a cited parent is closed; the rest are heads.
  const closed = new Set<string>();
  const stack = [...nodes.values()].flatMap((node) => [...node.parents]);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (closed.has(id)) continue;
    closed.add(id);
    stack.push(...nodes.get(id)!.parents);
  }
  const heads = [...nodes.keys()].filter((id) => !closed.has(id));
  // Plan 316 §4 precedence: an unknown parent is the intrinsic step-5 failure, before the step-7 sibling.
  if (claim.parents.some((id) => !nodes.has(id))) return "invalid_catalog_transition";
  const parents = cover(heads, claim.parents, (id) => id);
  if (parents !== null) return parents;
  const generation = Math.max(...claim.parents.map((id) => nodes.get(id)!.generation)) + 1;
  if (claim.generation !== generation) return "invalid_catalog_transition";
  // Step 5: each prior entry names a cited parent and, unless null, a catalog held under it.
  if (claim.priorCatalogs.some((item) => !claim.parents.includes(item.binding))) return "invalid_catalog_transition";
  if (claim.priorCatalogs.some((item) => item.catalog !== null &&
    !held.some((entry) => entry.binding === item.binding && entry.id === item.catalog))) return "trust_pending";
  const previous = new Set(held.map((item) => `${item.binding}\u0000${item.previous}`));
  const expected = claim.parents.flatMap((binding): CatalogPriorCatalog[] => {
    const under = [...new Set(held.filter((item) => item.binding === binding && !previous.has(`${binding}\u0000${item.id}`))
      .map((item) => item.id))];
    return under.length === 0 ? [{binding, catalog: null}] : under.map((catalog) => ({binding, catalog}));
  });
  // Step 5 (D-277): against each parent a changed service key needs a changed service ID, and the first catalog's
  // entries extend every cited non-null prior catalog.
  if (claim.parents.some((id) => {
    const node = nodes.get(id)!;
    return claim.newServiceKey !== node.serviceKey && claim.newServiceId === node.serviceId;
  })) return "invalid_catalog_transition";
  if (claim.priorCatalogs.some((item) => item.catalog !== null &&
    !inventoryExtends(catalogs.get(item.catalog)!.catalog.entries, request.entries))) return "invalid_catalog_transition";
  return cover(expected, claim.priorCatalogs, (item) => `${item.binding}\u0000${item.catalog}`);
}

// Same traversal as CatalogTrust: every catalog in id order, then every rotation; a cycle is a transition failure.
function resolveGraph(nodes: Map<string, BindingNode>, rotations: Map<string, CatalogRotationEnvelope>,
  catalogs: Map<string, HeldCatalog>): void {
  const ready = new Set<string>(), visiting = new Set<string>();
  const bindingFor = (id: string): BindingNode => {
    const known = nodes.get(id);
    if (known !== undefined) return known;
    const envelope = rotations.get(id);
    if (envelope === undefined) return refuseCoverage("trust_pending");
    if (visiting.has(`b:${id}`)) refuseCoverage("invalid_catalog_transition");
    visiting.add(`b:${id}`);
    const r = envelope.rotation, parent = bindingFor(r.parent);
    if (r.generation !== parent.generation + 1 || !safe(parent.generation + 1) || r.newCatalogKey === parent.key ||
      r.newCatalogKey === parent.serviceKey) refuseCoverage("invalid_catalog_transition");
    if (!verifyCatalogRotationEnvelope(envelope, parent.key)) {
      // Distinguish old signer authorization from possession under the new key.
      const old = canonicalBase64Bytes(envelope.oldSignature, 64), pub = canonicalBase64Bytes(parent.key, 32);
      if (old === null || pub === null || !verifyEd25519(old, canonicalBytesForCatalogRotation(r), pub)) refuseCoverage("invalid_catalog_signature");
      refuseCoverage("invalid_possession");
    }
    const prior = catalogFor(r.priorCatalog).catalog;
    if (prior.binding !== r.parent || catalogInventoryId(prior.entries) !== r.inventoryDigest ||
      !same(r.cutoffs.map((cutoff) => cutoff.replica), prior.entries.map((item) => item.replica))) refuseCoverage("invalid_catalog_transition");
    const node: BindingNode = {generation: r.generation, key: r.newCatalogKey, parents: [r.parent], inventory: r.inventoryDigest,
      serviceId: parent.serviceId, serviceKey: parent.serviceKey};
    nodes.set(id, node);
    visiting.delete(`b:${id}`);
    return node;
  };
  const catalogFor = (id: string): HeldCatalog => {
    const envelope = catalogs.get(id);
    if (envelope === undefined) return refuseCoverage("trust_pending");
    if (ready.has(id)) return envelope;
    if (visiting.has(`c:${id}`)) refuseCoverage("invalid_catalog_transition");
    visiting.add(`c:${id}`);
    const c = envelope.catalog, binding = bindingFor(c.binding);
    if (!verifyCatalogEnvelope(envelope, binding.key)) refuseCoverage("invalid_catalog_signature");
    if (c.entries.some((item) => item.serviceId !== binding.serviceId || item.serviceKey !== binding.serviceKey)) refuseCoverage("wrong_catalog_scope");
    if (c.previous !== null) {
      const prior = catalogFor(c.previous).catalog;
      if (prior.binding !== c.binding || c.revision !== prior.revision + 1 || !safe(prior.revision + 1) ||
        !inventoryExtends(prior.entries, c.entries)) refuseCoverage("invalid_catalog_transition");
    } else if (binding.inventory !== null && catalogInventoryId(c.entries) !== binding.inventory) refuseCoverage("invalid_catalog_transition");
    visiting.delete(`c:${id}`); ready.add(id);
    return envelope;
  };
  for (const id of [...catalogs.keys()].sort(compareUtf8)) catalogFor(id);
  for (const id of [...rotations.keys()].sort(compareUtf8)) bindingFor(id);
  // CatalogTrust route history: across every held catalog a route names one replica. The resolver exempts entry-pending
  // catalogs; without entry observation (row 354) this mirror holds every catalog to it, which can only refuse more.
  const routes = new Map<string, string>();
  for (const id of [...catalogs.keys()].sort(compareUtf8)) {
    for (const entry of catalogs.get(id)!.catalog.entries) {
      const replica = routes.get(entry.route);
      if (replica === undefined) routes.set(entry.route, entry.replica);
      else if (replica !== entry.replica) refuseCoverage("invalid_catalog_transition");
    }
  }
}

const extendedKeys = ["root", "genesis", "creation", "reference", "kind", "schema"] as const;
function inventoryExtends(before: readonly CatalogEntry[], after: readonly CatalogEntry[]): boolean {
  return before.every((entry) => {
    const next = after.find((item) => item.replica === entry.replica);
    return next !== undefined && extendedKeys.every((key) => entry[key] === next[key]);
  });
}

function honoredAtPrefix(history: JudgedHistory, id: string, replica: string): boolean {
  const closure = ancestors(id, history.byId, new Map());
  const frames = history.frames.filter((frame) => frame.id === id || closure.has(frame.id));
  return !judge(frames, replica).quarantineReasons.has(id);
}

// Omitting a known head would author a sibling (catalog_fork); any other mismatch is wrong.
function cover<T>(expected: readonly T[], supplied: readonly T[], key: (value: T) => string): string | null {
  const want = expected.map(key).sort(compareUtf8), have = supplied.map(key).sort(compareUtf8);
  if (same(want, have)) return null;
  return want.some((value) => !have.includes(value)) ? "catalog_fork" : "invalid_catalog_transition";
}

// The Space cutoff is the frozen pre-action history itself, so it never includes the action.
async function deriveCutoffs(replica: string, space: TreehouseCatalogReplacementHistory, request: TreehouseCatalogReplacementRequest):
  Promise<{ok: true; cutoffs: CatalogCutoff[]} | Refusal> {
  const supplied = Object.keys(request.replicaHistories);
  const replicas = [replica, ...supplied].sort(compareUtf8);
  if (supplied.includes(replica) || !same(replicas, request.entries.map((item) => item.replica).sort(compareUtf8))) {
    return refuse("recovery_incomplete");
  }
  const cutoffs: CatalogCutoff[] = [];
  for (const item of replicas) {
    const retained = item === replica ? space : request.replicaHistories[item]!;
    if (!object(retained) || !Array.isArray(retained.frames) || !Array.isArray(retained.rejected)) return refuse("recovery_incomplete");
    const derived = await deriveTreehouseCatalogCutoff({replica: item, frames: retained.frames, rejected: retained.rejected});
    if (!derived.ok) return refuse(derived.reason);
    cutoffs.push(derived.cutoff);
  }
  return {ok: true, cutoffs};
}

async function intent(claim: CatalogReplacementClaim, catalog: string, service: string, signer: CarrierOpSigner): Promise<CarrierOpFrame> {
  const body: CarrierTerm = ["tuple", [["atom", "replace_catalog_v1"], ["list", [catalogReplacementClaimToCarrierTerm(claim)!,
    ["bin", catalog], ["bin", service]]]]];
  return authorCarrierOp({replica: claim.space, deps: [...claim.deps], kind: "command", cap: townshipCapTerm(claim.cap), body, signer});
}

// --- author -------------------------------------------------------------------

async function read(source: () => TreehouseCatalogReplacementCurrent | Promise<TreehouseCatalogReplacementCurrent>, replica: string):
  Promise<{ok: true; raw: TreehouseCatalogReplacementHistory; history: JudgedHistory} | Refusal> {
  let raw: TreehouseCatalogReplacementHistory;
  try {
    const value = await source();
    raw = Array.isArray(value) ? {frames: value, rejected: []} : value as TreehouseCatalogReplacementHistory;
    if (!object(raw) || !Array.isArray(raw.frames) || !Array.isArray(raw.rejected)) return refuse("stale_verified_state");
  } catch { return refuse("stale_verified_state"); }
  const history = await authenticateJudgedHistory(replica, raw.frames);
  // Retained bad-signature evidence is validated on every read, as BEAM's Log.verify_authenticity does.
  const evidence = await deriveTreehouseCatalogCutoff({replica, frames: raw.frames, rejected: raw.rejected});
  if (!evidence.ok && evidence.reason === "invalid_verified_history") return refuse("invalid_verified_history");
  return history === null ? refuse("invalid_verified_history") : {ok: true, raw, history};
}

// C13: an op honored in the frozen analysis that the union quarantines, a moved admin holder epoch,
// or a Core refusal of the action itself on the union cancels the attempt.
async function reclassified(current: JudgedHistory, attempt: TreehouseCatalogReplacementAttempt, signed: CarrierOpFrame | null): Promise<string | null> {
  if (attempt.frozenFrontier.length === 0 || attempt.frozenFrontier.some((id) => !current.byId.has(id))) return "stale_verified_state";
  const closure = new Set(attempt.frozenFrontier);
  const cache = new Map<string, Set<string>>();
  for (const id of attempt.frozenFrontier) for (const ancestor of ancestors(id, current.byId, cache)) closure.add(ancestor);
  const frozen = judge(current.frames.filter((frame) => closure.has(frame.id)), attempt.replica);
  const union = signed === null || current.byId.has(signed.id) ? current
    : await authenticateJudgedHistory(attempt.replica, [...current.frames, signed]);
  if (union === null) return "authority_changed";
  if ([...closure].some((id) => !frozen.quarantineReasons.has(id) && union.projection.quarantineReasons.has(id))) return "authority_changed";
  const acquire = union.authority.acquiresByRole.get("admin")?.at(-1);
  if (acquire?.opId !== attempt.claim.holderEpoch || acquire.holderPubkey !== attempt.author) return "authority_changed";
  if (signed !== null) return union.projection.quarantineReasons.has(signed.id) ? "authority_changed" : null;
  const zeroB64 = b64(zero());
  const placeholder = await intent(attempt.claim, zeroB64, zeroB64, {publicKey: base64ToBytes(attempt.author), sign: zero});
  const reason = (await judgeCandidate(union.frames, placeholder)).quarantineReasons.get(placeholder.id);
  return reason === "application_invalid_catalog" ? null : "authority_changed";
}

// Every changed dep, key, cutoff, inventory or acquisition changes these bytes.
function samePrepared(fresh: Prepared, attempt: TreehouseCatalogReplacementAttempt): boolean {
  return equalBytes(canonicalBytesForCatalogReplacementClaim(attempt.claim), fresh.claimBytes) && fresh.attemptId === attempt.attemptId && fresh.author === attempt.author && fresh.cap === attempt.cap &&
    same(fresh.frozenFrontier, attempt.frozenFrontier) && equalBytes(fresh.claimBytes, attempt.claimBytes) &&
    equalBytes(fresh.catalogPossessionBytes, attempt.catalogPossessionBytes) &&
    equalBytes(fresh.servicePossessionBytes, attempt.servicePossessionBytes);
}

function attemptShape(value: unknown): value is TreehouseCatalogReplacementAttempt {
  if (!object(value)) return false;
  const attempt = value as Partial<TreehouseCatalogReplacementAttempt>;
  return typeof attempt.attemptId === "string" && typeof attempt.replica === "string" && object(attempt.request) &&
    normalizeCatalogReplacementClaim(attempt.claim) !== null && attempt.claimBytes instanceof Uint8Array &&
    attempt.catalogPossessionBytes instanceof Uint8Array && attempt.servicePossessionBytes instanceof Uint8Array &&
    typeof attempt.author === "string" && typeof attempt.cap === "string" && Array.isArray(attempt.frozenFrontier);
}

function requestShape(value: unknown): value is TreehouseCatalogReplacementRequest {
  if (!object(value) || !same(Object.keys(value).sort(), requestFields)) return false;
  return typeof value.author === "string" && canonicalBase64Bytes(value.author, 32) !== null &&
    Array.isArray(value.entries) && object(value.replicaHistories) && Array.isArray(value.rotations) && Array.isArray(value.catalogs);
}

function entry(attempt: Prepared | null, status: TreehouseCatalogReplacementStatus, reason: string | null,
  opId: string | null): TreehouseCatalogReplacementJournalEntry {
  return {attemptId: attempt?.attemptId ?? null, claimBytes: attempt?.claimBytes ?? null, status, reason, opId};
}

// --- judged history (local copies of the member-continuity helpers) -------------

type JudgedHistory = NonNullable<Awaited<ReturnType<typeof authenticateJudgedHistory>>>;
async function authenticateJudgedHistory(replica: string, values: readonly unknown[]) {
  const frames = structuredClone(values).map(decodeCarrierOpFrame);
  const ids = new Set(frames.map((frame) => frame.id));
  if (ids.size !== frames.length || frames.some((frame) => frame.replica !== replica || frame.deps.some((dep) => !ids.has(dep)))) return null;
  for (const frame of frames) {
    if (!(await verifyCarrierOp(frame, {verify: async (author, bytes, signature) =>
      verifyEd25519(signature, bytes, base64ToBytes(author))})).valid) return null;
  }
  const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"));
  const byId = new Map(ops.map((op) => [op.id, op])); const order = canonicalOrder(ops, byId);
  if (order.length !== ops.length) return null;
  const projection = materialize(treehouseSpaceSchema, ops, ids, null, replica);
  const authority = analyzeAuthority(treehouseSpaceSchema, ops, ids, order, byId, replica);
  return {frames, ops, byId, order, projection, authority, frontier: frontier(ops).sort(compareUtf8)};
}
function judge(frames: readonly CarrierOpFrame[], replica: string) {
  const ops = carrierOpsToSemanticOps([...frames], {}, treehouseCommandDecoders("Treehouse.Space"));
  return materialize(treehouseSpaceSchema, ops, new Set(ops.map((op) => op.id)), null, replica);
}
async function judgeCandidate(values: readonly unknown[], frame: CarrierOpFrame) {
  return judge([...values.map(decodeCarrierOpFrame), frame], frame.replica);
}
function envelopeBytes(frame: CarrierOpFrame): number {
  return new TextEncoder().encode(JSON.stringify({type: "push", ops: [frame]})).length;
}
function b64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
