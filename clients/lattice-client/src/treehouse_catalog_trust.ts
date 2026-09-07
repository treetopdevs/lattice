import type { CatalogCutoff } from "./treehouse_catalog_codec";

// This module proposes decisions over an adapter-owned complete snapshot. It
// performs no I/O, proves no CAS/freshness/readiness, and never issues a durable
// installation receipt. The expected token is reflected for the trusted adapter
// to compare atomically with both trust and history generations.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalBase64Bytes, canonicalBytesForCarrierOp, canonicalHash } from "./codec";
import { carrierOpsToSemanticOps, decodeCarrierOpFrame } from "./carrier";
import type { CarrierOpFrame } from "./carrier";
import { analyzeAuthority, continuationFamily, resolveContinuationProfileFromFrames } from "./authority";
import { canonicalOrder, index } from "./dag";
import { compareUtf8 } from "./op";
import type { Op } from "./op";
import { materialize } from "./materialize";
import { treehouseCatalogBootstrapsFromFrames, treehouseCommandDecoders, treehouseSpaceSchema, treehouseThreadSchema } from "./treehouse";
import { deriveTreehouseCatalogCutoff } from "./treehouse_catalog_cutoff";
import { catalogEnvelopeFromCarrierTerm, catalogRotationEnvelopeFromCarrierTerm, catalogInventoryId, catalogRotationId,
  catalogServiceRealm, normalizeCatalogBootstrap, normalizeCatalogCutoff, transportCatalogId,
  verifyCatalogEnvelope, verifyCatalogRotationEnvelope, canonicalBytesForCatalogRotation } from "./treehouse_catalog_codec";
import type { CatalogBootstrap, CatalogEntry, CatalogEnvelope, CatalogRotationEnvelope } from "./treehouse_catalog_codec";

export interface TreehouseCatalogRawHistory {
  replica: string; frames: readonly unknown[];
  rejected: readonly {frame: unknown; reason: "bad_signature"}[];
}
export interface TreehouseCatalogBootstrapReview {
  version: 1; product: "treehouse"; space: string; spaceRoot: string;
  bootstrapId: string; observedBootstrapIds: string[];
  disposition: "pin_exact_observed_bootstrap";
}
export interface TreehouseCatalogCutoffProof { cutoff: CatalogCutoff; history: TreehouseCatalogRawHistory; }
export interface TreehouseCatalogEvidencePage {
  catalogs: readonly string[]; rotations: readonly string[];
  histories: readonly TreehouseCatalogRawHistory[]; cutoffProofs: readonly TreehouseCatalogCutoffProof[];
}
export interface TreehouseCatalogStoreToken { trustRevision: number; historyGeneration: number; }
export interface TreehouseCatalogWatermark { binding: string; generation: number; catalog: string; revision: number; }
export interface TreehouseCatalogOverflowTrigger { kind: "catalog" | "rotation"; id: string; digest: string; bytes: number; }
export interface TreehouseCatalogBlock {
  reason: "catalog_fork" | "authority_changed" | "control_history_limit";
  bindings: string[]; catalogs: string[]; bootstrapIds: string[]; opIds: string[];
  pendingProofIds: string[]; triggers: TreehouseCatalogOverflowTrigger[];
  /** Authenticated prior causal refusals, not a timestamp or proof of store provenance. */
  authorityWitnesses: {replica: string; frontier: string[]; opIds: string[]}[];
}
export interface InstalledTreehouseCatalogTrustV1 {
  version: 1; review: TreehouseCatalogBootstrapReview;
  histories: TreehouseCatalogRawHistory[];
  catalogs: {id: string; json: string}[]; rotations: {id: string; json: string}[];
  cutoffProofs: TreehouseCatalogCutoffProof[];
  accepted: TreehouseCatalogWatermark | null; blocked: TreehouseCatalogBlock | null;
}
export type TreehouseCatalogTrustReason = "malformed_catalog" | "control_history_limit" | "wrong_catalog_scope" |
  "trust_pending" | "invalid_catalog_signature" | "invalid_possession" | "catalog_authority_refused" |
  "invalid_catalog_transition" | "catalog_rollback" | "catalog_fork" | "recovery_incomplete" |
  "carrier_pending" | "authority_changed" | "invalid_verified_history" | "unsupported_cutoff" |
  "trust_recovery_required" | "stale_trust_snapshot" | "trust_persistence_failed";
export interface TreehouseCatalogRefusalDetail { ids: string[]; coreReason: string | null; pendingProofIds: string[]; }
export interface VerifiedTreehouseCatalogRoute {
  replica: string; kind: "space" | "thread"; schema: "treehouse_space_v1" | "treehouse_thread_v1";
  root: string; genesis: string; creation: string; reference: string;
  binding: string; catalog: string; revision: number;
  origin: string; path: string; url: string; serviceId: string; serviceKey: string; realm: string;
}
export type TreehouseCatalogTrustDecision =
  | {kind: "reject"; reason: TreehouseCatalogTrustReason; detail: TreehouseCatalogRefusalDetail}
  | {kind: "unchanged" | "propose" | "retain_blocked"; expected: TreehouseCatalogStoreToken;
      next: InstalledTreehouseCatalogTrustV1; reason: TreehouseCatalogTrustReason | null;
      detail: TreehouseCatalogRefusalDetail;
      /** Profile equality only; no cap, acquisition, epoch or replacement readiness proof. */
      replacementConfigured: boolean;
      observed: {bootstrapIds: string[]; bindingHeads: string[]; catalogHeads: {binding: string; catalogs: string[]}[]};
      routes: VerifiedTreehouseCatalogRoute[]};
export type TreehouseCatalogRouteDecision =
  | {ok: true; candidate: VerifiedTreehouseCatalogRoute; installationRequired: true}
  | {ok: false; reason: TreehouseCatalogTrustReason | "thread_not_authorized" | "thread_unavailable"};

/** Pure preparation only. The trusted adapter, not this caller flag, proves fresh storage. */
export async function prepareTreehouseCatalogInstallation(input: {
  review: TreehouseCatalogBootstrapReview; history: TreehouseCatalogRawHistory;
  store: {kind: "verified_fresh"; expected: TreehouseCatalogStoreToken};
}): Promise<TreehouseCatalogTrustDecision> {
  try {
    const value = copyInput(input);
    if (!closed(value, ["review", "history", "store"]) || !reviewValid(value.review) ||
      !closed(value.store, ["kind", "expected"]) || value.store.kind !== "verified_fresh" || !tokenValid(value.store.expected)) fail("malformed_catalog");
    const history = await observeHistory(value.history);
    if (history.raw.replica !== value.review.space) fail("wrong_catalog_scope");
    const observed = await treehouseCatalogBootstrapsFromFrames(history.raw);
    if (!observed.ok) fail("invalid_verified_history");
    const selected = observed.bootstraps.find((b) => b.id === value.review.bootstrapId);
    if (selected === undefined) {
      if (!history.byId.has(value.review.bootstrapId)) fail("trust_pending", [value.review.bootstrapId]);
      throw new Refusal("catalog_authority_refused", detail([value.review.bootstrapId], history.projection.quarantineReasons.get(value.review.bootstrapId) ?? null));
    }
    if (selected.record.spaceRoot !== value.review.spaceRoot || selected.record.space !== value.review.space) fail("wrong_catalog_scope");
    const ids = sorted(observed.bootstraps.map((b) => b.id));
    if (!equal(ids, value.review.observedBootstrapIds)) fail("catalog_fork", ids);
    const profile = await resolveContinuationProfileFromFrames(history.raw);
    if (!profile.ok || profile.root !== value.review.spaceRoot || profile.profileGenesis !== selected.record.profileGenesis ||
      profile.profileId !== selected.record.profileId) fail("wrong_catalog_scope");
    const next: InstalledTreehouseCatalogTrustV1 = {version: 1, review: value.review, histories: [history.raw],
      catalogs: [], rotations: [], cutoffProofs: [], accepted: null, blocked: null};
    return issue("propose", value.store.expected, next, null, true, ids, [selected.id], [], []);
  } catch (error) { return rejection(error); }
}

