import type { CatalogCutoff } from "./treehouse_catalog_codec";
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
      detail: TreehouseCatalogRefusalDetail; replacementConfigured: boolean;
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
    const value = structuredClone(input);
    if (!closed(value, ["review", "history", "store"]) || !reviewValid(value.review) ||
      !closed(value.store, ["kind", "expected"]) || value.store.kind !== "verified_fresh" || !tokenValid(value.store.expected)) fail("malformed_catalog");
    const history = await observeHistory(value.history);
    if (history.raw.replica !== value.review.space) fail("wrong_catalog_scope");
    const observed = await treehouseCatalogBootstrapsFromFrames(history.raw);
    if (!observed.ok) fail("invalid_verified_history");
    const selected = observed.bootstraps.find((b) => b.id === value.review.bootstrapId);
    if (selected === undefined) fail("catalog_authority_refused", [value.review.bootstrapId]);
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
  let frozen: {next: InstalledTreehouseCatalogTrustV1; expected: TreehouseCatalogStoreToken; replacement: boolean; bootstrapIds: string[]} | undefined;
  try {
    const value = structuredClone(input);
    if (!closed(value, ["installed", "expected", "incoming"]) || !tokenValid(value.expected) || !stateValid(value.installed) || !pageValid(value.incoming)) fail("malformed_catalog");
    const original = value.installed;
    const next = structuredClone(original);
    const histories = await mergeHistories(original.histories, value.incoming.histories);
    next.histories = [...histories.values()].map((h) => h.raw).sort((a, b) => compareUtf8(a.replica, b.replica));
    const space = histories.get(original.review.space);
    if (space === undefined) fail("trust_recovery_required");
    const selected = space.byId.get(original.review.bootstrapId);
    const bootstrap = selected?.command === "catalog_bootstrap_v1" ? normalizeCatalogBootstrap(selected.commandArgs?.[0]) : null;
    if (bootstrap === null || bootstrap.space !== original.review.space || bootstrap.spaceRoot !== original.review.spaceRoot ||
      space.analysis.security.root?.pubkey !== original.review.spaceRoot) fail("trust_recovery_required");
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
    if (refused.length > 0) next.blocked = block("authority_changed", [], [], [], refused);
    const unseenBootstrapIds = bootstrapIds.filter((id) => !original.review.observedBootstrapIds.includes(id));
    if (unseenBootstrapIds.length > 0 && next.blocked === null) next.blocked = block("catalog_fork", [], [], unseenBootstrapIds);
    if (next.blocked !== null) frozen = {next, expected: value.expected, replacement, bootstrapIds};

    const catalogs = new Map<string, CatalogNode>(), rotations = new Map<string, RotationNode>();
    for (const saved of original.catalogs) addCatalog(catalogs, saved.json, bootstrap, original.review.bootstrapId, saved.id);
    for (const saved of original.rotations) addRotation(rotations, saved.json, bootstrap, original.review.bootstrapId, saved.id);
    for (const json of value.incoming.catalogs) addCatalog(catalogs, json, bootstrap, original.review.bootstrapId);
    for (const json of value.incoming.rotations) addRotation(rotations, json, bootstrap, original.review.bootstrapId);
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
      for (const entry of c.entries) {
        const proof = entryProof(entry, histories, space);
        if (proof.invalid || proof.refused.length > 0) {
          if (next.blocked?.reason !== "authority_changed") fail("invalid_catalog_transition", [id, ...proof.refused]);
        }
        node.pending.push(...proof.pending);
      }
      node.pending = sorted(node.pending);
      visiting.delete(id); catalogReady.add(id);
      return node;
    };
    for (const id of sorted(catalogs.keys())) catalogFor(id);
    for (const id of sorted(rotations.keys())) bindingFor(id);

    // All records are authenticated against their own predecessor graph before
    // admission/budget checking. Unknown signer/parent records never establish trust.
    const retained = [...original.catalogs.map((a) => ({kind: "catalog" as const, ...a})), ...original.rotations.map((a) => ({kind: "rotation" as const, ...a}))];
    const have = new Set(retained.map((a) => `${a.kind}:${a.id}`));
    const additions = [...catalogs.values()].map((n) => ({kind: "catalog" as const, id: n.id, json: n.json}))
      .concat([]).map((a) => a as {kind: "catalog" | "rotation"; id: string; json: string});
    additions.push(...[...rotations.values()].map((n) => ({kind: "rotation" as const, id: n.id, json: n.json})));
    let bytes = retained.reduce((sum, a) => sum + encoder.encode(a.json).length, 0);
    for (const artifact of additions.sort((a, b) => compareUtf8(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`))) {
      if (have.has(`${artifact.kind}:${artifact.id}`)) continue;
      const size = encoder.encode(artifact.json).length;
      if (retained.length + 1 > 1024 || bytes + size > 16 * 1024 * 1024) {
        // Preserve the original store's artifact set at exhaustion, not an
        // arbitrary sorted subset of this incoming page.
        next.catalogs = original.catalogs; next.rotations = original.rotations;
        next.blocked = block("control_history_limit", [], [], [], []);
        next.blocked.triggers = [{kind: artifact.kind, id: artifact.id, digest: hash(encoder.encode(artifact.json)), bytes: size}];
        return issue("retain_blocked", value.expected, next, "control_history_limit", replacement, bootstrapIds, [], [], []);
      }
      retained.push(artifact); have.add(`${artifact.kind}:${artifact.id}`); bytes += size;
    }
    next.catalogs = [...catalogs.values()].map((n) => ({id: n.id, json: n.json})).sort(byId);
    next.rotations = [...rotations.values()].map((n) => ({id: n.id, json: n.json})).sort(byId);
    next.cutoffProofs = await mergeProofs(original.cutoffProofs, value.incoming.cutoffProofs, histories);
    for (const [id, binding] of bindings) {
      if (binding.parent === null) continue;
      const r = rotations.get(id)!.envelope.rotation;
      for (const cutoff of r.cutoffs) if (!next.cutoffProofs.some((p) => equal(p.cutoff, cutoff))) binding.pending.push(cutoff.logDigest);
      binding.pending = sorted(binding.pending);
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
    if (next.blocked === null && (heads.length > 1 || forks.length > 0)) next.blocked = block(heads.length > 2 ? "control_history_limit" : "catalog_fork", heads, forks, [], [], pendingIds);
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
        saved.envelope.catalog.revision !== original.accepted.revision || binding.generation !== original.accepted.generation) fail("trust_recovery_required");
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
    if (frozen !== undefined) return issue("retain_blocked", frozen.expected, frozen.next, frozen.next.blocked!.reason,
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
  return {reason, bindings: sorted(bindings), catalogs: sorted(catalogs), bootstrapIds: sorted(bootstrapIds), opIds: sorted(opIds), pendingProofIds: sorted(pendingProofIds), triggers: []};
}
function closed(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === names.length && Object.keys(value).every((key) => names.includes(key));
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
function historyValid(v: unknown): v is TreehouseCatalogRawHistory { return closed(v, ["replica", "frames", "rejected"]) && text(v.replica) && Array.isArray(v.frames) && Array.isArray(v.rejected); }
function pageValid(v: unknown): v is TreehouseCatalogEvidencePage {
  if (!closed(v, ["catalogs", "rotations", "histories", "cutoffProofs"]) || !Array.isArray(v.catalogs) || !Array.isArray(v.rotations) || !Array.isArray(v.histories) || !Array.isArray(v.cutoffProofs)) return false;
  if (v.catalogs.length + v.rotations.length > 32) fail("control_history_limit");
  return v.catalogs.every((s) => typeof s === "string") && v.rotations.every((s) => typeof s === "string") && v.histories.every(historyValid);
}
function stateValid(v: unknown): v is InstalledTreehouseCatalogTrustV1 {
  if (!closed(v, ["version", "review", "histories", "catalogs", "rotations", "cutoffProofs", "accepted", "blocked"]) || v.version !== 1 || !reviewValid(v.review) ||
    !Array.isArray(v.histories) || !v.histories.every(historyValid) || !Array.isArray(v.catalogs) || !Array.isArray(v.rotations) || !Array.isArray(v.cutoffProofs)) return false;
  if (![...v.catalogs, ...v.rotations].every((a) => closed(a, ["id", "json"]) && idValid(a.id) && typeof a.json === "string")) return false;
  if (v.accepted !== null && (!closed(v.accepted, ["binding", "generation", "catalog", "revision"]) || !idValid(v.accepted.binding) || !idValid(v.accepted.catalog) || !safe(v.accepted.generation) || !safe(v.accepted.revision))) return false;
  if (v.blocked !== null && (!closed(v.blocked, ["reason", "bindings", "catalogs", "bootstrapIds", "opIds", "pendingProofIds", "triggers"]) ||
    !["catalog_fork", "authority_changed", "control_history_limit"].includes(v.blocked.reason as string) ||
    ![v.blocked.bindings, v.blocked.catalogs, v.blocked.bootstrapIds, v.blocked.opIds, v.blocked.pendingProofIds].every((a) => Array.isArray(a) && a.every(idValid)) || !Array.isArray(v.blocked.triggers))) return false;
  return true;
}
interface ObservedHistory {
  raw: TreehouseCatalogRawHistory; frames: CarrierOpFrame[]; ops: Op[]; byId: Map<string, Op>;
  analysis: ReturnType<typeof analyzeAuthority>; projection: ReturnType<typeof materialize>;
}
async function observeHistory(raw: TreehouseCatalogRawHistory): Promise<ObservedHistory> {
  if (!historyValid(raw)) fail("invalid_verified_history");
  const family = continuationFamily(raw.replica);
  if (family !== "space" && family !== "thread") fail("wrong_catalog_scope");
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
  const missing = sorted(raw.frames.flatMap((f) => (f as CarrierOpFrame).deps.filter((id) => !ids.has(id))));
  if (missing.length > 0) fail("trust_pending", missing);
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
    frames, ops, byId, analysis: analyzeAuthority(schema, ops, ids, order, byId, raw.replica), projection: materialize(schema, ops, ids, null, raw.replica)};
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