/** Pure authenticated decision over a caller-supplied current retained store snapshot. */
export async function evaluateTreehouseCatalogTrust(input: {
  installed: InstalledTreehouseCatalogTrustV1; expected: TreehouseCatalogStoreToken; incoming: TreehouseCatalogEvidencePage;
}): Promise<TreehouseCatalogTrustDecision> {
  try {
    if (!closed(input, ["installed", "expected", "incoming"])) fail("malformed_catalog");
    let original: InstalledTreehouseCatalogTrustV1;
    try {
      original = copyInput(ownValue(input, "installed"));
      if (!stateValid(original)) fail("trust_recovery_required");
    } catch { fail("trust_recovery_required"); }
    // Capture both origins synchronously. Incoming cloning errors must not hide
    // saved corruption, nor may callers mutate a page while saved validation awaits.
    let candidate: Pick<typeof input, "expected" | "incoming"> | undefined, candidateError: unknown;
    try { candidate = copyInput({expected: ownValue(input, "expected"), incoming: ownValue(input, "incoming")}); }
    catch (error) { candidateError = error; }
    const checked = await evaluateSnapshot({installed: original, expected: {trustRevision: 0, historyGeneration: 0},
      incoming: {catalogs: [], rotations: [], histories: [], cutoffProofs: []}}, true);
    if (checked.kind === "reject") throw new Refusal("trust_recovery_required", checked.detail);
    if (candidate === undefined) throw candidateError;
    return await evaluateSnapshot({installed: original, ...candidate}, false);
  } catch (error) { return rejection(error); }
}

// One graph/proof algorithm for both origins. The first pass has no incoming
// evidence, no promotion and no sticky-block error fallback.
async function evaluateSnapshot(value: {
  installed: InstalledTreehouseCatalogTrustV1; expected: TreehouseCatalogStoreToken; incoming: TreehouseCatalogEvidencePage;
}, originalOnly: boolean): Promise<TreehouseCatalogTrustDecision> {
  let frozen: {next: InstalledTreehouseCatalogTrustV1; expected: TreehouseCatalogStoreToken; replacement: boolean; bootstrapIds: string[]} | undefined;
  try {
    if (!closed(value, ["installed", "expected", "incoming"]) || !tokenValid(value.expected) || !pageValid(value.incoming)) fail("malformed_catalog");
    if (!stateValid(value.installed)) fail("trust_recovery_required");
    const original = value.installed;
    const next = structuredClone(original);
    const histories = await mergeHistories(original.histories, value.incoming.histories);
    validateStoredClosure(original);
    next.histories = [...histories.values()].map((h) => h.raw).sort((a, b) => compareUtf8(a.replica, b.replica));
    const space = histories.get(original.review.space);
    if (space === undefined) fail("trust_recovery_required");
    const selected = space.byId.get(original.review.bootstrapId);
    const bootstrap = selected?.command === "catalog_bootstrap_v1" ? normalizeCatalogBootstrap(selected.commandArgs?.[0]) : null;
    if (bootstrap === null || bootstrap.space !== original.review.space || bootstrap.spaceRoot !== original.review.spaceRoot ||
      space.analysis.security.root?.pubkey !== original.review.spaceRoot) fail("trust_recovery_required");
    if (original.review.observedBootstrapIds.some((id) => space.byId.get(id)?.command !== "catalog_bootstrap_v1")) fail("trust_recovery_required");
    const query = await treehouseCatalogBootstrapsFromFrames(space.raw);
    if (!query.ok) fail("invalid_verified_history");
    const bootstrapIds = sorted(query.bootstraps.map((b) => b.id));
    const profile = await resolveContinuationProfileFromFrames(space.raw);
    const replacement = profile.ok && profile.root === bootstrap.spaceRoot && profile.profileGenesis === bootstrap.profileGenesis && profile.profileId === bootstrap.profileId;
    // Reclassify accepted evidence before examining a candidate: an invalid new
    // artifact must not hide a security event established by the full raw union.
    const refused = selected !== undefined && space.projection.quarantineReasons.has(selected.id) ? [selected.id] : [];
    if (original.accepted !== null) {
      const stored = original.catalogs.find((c) => c.id === original.accepted!.catalog);
      if (stored === undefined) fail("trust_recovery_required");
      const catalog = parseCatalog(stored.json);
      if (transportCatalogId(catalog.catalog) !== stored.id) fail("trust_recovery_required");
      for (const entry of catalog.catalog.entries) {
        const proof = entryProof(entry, histories, space);
        refused.push(...proof.refused);
        if (proof.invalid || proof.pending.length > 0) fail("trust_recovery_required");
      }
    }
    if (refused.length > 0 && next.blocked?.reason !== "authority_changed") {
      const priorTriggers = next.blocked?.triggers ?? [];
      next.blocked = block("authority_changed", [], [], [], refused);
      next.blocked.triggers = priorTriggers;
      next.blocked.authorityWitnesses = [...histories.values()].flatMap((history) => {
        const opIds = sorted(refused.filter((id) => history.byId.has(id)));
        return opIds.length === 0 ? [] : [{replica: history.raw.replica, frontier: history.frontier, opIds}];
      }).sort((a, b) => compareUtf8(a.replica, b.replica));
    }
    const unseenBootstrapIds = bootstrapIds.filter((id) => !original.review.observedBootstrapIds.includes(id));
    if (unseenBootstrapIds.length > 0 && next.blocked === null) next.blocked = block("catalog_fork", [], [], unseenBootstrapIds);
    if (next.blocked !== null) frozen = {next: structuredClone(next), expected: value.expected, replacement, bootstrapIds};

    const catalogs = new Map<string, CatalogNode>(), rotations = new Map<string, RotationNode>();
    const retainedCatalogIds = new Set(original.catalogs.map((row) => row.id));
    for (const saved of original.catalogs) addCatalog(catalogs, saved.json, bootstrap, original.review.bootstrapId, saved.id);
    for (const saved of original.rotations) addRotation(rotations, saved.json, bootstrap, original.review.bootstrapId, saved.id);
    for (const json of value.incoming.catalogs) addCatalog(catalogs, json, bootstrap, original.review.bootstrapId);
    for (const json of value.incoming.rotations) addRotation(rotations, json, bootstrap, original.review.bootstrapId);
    const acceptedCatalogIds = new Set<string>(), acceptedBindingIds = new Set<string>();
    const pendingCatalogs = original.accepted === null ? [] : [original.accepted.catalog];
    const pendingBindings = original.accepted === null ? [] : [original.accepted.binding];
    while (pendingCatalogs.length > 0 || pendingBindings.length > 0) {
      const catalogId = pendingCatalogs.pop();
      if (catalogId !== undefined && !acceptedCatalogIds.has(catalogId)) {
        const node = catalogs.get(catalogId);
        if (node === undefined) fail("trust_recovery_required");
        acceptedCatalogIds.add(catalogId); pendingBindings.push(node.envelope.catalog.binding);
        if (node.envelope.catalog.previous !== null) pendingCatalogs.push(node.envelope.catalog.previous);
      }
      const bindingId = pendingBindings.pop();
      if (bindingId !== undefined && bindingId !== original.review.bootstrapId && !acceptedBindingIds.has(bindingId)) {
        const node = rotations.get(bindingId);
        if (node === undefined) fail("trust_recovery_required");
        acceptedBindingIds.add(bindingId); pendingBindings.push(node.envelope.rotation.parent);
        pendingCatalogs.push(node.envelope.rotation.priorCatalog);
      }
    }
    const bindings = new Map<string, Binding>([[original.review.bootstrapId, {id: original.review.bootstrapId, generation: 0,
      key: bootstrap.catalogKey, parent: null, prior: null, pending: [], inventory: null}]]);
    const visiting = new Set<string>();
    const catalogReady = new Set<string>();
    const bindingFor = (id: string): Binding => {
      const known = bindings.get(id);
      if (known !== undefined) return known;
      if (visiting.has(id)) fail("invalid_catalog_transition", [id]);
      const node = rotations.get(id);
      if (node === undefined) fail("trust_pending", [id]);
      visiting.add(id);
      const r = node.envelope.rotation, parent = bindingFor(r.parent);
      if (r.newCatalogKey === bootstrap.serviceKey || r.generation !== parent.generation + 1 || !safe(parent.generation + 1)) fail("invalid_catalog_transition", [id]);
      if (!verifyCatalogRotationEnvelope(node.envelope, parent.key)) {
        // Distinguish old signer authorization from possession under the new key.
        const old = canonicalBase64Bytes(node.envelope.oldSignature, 64)!, pub = canonicalBase64Bytes(parent.key, 32)!;
        const bytes = canonicalBytesForCatalogRotation(node.envelope.rotation);
        if (!ed25519.verify(old, bytes, pub, {zip215: false})) fail("invalid_catalog_signature", [id]);
        fail("invalid_possession", [id]);
      }
      node.authenticated = true;
      const prior = catalogFor(r.priorCatalog);
      if (prior.envelope.catalog.binding !== r.parent || catalogInventoryId(prior.envelope.catalog.entries) !== r.inventoryDigest ||
        !equal(r.cutoffs.map((c) => c.replica), prior.envelope.catalog.entries.map((e) => e.replica))) fail("invalid_catalog_transition", [id]);
      const binding: Binding = {id, generation: r.generation, key: r.newCatalogKey, parent: r.parent, prior: r.priorCatalog,
        inventory: r.inventoryDigest, pending: [...prior.pending]};
      bindings.set(id, binding);
      visiting.delete(id);
      return binding;
    };
    const catalogFor = (id: string): CatalogNode => {
      const node = catalogs.get(id);
      if (node === undefined) fail("trust_pending", [id]);
      if (catalogReady.has(id)) return node;
      if (visiting.has(id)) fail("invalid_catalog_transition", [id]);
      visiting.add(id);
      const c = node.envelope.catalog, binding = bindingFor(c.binding);
      if (!verifyCatalogEnvelope(node.envelope, binding.key)) fail("invalid_catalog_signature", [id]);
      node.authenticated = true;
      if (c.entries.some((e) => e.serviceId !== bootstrap.serviceId || e.serviceKey !== bootstrap.serviceKey)) fail("wrong_catalog_scope", [id]);
      if (c.previous !== null) {
        const prior = catalogFor(c.previous).envelope.catalog;
        if (prior.binding !== c.binding || c.revision !== prior.revision + 1 || !safe(prior.revision + 1) || !inventoryExtends(prior.entries, c.entries)) fail("invalid_catalog_transition", [id]);
      } else if (binding.inventory !== null && catalogInventoryId(c.entries) !== binding.inventory) fail("invalid_catalog_transition", [id]);
      const retainedDiagnostic = original.blocked !== null && !acceptedCatalogIds.has(id) && retainedCatalogIds.has(id);
      for (const entry of c.entries) {
        const proof = entryProof(entry, histories, space);
        if ((proof.invalid && !retainedDiagnostic) ||
          (proof.refused.length > 0 && next.blocked?.reason !== "authority_changed" && !retainedDiagnostic)) {
          fail("invalid_catalog_transition", [id, ...proof.refused]);
        }
        // Previously retained frozen siblings can acquire contradictory proof.
        // Keep those signed facts diagnostic; they cannot reserve a route.
        if (proof.invalid) node.pending.push(entry.genesis, entry.creation, entry.reference);
        if (retainedDiagnostic) node.pending.push(...proof.refused);
        node.pending.push(...proof.pending);
      }
      node.pending = sorted(node.pending);
      visiting.delete(id); catalogReady.add(id);
      return node;
    };
    for (const id of sorted(catalogs.keys())) catalogFor(id);
    for (const id of sorted(rotations.keys())) bindingFor(id);

    next.catalogs = [...catalogs.values()].map((n) => ({id: n.id, json: n.json})).sort(byId);
    next.rotations = [...rotations.values()].map((n) => ({id: n.id, json: n.json})).sort(byId);
    next.cutoffProofs = await mergeProofs(original.cutoffProofs, value.incoming.cutoffProofs, histories);
    for (const [id, binding] of bindings) {
      if (binding.parent === null) continue;
      const r = rotations.get(id)!.envelope.rotation;
      for (const cutoff of r.cutoffs) if (!next.cutoffProofs.some((p) => equal(p.cutoff, cutoff))) binding.pending.push(cutoff.logDigest);
      binding.pending = sorted(binding.pending);
    }
    for (const binding of [...bindings.values()].sort((a, b) => a.generation - b.generation)) {
      if (binding.parent !== null) binding.pending = sorted([...binding.pending, ...bindings.get(binding.parent)!.pending]);
    }
    const groups = new Map<string, CatalogNode[]>();
    for (const node of catalogs.values()) {
      const key = node.envelope.catalog.binding;
      groups.set(key, [...(groups.get(key) ?? []), node]);
    }
    const catalogHeads = [...groups].map(([binding, nodes]) => ({binding,
      catalogs: sorted(nodes.filter((n) => !nodes.some((child) => child.envelope.catalog.previous === n.id)).map((n) => n.id))})).sort((a, b) => compareUtf8(a.binding, b.binding));
    const parents = new Set([...bindings.values()].flatMap((b) => b.parent === null ? [] : [b.parent]));
    const heads = sorted([...bindings.keys()].filter((id) => !parents.has(id)));
    const forks = catalogHeads.filter((g) => g.catalogs.length > 1).flatMap((g) => g.catalogs);
    for (const binding of bindings.values()) if (binding.parent !== null) {
      const prior = binding.prior!;
      for (const node of groups.get(binding.parent) ?? []) {
        if (node.id !== prior && catalogAncestor(prior, node.id, catalogs)) forks.push(node.id, prior);
      }
    }
    const pendingIds = sorted([...catalogs.values()].filter((n) => n.pending.length > 0).map((n) => n.id));
    if (heads.length > 2 && next.blocked?.reason !== "authority_changed") next.blocked = block("control_history_limit", heads, forks, [], [], pendingIds);
    else if (next.blocked === null && (heads.length > 1 || forks.length > 0)) next.blocked = block("catalog_fork", heads, forks, [], [], pendingIds);
    // Pending signed nodes are retained but their unproven entries reserve no route.
    const routesUsed = new Map<string, string>();
    for (const node of catalogs.values()) if (node.pending.length === 0) for (const entry of node.envelope.catalog.entries) {
      const previous = routesUsed.get(entry.route);
      if (previous !== undefined && previous !== entry.replica) fail("invalid_catalog_transition", [node.id]);
      routesUsed.set(entry.route, entry.replica);
    }
    if (original.accepted !== null) {
      const saved = catalogs.get(original.accepted.catalog), binding = bindings.get(original.accepted.binding);
      if (saved === undefined || binding === undefined || saved.envelope.catalog.binding !== binding.id ||
        saved.envelope.catalog.revision !== original.accepted.revision || binding.generation !== original.accepted.generation ||
        saved.pending.length > 0 || binding.pending.length > 0) fail("trust_recovery_required");
    }
    if (originalOnly) {
      await validateStoredBlock(original, next.blocked, catalogs, bindings, histories);
      if (original.cutoffProofs.length !== next.cutoffProofs.length) fail("trust_recovery_required");
      return issue("unchanged", value.expected, original, original.blocked?.reason ?? null, replacement, bootstrapIds, heads, catalogHeads, []);
    }
    // Validate every original/candidate graph and proof before a budget shortcut.
    // An exhausted page stays wholly unadmitted; all its distinct trigger metadata
    // proves the excess against the original set, including 1023 + two records.
    const retained = [...original.catalogs.map((a) => ({kind: "catalog" as const, ...a})), ...original.rotations.map((a) => ({kind: "rotation" as const, ...a}))];
    const have = new Set(retained.map((a) => `${a.kind}:${a.id}`));
    const additions = [...next.catalogs.map((a) => ({kind: "catalog" as const, ...a})), ...next.rotations.map((a) => ({kind: "rotation" as const, ...a}))]
      .filter((a) => !have.has(`${a.kind}:${a.id}`)).sort((a, b) => compareUtf8(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`));
    const bytes = retained.reduce((n, a) => n + encoder.encode(a.json).length, 0);
    const overflow = retained.length + additions.length > 1024 || bytes + additions.reduce((n, a) => n + encoder.encode(a.json).length, 0) > 16 * 1024 * 1024;
    if ((original.blocked?.triggers.length ?? 0) > 0 || overflow) {
      next.catalogs = original.catalogs; next.rotations = original.rotations; next.cutoffProofs = original.cutoffProofs;
      const triggers = original.blocked?.triggers.length ? original.blocked.triggers : additions.map((a) => ({kind: a.kind, id: a.id,
        digest: hash(encoder.encode(a.json)), bytes: encoder.encode(a.json).length}));
      if (next.blocked?.reason !== "authority_changed") next.blocked = block("control_history_limit", [], [], []);
      next.blocked.triggers = triggers;
      return issue("retain_blocked", value.expected, next, next.blocked.reason, replacement, bootstrapIds, [], [], []);
    }
    if (next.blocked !== null) return issue("retain_blocked", value.expected, next, next.blocked.reason, replacement, bootstrapIds, heads, catalogHeads, []);
    const head = bindings.get(heads[0]!)!;
    const latestId = catalogHeads.find((g) => g.binding === head.id)?.catalogs[0];
    const latest = latestId === undefined ? undefined : catalogs.get(latestId)!;
    let reason: TreehouseCatalogTrustReason | null = null;
    if (head.pending.length > 0) reason = "recovery_incomplete";
    else if (latest === undefined || latest.pending.length > 0) reason = "trust_pending";
    else next.accepted = {binding: head.id, generation: head.generation, catalog: latest.id, revision: latest.envelope.catalog.revision};
    const routes = next.accepted === null ? [] : catalogRoutes(catalogs.get(next.accepted.catalog)!, bindings.get(next.accepted.binding)!, bootstrap);
    return issue(equal(next, original) ? "unchanged" : "propose", value.expected, next, reason, replacement, bootstrapIds, heads, catalogHeads, routes);
  } catch (error) {
    if (!originalOnly && frozen !== undefined) return issue("retain_blocked", frozen.expected, frozen.next, frozen.next.blocked!.reason,
      frozen.replacement, frozen.bootstrapIds, frozen.next.blocked!.bindings, [], []);
    return rejection(error);
  }
}

/** Candidate only: the adapter must persist the exact decision before using transport. */
export function resolveTreehouseCatalogRoute(input: {decision: TreehouseCatalogTrustDecision; replica: string}): TreehouseCatalogRouteDecision {
  const held = decisions.get(input.decision);
  if (held === undefined) return {ok: false, reason: "trust_recovery_required"};
  if (held.blocked !== null) return {ok: false, reason: held.blocked};
  const candidate = held.routes.find((r) => r.replica === input.replica);
  return candidate === undefined ? {ok: false, reason: "thread_unavailable"} : {ok: true, candidate: structuredClone(candidate), installationRequired: true};
}

const encoder = new TextEncoder();
const decisions = new WeakMap<object, {routes: VerifiedTreehouseCatalogRoute[]; blocked: TreehouseCatalogTrustReason | null}>();
const detail = (ids: string[] = [], coreReason: string | null = null, pendingProofIds: string[] = []): TreehouseCatalogRefusalDetail => ({ids: sorted(ids), coreReason, pendingProofIds: sorted(pendingProofIds)});
class Refusal extends Error { constructor(readonly reason: TreehouseCatalogTrustReason, readonly info = detail()) { super(reason); } }
function fail(reason: TreehouseCatalogTrustReason, ids: string[] = []): never { throw new Refusal(reason, detail(ids)); }
function rejection(error: unknown): TreehouseCatalogTrustDecision {
  return error instanceof Refusal ? {kind: "reject", reason: error.reason, detail: error.info} : {kind: "reject", reason: "malformed_catalog", detail: detail()};
}
function issue(kind: "unchanged" | "propose" | "retain_blocked", expected: TreehouseCatalogStoreToken, next: InstalledTreehouseCatalogTrustV1,
  reason: TreehouseCatalogTrustReason | null, replacementConfigured: boolean, bootstrapIds: string[], bindingHeads: string[],
  catalogHeads: {binding: string; catalogs: string[]}[], routes: VerifiedTreehouseCatalogRoute[]): TreehouseCatalogTrustDecision {
  const result = {kind, expected, next, reason, replacementConfigured, observed: {bootstrapIds, bindingHeads, catalogHeads},
    detail: detail(next.blocked?.opIds, null, next.blocked?.pendingProofIds), routes};
  decisions.set(result, {routes: structuredClone(routes), blocked: next.blocked?.reason ?? null});
  return result;
}
function block(reason: TreehouseCatalogBlock["reason"], bindings: string[], catalogs: string[], bootstrapIds: string[], opIds: string[] = [], pendingProofIds: string[] = []): TreehouseCatalogBlock {
  return {reason, bindings: sorted(bindings), catalogs: sorted(catalogs), bootstrapIds: sorted(bootstrapIds), opIds: sorted(opIds), pendingProofIds: sorted(pendingProofIds), triggers: [], authorityWitnesses: []};
}
function closed(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === names.length && Object.keys(value).every((key) => names.includes(key));
}
function ownValue<T, K extends keyof T>(value: T, key: K): T[K] {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) fail("malformed_catalog");
  return descriptor.value;
}
function copyInput<T>(input: T): T {
  const pending: {value: unknown; leave: boolean}[] = [{value: input, leave: false}];
  const active = new Set<object>(), finished = new Set<object>();
  while (pending.length > 0) {
    const {value, leave} = pending.pop()!;
    if (leave && typeof value === "object" && value !== null) { active.delete(value); finished.add(value); continue; }
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") continue;
    if (typeof value !== "object" || active.has(value)) fail("malformed_catalog");
    if (finished.has(value)) continue;
    active.add(value); pending.push({value, leave: true});
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("malformed_catalog");
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      if (typeof key !== "string") fail("malformed_catalog");
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!Object.hasOwn(descriptor, "value")) fail("malformed_catalog");
      pending.push({value: descriptor.value, leave: false});
    }
  }
  return structuredClone(input);
}
const safe = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(encoder.encode(v)) === v;
const idValid = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v) && canonicalBase64Bytes(v.replaceAll("-", "+").replaceAll("_", "/") + "=", 32) !== null;
const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort(compareUtf8);
// Local structural equality only; signed IDs/bytes always use the existing codec.
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value !== null && typeof value === "object" ?
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareUtf8(a, b)).map(([key, item]) => [key, stable(item)])) : value;
const equal = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const byId = (a: {id: string}, b: {id: string}) => compareUtf8(a.id, b.id);
function tokenValid(v: unknown): v is TreehouseCatalogStoreToken { return closed(v, ["trustRevision", "historyGeneration"]) && safe(v.trustRevision) && safe(v.historyGeneration) && v.trustRevision < Number.MAX_SAFE_INTEGER && v.historyGeneration < Number.MAX_SAFE_INTEGER; }
function reviewValid(v: unknown): v is TreehouseCatalogBootstrapReview {
  return closed(v, ["version", "product", "space", "spaceRoot", "bootstrapId", "observedBootstrapIds", "disposition"]) && v.version === 1 && v.product === "treehouse" &&
    text(v.space) && continuationFamily(v.space) === "space" && canonicalBase64Bytes(v.spaceRoot, 32) !== null && idValid(v.bootstrapId) &&
    v.disposition === "pin_exact_observed_bootstrap" && Array.isArray(v.observedBootstrapIds) && v.observedBootstrapIds.every(idValid) &&
    v.observedBootstrapIds.includes(v.bootstrapId) && equal(v.observedBootstrapIds, sorted(v.observedBootstrapIds));
}
function historyValid(v: unknown): v is TreehouseCatalogRawHistory { return closed(v, ["replica", "frames", "rejected"]) && text(v.replica) && Array.isArray(v.frames) && Array.isArray(v.rejected) &&
  v.rejected.every((r) => closed(r, ["frame", "reason"]) && r.reason === "bad_signature"); }
function pageValid(v: unknown): v is TreehouseCatalogEvidencePage {
  if (!closed(v, ["catalogs", "rotations", "histories", "cutoffProofs"]) || !Array.isArray(v.catalogs) || !Array.isArray(v.rotations) || !Array.isArray(v.histories) || !Array.isArray(v.cutoffProofs)) return false;
  if (v.catalogs.length + v.rotations.length > 32) fail("control_history_limit");
  return v.catalogs.every((s) => typeof s === "string") && v.rotations.every((s) => typeof s === "string") && v.histories.every(historyValid);
}
function stateValid(v: unknown): v is InstalledTreehouseCatalogTrustV1 {
  if (!closed(v, ["version", "review", "histories", "catalogs", "rotations", "cutoffProofs", "accepted", "blocked"]) || v.version !== 1 || !reviewValid(v.review) ||
    !Array.isArray(v.histories) || !v.histories.every(historyValid) || !Array.isArray(v.catalogs) || !Array.isArray(v.rotations) || !Array.isArray(v.cutoffProofs)) return false;
  if (![...v.catalogs, ...v.rotations].every((a) => closed(a, ["id", "json"]) && idValid(a.id) && typeof a.json === "string")) return false;
  if ([v.catalogs, v.rotations].some((a) => new Set(a.map((n) => n.id)).size !== a.length) ||
    v.catalogs.length + v.rotations.length > 1024 || [...v.catalogs, ...v.rotations].reduce((n, a) => n + encoder.encode(a.json).length, 0) > 16 * 1024 * 1024) return false;
  if (v.accepted !== null && (!closed(v.accepted, ["binding", "generation", "catalog", "revision"]) || !idValid(v.accepted.binding) || !idValid(v.accepted.catalog) || !safe(v.accepted.generation) || !safe(v.accepted.revision))) return false;
  if (v.blocked !== null && (!closed(v.blocked, ["reason", "bindings", "catalogs", "bootstrapIds", "opIds", "pendingProofIds", "triggers", "authorityWitnesses"]) ||
    !["catalog_fork", "authority_changed", "control_history_limit"].includes(v.blocked.reason as string) ||
    ![v.blocked.bindings, v.blocked.catalogs, v.blocked.bootstrapIds, v.blocked.opIds, v.blocked.pendingProofIds].every((a) => Array.isArray(a) && a.every(idValid)) || !Array.isArray(v.blocked.triggers) ||
    !Array.isArray(v.blocked.authorityWitnesses) || !v.blocked.authorityWitnesses.every((w) => closed(w, ["replica", "frontier", "opIds"]) && text(w.replica) &&
      Array.isArray(w.frontier) && w.frontier.every(idValid) && Array.isArray(w.opIds) && w.opIds.every(idValid)) ||
    !v.blocked.triggers.every((t) => closed(t, ["kind", "id", "digest", "bytes"]) && (t.kind === "catalog" || t.kind === "rotation") && idValid(t.id) && idValid(t.digest) && safe(t.bytes)))) return false;
  return true;
}
function validateStoredClosure(state: InstalledTreehouseCatalogTrustV1) {
  for (const history of state.histories) {
    const ids = new Set(history.frames.map((frame) => (frame as CarrierOpFrame).id));
    if (history.frames.some((frame) => (frame as CarrierOpFrame).deps.some((id) => !ids.has(id)))) fail("trust_recovery_required");
  }
  const catalogs = new Set(state.catalogs.map((c) => c.id));
  const bindings = new Set([state.review.bootstrapId, ...state.rotations.map((r) => r.id)]);
  for (const artifact of state.catalogs) {
    const c = parseCatalog(artifact.json).catalog;
    if (!bindings.has(c.binding) || (c.previous !== null && !catalogs.has(c.previous))) fail("trust_recovery_required");
  }
  for (const artifact of state.rotations) {
    const r = catalogRotationEnvelopeFromCarrierTerm(parseJson(artifact.json))?.rotation;
    if (r === undefined || !bindings.has(r.parent) || !catalogs.has(r.priorCatalog)) fail("trust_recovery_required");
  }
}
// Block indexes are witnesses, not a cached winner. Historical fork heads may
// acquire descendants, so validate their retained relations rather than equality
// with the current head list. No incoming record can complete these witnesses.
async function validateStoredBlock(state: InstalledTreehouseCatalogTrustV1, derived: TreehouseCatalogBlock | null,
  catalogs: Map<string, CatalogNode>, bindings: Map<string, Binding>, histories: Map<string, ObservedHistory>) {
  const saved = state.blocked;
  if (saved === null) { if (derived !== null) fail("trust_recovery_required"); return; }
  if (![saved.bindings, saved.catalogs, saved.bootstrapIds, saved.opIds, saved.pendingProofIds].every((ids) => equal(ids, sorted(ids))) ||
    saved.bindings.some((id) => !bindings.has(id)) || saved.catalogs.some((id) => !catalogs.has(id)) ||
    saved.pendingProofIds.some((id) => !catalogs.has(id))) fail("trust_recovery_required");
  const emptyIndexes = saved.bindings.length + saved.catalogs.length + saved.bootstrapIds.length + saved.opIds.length + saved.pendingProofIds.length === 0;
  if (saved.triggers.length > 0) {
    // Trigger JSON is deliberately unadmitted. Reopen checks retained budget and
    // canonical metadata; the adapter owns the admission-time authentication proof.
    const keys = saved.triggers.map((t) => `${t.kind}:${t.id}`);
    if ((saved.reason !== "control_history_limit" && saved.reason !== "authority_changed") ||
      (saved.reason === "control_history_limit" && !emptyIndexes) || saved.triggers.length > 32 || !equal(keys, sorted(keys)) ||
      saved.triggers.some((t) => t.bytes === 0 || t.bytes > 128 * 1024 || (t.kind === "catalog" ? catalogs : bindings).has(t.id))) fail("trust_recovery_required");
    const count = state.catalogs.length + state.rotations.length;
    const bytes = [...state.catalogs, ...state.rotations].reduce((n, a) => n + encoder.encode(a.json).length, 0);
    if (count + saved.triggers.length <= 1024 && bytes + saved.triggers.reduce((n, t) => n + t.bytes, 0) <= 16 * 1024 * 1024) fail("trust_recovery_required");
  }
  if (saved.reason === "authority_changed") {
    if (saved.opIds.length === 0 || saved.bindings.length + saved.catalogs.length + saved.bootstrapIds.length + saved.pendingProofIds.length !== 0) fail("trust_recovery_required");
    await validateAuthorityWitnesses(state, catalogs, histories);
    return;
  }
  if (saved.authorityWitnesses.length > 0) fail("trust_recovery_required");
  if (saved.triggers.length > 0) return;
  if (saved.opIds.length > 0) fail("trust_recovery_required");
  await validateBootstrapWitnesses(state, histories);
  const bindingAncestor = (older: string, newer: string): boolean => {
    let cursor: string | null = newer;
    while (cursor !== null) { if (cursor === older) return true; cursor = bindings.get(cursor)!.parent; }
    return false;
  };
  const independentBindings = saved.bindings.length > 1 && saved.bindings.every((a, i) => saved.bindings.slice(i + 1).every((b) => !bindingAncestor(a, b) && !bindingAncestor(b, a)));
  const catalogConflict = (a: string, b: string): boolean => {
    const ca = catalogs.get(a)!.envelope.catalog, cb = catalogs.get(b)!.envelope.catalog;
    if (ca.binding !== cb.binding) return false;
    if (!catalogAncestor(a, b, catalogs) && !catalogAncestor(b, a, catalogs)) return true;
    return [...bindings.values()].some((binding) => binding.parent === ca.binding &&
      ((binding.prior === a && a !== b && catalogAncestor(a, b, catalogs)) || (binding.prior === b && a !== b && catalogAncestor(b, a, catalogs))));
  };
  if (saved.catalogs.some((a) => !saved.catalogs.some((b) => a !== b && catalogConflict(a, b)))) fail("trust_recovery_required");
  if (saved.reason === "control_history_limit") {
    if (!independentBindings || saved.bindings.length <= 2 || saved.bootstrapIds.length > 0) fail("trust_recovery_required");
  } else if (!independentBindings && saved.catalogs.length === 0 && saved.bootstrapIds.length === 0) fail("trust_recovery_required");
}
async function validateBootstrapWitnesses(state: InstalledTreehouseCatalogTrustV1, histories: Map<string, ObservedHistory>) {
  const history = histories.get(state.review.space);
  if (history === undefined) fail("trust_recovery_required");
  const frames = new Map(history.raw.frames.map((frame) => [(frame as CarrierOpFrame).id, frame as CarrierOpFrame]));
  for (const id of state.blocked!.bootstrapIds) {
    if (state.review.observedBootstrapIds.includes(id)) fail("trust_recovery_required");
    const closure = new Set<string>(), pending = [id];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (closure.has(current)) continue;
      const frame = frames.get(current); if (frame === undefined) fail("trust_recovery_required");
      closure.add(current); pending.push(...frame.deps);
    }
    // A concurrent authority change can refuse a previously observed bootstrap.
    // Prove the retained command was honored in its own inclusive causal slice;
    // raw existence alone cannot supply a historical fork witness.
    const observed = await treehouseCatalogBootstrapsFromFrames({replica: state.review.space,
      frames: history.raw.frames.filter((frame) => closure.has((frame as CarrierOpFrame).id))});
    if (!observed.ok || !observed.bootstraps.some((bootstrap) => bootstrap.id === id &&
      bootstrap.record.space === state.review.space && bootstrap.record.spaceRoot === state.review.spaceRoot)) fail("trust_recovery_required");
  }
}
async function validateAuthorityWitnesses(state: InstalledTreehouseCatalogTrustV1, catalogs: Map<string, CatalogNode>, histories: Map<string, ObservedHistory>) {
  const saved = state.blocked!, witnesses = saved.authorityWitnesses;
  if (witnesses.length === 0 || !equal(witnesses.map((w) => w.replica), sorted(witnesses.map((w) => w.replica))) ||
    !equal(saved.opIds, sorted(witnesses.flatMap((w) => w.opIds)))) fail("trust_recovery_required");
  const allowed = new Map<string, Set<string>>([[state.review.space, new Set([state.review.bootstrapId])]]);
  if (state.accepted !== null) for (const entry of catalogs.get(state.accepted.catalog)!.envelope.catalog.entries) {
    const ids = allowed.get(entry.replica) ?? new Set<string>();
    ids.add(entry.genesis); ids.add(entry.creation); allowed.set(entry.replica, ids);
    allowed.get(state.review.space)!.add(entry.reference);
  }
  for (const witness of witnesses) {
    const history = histories.get(witness.replica);
    if (history === undefined || witness.frontier.length === 0 || witness.opIds.length === 0 ||
      witness.frontier.length > history.frames.length || witness.opIds.length > history.frames.length ||
      !equal(witness.frontier, sorted(witness.frontier)) || !equal(witness.opIds, sorted(witness.opIds)) ||
      witness.opIds.some((id) => !allowed.get(witness.replica)?.has(id))) fail("trust_recovery_required");
    const frames = new Map(history.frames.map((frame) => [frame.id, frame])), closure = new Set<string>(), pending = [...witness.frontier];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (closure.has(id)) continue;
      const frame = frames.get(id); if (frame === undefined) fail("trust_recovery_required");
      closure.add(id); pending.push(...frame.deps);
    }
    const historical = await observeHistory({replica: witness.replica, frames: history.raw.frames.filter((frame) => closure.has((frame as CarrierOpFrame).id)), rejected: []});
    if (!equal(historical.frontier, witness.frontier) || witness.opIds.some((id) => !historical.projection.quarantineReasons.has(id))) fail("trust_recovery_required");
  }
}
interface ObservedHistory {
  raw: TreehouseCatalogRawHistory; frames: CarrierOpFrame[]; frontier: string[]; ops: Op[]; byId: Map<string, Op>;
  analysis: ReturnType<typeof analyzeAuthority>; projection: ReturnType<typeof materialize>;
}
async function observeHistory(raw: TreehouseCatalogRawHistory): Promise<ObservedHistory> {
  if (!historyValid(raw)) fail("invalid_verified_history");
  const family = continuationFamily(raw.replica);
  if (family !== "space" && family !== "thread") fail("wrong_catalog_scope");
  const missing = await authenticateFrames(raw);
  if (missing.length > 0) fail("trust_pending", missing);
  const ids = new Set(raw.frames.map((f) => (f as CarrierOpFrame).id));
  const cutoff = await deriveTreehouseCatalogCutoff(raw);
  if (!cutoff.ok) fail(cutoff.reason);
  let frames: CarrierOpFrame[];
  try { frames = raw.frames.map(decodeCarrierOpFrame); } catch { fail("unsupported_cutoff"); }
  const product = family === "space" ? "Treehouse.Space" : "Treehouse.Thread";
  const schema = family === "space" ? treehouseSpaceSchema : treehouseThreadSchema;
  const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders(product));
  const byId = index(ops), order = canonicalOrder(ops, byId);
  if (ops.length !== frames.length || order.length !== frames.length) fail("invalid_verified_history");
  return {raw: {...raw, frames: [...raw.frames].sort((a, b) => compareUtf8((a as CarrierOpFrame).id, (b as CarrierOpFrame).id)),
    rejected: [...raw.rejected].sort((a, b) => compareUtf8((a.frame as CarrierOpFrame).id, (b.frame as CarrierOpFrame).id))},
    frames, frontier: cutoff.cutoff.frontier, ops, byId, analysis: analyzeAuthority(schema, ops, ids, order, byId, raw.replica), projection: materialize(schema, ops, ids, null, raw.replica)};
}
async function authenticateFrames(raw: TreehouseCatalogRawHistory): Promise<string[]> {
  if (!historyValid(raw)) fail("invalid_verified_history");
  const ids = new Set<string>();
  // Authentication before a fetch refusal prevents forged partial input being
  // mislabeled as a harmless missing page. Full portable validation follows.
  for (const value of raw.frames) {
    const f = value as CarrierOpFrame;
    try {
      if (!text(f.id) || f.replica !== raw.replica || ids.has(f.id) || !Array.isArray(f.deps) || !f.deps.every(text)) fail("invalid_verified_history");
      const bytes = canonicalBytesForCarrierOp(f), key = canonicalBase64Bytes(f.author, 32), sig = canonicalBase64Bytes(f.sig, 64);
      if (key === null || sig === null || await canonicalHash(bytes) !== f.id || !ed25519.verify(sig, bytes, key, {zip215: false})) fail("invalid_verified_history");
      ids.add(f.id);
    } catch (error) { if (error instanceof Refusal) throw error; fail("invalid_verified_history"); }
  }
  return sorted(raw.frames.flatMap((f) => (f as CarrierOpFrame).deps.filter((id) => !ids.has(id))));
}
async function mergeHistories(saved: readonly TreehouseCatalogRawHistory[], incoming: readonly TreehouseCatalogRawHistory[]): Promise<Map<string, ObservedHistory>> {
  const map = new Map<string, TreehouseCatalogRawHistory>();
  for (const list of [saved, incoming]) {
    const seen = new Set<string>();
    for (const history of list) {
      if (!historyValid(history) || seen.has(history.replica)) fail("invalid_verified_history");
      seen.add(history.replica);
      const prior = map.get(history.replica);
      if (prior === undefined) { map.set(history.replica, history); continue; }
      const merge = <T>(a: readonly T[], b: readonly T[], frame: (v: T) => CarrierOpFrame): T[] => {
        const by = new Map<string, T>();
        for (const items of [a, b]) {
          const duplicates = new Set<string>();
          for (const item of items) {
            const f = frame(item);
            if (duplicates.has(f.id)) fail("invalid_verified_history");
            duplicates.add(f.id);
            const old = by.get(f.id);
            if (old !== undefined && fingerprint(frame(old)) !== fingerprint(f)) fail("invalid_verified_history");
            by.set(f.id, old ?? item);
          }
        }
        return [...by.values()];
      };
      map.set(history.replica, {replica: history.replica, frames: merge(prior.frames, history.frames, (v) => v as CarrierOpFrame),
        rejected: merge(prior.rejected, history.rejected, (v) => v.frame as CarrierOpFrame)});
    }
  }
  const missing: string[] = [];
  let unsupported = false;
  for (const raw of map.values()) {
    missing.push(...await authenticateFrames(raw));
    const rejected = await deriveTreehouseCatalogCutoff({...raw, frames: []});
    if (!rejected.ok && rejected.reason === "invalid_verified_history") fail(rejected.reason);
    if (!rejected.ok) unsupported = true;
  }
  if (unsupported) fail("unsupported_cutoff");
  if (missing.length > 0) fail("trust_pending", missing);
  const observed = new Map<string, ObservedHistory>();
  for (const [id, raw] of map) observed.set(id, await observeHistory(raw));
  return observed;
}
function fingerprint(f: CarrierOpFrame): string { return `${f.id}:${hash(canonicalBytesForCarrierOp(f))}:${f.sig}`; }
function hash(bytes: Uint8Array): string {
  const digest = sha256(bytes);
  let binary = ""; for (const n of digest) binary += String.fromCharCode(n);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function parseJson(json: string): unknown {
  if (typeof json !== "string") fail("malformed_catalog");
  if (encoder.encode(json).length > 128 * 1024) fail("control_history_limit");
  try { return JSON.parse(json); } catch { fail("malformed_catalog"); }
}
function parseCatalog(json: string): CatalogEnvelope {
  const value = catalogEnvelopeFromCarrierTerm(parseJson(json));
  if (value === null) fail("malformed_catalog"); return value;
}
interface CatalogNode {id: string; json: string; envelope: CatalogEnvelope; authenticated: boolean; pending: string[];}
interface RotationNode {id: string; json: string; envelope: CatalogRotationEnvelope; authenticated: boolean;}
interface Binding {id: string; generation: number; key: string; parent: string | null; prior: string | null; inventory: string | null; pending: string[];}
function addCatalog(map: Map<string, CatalogNode>, json: string, bootstrap: CatalogBootstrap, bootstrapId: string, savedId?: string) {
  const envelope = parseCatalog(json), id = transportCatalogId(envelope.catalog);
  if (savedId !== undefined && savedId !== id) fail("trust_recovery_required");
  if (envelope.catalog.space !== bootstrap.space || envelope.catalog.bootstrap !== bootstrapId) fail("wrong_catalog_scope", [id]);
  if (!map.has(id)) map.set(id, {id, json, envelope, authenticated: false, pending: []});
  else if (map.get(id)!.envelope.signature !== envelope.signature) fail("invalid_catalog_signature", [id]);
}
function addRotation(map: Map<string, RotationNode>, json: string, bootstrap: CatalogBootstrap, bootstrapId: string, savedId?: string) {
  const envelope = catalogRotationEnvelopeFromCarrierTerm(parseJson(json));
  if (envelope === null) fail("malformed_catalog");
  const id = catalogRotationId(envelope);
  if (savedId !== undefined && savedId !== id) fail("trust_recovery_required");
  if (envelope.rotation.space !== bootstrap.space || envelope.rotation.bootstrap !== bootstrapId) fail("wrong_catalog_scope", [id]);
  if (!map.has(id)) map.set(id, {id, json, envelope, authenticated: false});
}
function inventoryExtends(before: CatalogEntry[], after: CatalogEntry[]): boolean {
  return before.every((entry) => {
    const next = after.find((e) => e.replica === entry.replica);
    return next !== undefined && ["root", "genesis", "creation", "reference", "kind", "schema"].every((key) => entry[key as keyof CatalogEntry] === next[key as keyof CatalogEntry]);
  });
}
function ancestor(older: string, newer: string, by: Map<string, Op>): boolean {
  const seen = new Set<string>(), pending = [...(by.get(newer)?.deps ?? [])];
  while (pending.length > 0) { const id = pending.pop()!; if (id === older) return true; if (seen.has(id)) continue; seen.add(id); pending.push(...(by.get(id)?.deps ?? [])); }
  return false;
}
function entryProof(entry: CatalogEntry, histories: Map<string, ObservedHistory>, space: ObservedHistory): {pending: string[]; refused: string[]; invalid: boolean} {
  const h = histories.get(entry.replica), result = {pending: [] as string[], refused: [] as string[], invalid: false};
  if (continuationFamily(entry.replica) !== entry.kind) return {...result, invalid: true};
  if (h === undefined) return {...result, pending: [entry.genesis, entry.creation, entry.reference]};
  const genesis = h.byId.get(entry.genesis), creation = h.byId.get(entry.creation);
  const reference = entry.kind === "thread" ? space.byId.get(entry.reference) : space.byId.get(entry.reference);
  for (const [id, op, history] of [[entry.genesis, genesis, h], [entry.creation, creation, h], [entry.reference, reference, space]] as const) {
    if (op === undefined) result.pending.push(id);
    else if (history.projection.quarantineReasons.has(id)) result.refused.push(id);
  }
  if (h.analysis.security.root?.pubkey !== entry.root) result.invalid = true;
  if (genesis !== undefined) {
    const d = genesis.authority?.type === "genesis" ? genesis.authority.delegation : undefined;
    if (genesis.kind !== "authority" || d === undefined || d.parentId !== null || d.issuer !== entry.root || d.audience !== entry.root ||
      genesis.authorPubkey !== entry.root || !h.analysis.security.delegations.get(d.id)?.validation.valid) result.invalid = true;
  }
  if (creation !== undefined && (creation.kind !== "command" || creation.command !== (entry.kind === "space" ? "create_space" : "create_thread") ||
    (genesis !== undefined && !ancestor(genesis.id, creation.id, h.byId)))) result.invalid = true;
  if (reference !== undefined && (reference.kind !== "command" || (entry.kind === "space" ? reference.command !== "catalog_bootstrap_v1" || entry.replica !== space.raw.replica :
    reference.command !== "create_thread" || reference.commandArgs?.length !== 2 || reference.commandArgs[0] !== entry.replica))) result.invalid = true;
  return result;
}
async function mergeProofs(saved: readonly TreehouseCatalogCutoffProof[], incoming: readonly TreehouseCatalogCutoffProof[], histories: Map<string, ObservedHistory>): Promise<TreehouseCatalogCutoffProof[]> {
  const proofs = new Map<string, TreehouseCatalogCutoffProof>();
  for (const proof of [...saved, ...incoming]) {
    if (!closed(proof, ["cutoff", "history"]) || normalizeCatalogCutoff(proof.cutoff) === null || !historyValid(proof.history)) fail("malformed_catalog");
    const observed = await deriveTreehouseCatalogCutoff(proof.history);
    if (!observed.ok) fail(observed.reason);
    if (!equal(observed.cutoff, proof.cutoff)) fail("recovery_incomplete", [proof.cutoff.logDigest]);
    const current = histories.get(proof.history.replica);
    if (current === undefined) fail("recovery_incomplete", [proof.cutoff.logDigest]);
    const present = new Set(current.raw.frames.map((f) => fingerprint(f as CarrierOpFrame)));
    const rejected = new Set(current.raw.rejected.map((r) => fingerprint(r.frame as CarrierOpFrame)));
    if (proof.history.frames.some((f) => !present.has(fingerprint(f as CarrierOpFrame))) || proof.history.rejected.some((r) => !rejected.has(fingerprint(r.frame as CarrierOpFrame)))) fail("recovery_incomplete", [proof.cutoff.logDigest]);
    const key = `${proof.cutoff.replica}:${proof.cutoff.logDigest}`;
    if (!proofs.has(key)) proofs.set(key, proof);
  }
  return [...proofs.values()].sort((a, b) => compareUtf8(`${a.cutoff.replica}:${a.cutoff.logDigest}`, `${b.cutoff.replica}:${b.cutoff.logDigest}`));
}
function catalogAncestor(older: string, newer: string, nodes: Map<string, CatalogNode>): boolean {
  let cursor: string | null = newer; const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) { if (cursor === older) return true; seen.add(cursor); cursor = nodes.get(cursor)?.envelope.catalog.previous ?? null; }
  return false;
}
function catalogRoutes(node: CatalogNode, binding: Binding, bootstrap: CatalogBootstrap): VerifiedTreehouseCatalogRoute[] {
  return node.envelope.catalog.entries.map((e) => ({replica: e.replica, kind: e.kind, schema: e.schema, root: e.root,
    genesis: e.genesis, creation: e.creation, reference: e.reference, binding: binding.id, catalog: node.id, revision: node.envelope.catalog.revision,
    origin: bootstrap.origin, path: e.route, url: bootstrap.origin + e.route, serviceId: e.serviceId, serviceKey: e.serviceKey, realm: catalogServiceRealm(e.serviceId)}));
}
