// TS twin of Treehouse.CatalogReplacementTrust (plan 316 row 316): a composed evaluator that lets a client which already
// trusts a Treehouse catalog accept a replacement catalog signed by an authorized admin, without the old catalog signer's
// key. It has no production caller and nothing dials the routes it returns. Import it by path; it is not exported from
// index.ts.
//
// It is built by composition in a new file. evaluateTreehouseCatalogTrust still owns every page that has no replacement in
// it (row 381 keeps the internal hook open). This file adds a sidecar of replacement-bound catalogs (which the trust
// evaluator refuses as trust_pending), resolveCatalogBindingGraph + advanceCatalogBindingState as the authority on what is
// accepted and served once the Space history holds a replace_catalog_v1 op, and a route builder that reads the origin and
// service pair from the serving binding's graph node, not from the bootstrap.
//
// A rotation whose parent is the bootstrap, a retained rotation or another such rotation on the page goes to the trust
// evaluator; any other decodable rotation is a sidecar candidate (row 526). A catalog bound to neither the bootstrap nor such
// a rotation is replacement-bound and is kept in the sidecar, so a first catalog may arrive before its op or its rotation. A
// held catalog whose binding becomes the trust evaluator's is handed back with that page (row 527); one it does not take
// is tried alone, and dropped only once its binding is retained and it is not waiting on a predecessor, or, while blocked,
// only when its signature fails against its binding's key. Held catalogs never make the result less blocked than the page
// alone, never take one side of a fork they raise, and a subset of them is taken only when every one was tried; an orphan
// rotation never turns the block they raise into a reject. With a
// replace_catalog_v1 op held, the graph sees only the sidecar catalogs and rotations that reach a held op: one bound to an unheld id waits and cannot pin the client. Its reason
// is trust_pending when a sidecar catalog or rotation waits, or the first catalog of a sidecar rotation the graph keeps open
// is not held, and nothing else explains the result. A page that cannot be scanned is judged by the trust evaluator; an
// exception in the composed path is a malformed_catalog reject that changes nothing.
//
// Rotations under a replacement (row 526): after the trust evaluator accepts the page, each candidate must reach a
// replace_catalog_v1 op in the retained Space history or a held sidecar rotation, possibly through other candidates; if any
// reaches neither, the page is refused exactly as before (the trust evaluator judges it with every incoming rotation). A
// sidecar rotation reaches the graph only after verifyCatalogRotationEnvelope passes against its parent's key (the op's
// claimed key, or an admitted parent rotation's new key); a failing variant, or one under an op of the wrong arity, is dropped.
//
// Limits, all deliberate: a rotation under a replacement never supersedes a trust block (only a replacement node does); a
// rotation that arrives before its op is still refused as trust_pending; the sidecar has no byte budget (row 355) and no
// saved-state validation (row 395); an incomplete Space closure serves nothing new; and the authority check is the graph's,
// which for a leased admin is not the C10 R04-successor case, so C10 to C15 stay open.
//
// Block rule (D-689): the mere presence of a replacement-shaped op never widens what is served. Composition engages only when
// the resolver treats an op as a replacement node or as raw refusal evidence; a malformed or unauthorized op that is neither
// changes nothing. While the trust state is blocked its decision stands and nothing is served, except that a replacement the
// graph honors, whose first catalog it accepts with the serving node bound to that replacement, supersedes the block (so an
// old-key catalog fork cannot stop an accepted replacement). Only the block classes the graph resolves can be superseded (D-882):
// an authority_changed block or a catalog_fork among catalogs. A block that names an unreviewed bootstrap, a page whose Space
// shows one, a control_history_limit block and a block carrying overflow triggers are never superseded, because the graph
// judges only the reviewed bootstrap and does not resolve a truncated control history. A sidecar catalog bound to a held replacement op is admitted only
// if its signature verifies against that op's claimed catalog key, once per catalog id. wrapReplacementTrust carries the trust
// state's accepted watermark and cumulative routes into the graph state.
import { carrierOpsToSemanticOps, decodeCarrierOpFrame } from "./carrier";
import { treehouseCatalogBootstrapsFromFrames, treehouseCommandDecoders } from "./treehouse";
import { advanceCatalogBindingState, resolveCatalogBindingGraph } from "./treehouse_catalog_binding_graph";
import type { CatalogBindingAccepted, CatalogBindingGraphInput, CatalogBindingState } from "./treehouse_catalog_binding_graph";
import { catalogEnvelopeFromCarrierTerm, catalogRotationEnvelopeFromCarrierTerm, catalogRotationId, catalogServiceRealm,
  transportCatalogId, verifyCatalogEnvelope, verifyCatalogRotationEnvelope } from "./treehouse_catalog_codec";
import type { CatalogEnvelope, CatalogRotationEnvelope, TransportCatalog } from "./treehouse_catalog_codec";
import { parseCatalogArtifactJson } from "./treehouse_catalog_json";
import { compareUtf8 } from "./op";
import { evaluateTreehouseCatalogTrust, prepareTreehouseCatalogInstallation } from "./treehouse_catalog_trust";
import type { InstalledTreehouseCatalogTrustV1, TreehouseCatalogEvidencePage, TreehouseCatalogRawHistory,
  TreehouseCatalogRefusalDetail, TreehouseCatalogStoreToken, TreehouseCatalogTrustDecision, TreehouseCatalogTrustReason,
  VerifiedTreehouseCatalogRoute } from "./treehouse_catalog_trust";

export interface InstalledReplacementTrust {
  trust: InstalledTreehouseCatalogTrustV1;
  binding: CatalogBindingState;
  extra: SidecarExtra;
  routes: VerifiedTreehouseCatalogRoute[];
}
/** The sidecar; rotations is present only while a sidecar rotation is held (row 526). */
type SidecarExtra = {catalogs: string[]; rotations?: string[]};
export type ReplacementTrustResult =
  | {kind: "reject"; reason: TreehouseCatalogTrustReason; detail: TreehouseCatalogRefusalDetail}
  | {kind: "unchanged" | "propose" | "retain_blocked"; reason: string | null; refused: Record<string, string>;
      next: InstalledReplacementTrust; routes: VerifiedTreehouseCatalogRoute[]; servedOrigin: string | null;
      trustDecision: TreehouseCatalogTrustDecision};

const emptyBinding = (): CatalogBindingState => ({accepted: null, frozen: false});

/** Wrap a bare trust state as an installed state with nothing served yet. */
export function wrapReplacementTrust(trust: InstalledTreehouseCatalogTrustV1): InstalledReplacementTrust {
  return {trust, binding: {...emptyBinding(), accepted: watermark(trust)}, extra: {catalogs: []}, routes: []};
}

// The trust state's accepted watermark with the cumulative route table of every catalog on the accepted chain (D-881), so a
// later replacement is judged against every route the client already accepted. The chain is walked as the trust state's
// accepted support is: the accepted catalog's previous chain, then for each rotation from the accepted binding up to the
// bootstrap, its prior catalog's previous chain. If two catalogs map one route to different replicas, the newer catalog's
// replica is kept. A link the trust state does not hold ends that branch.
function watermark(trust: InstalledTreehouseCatalogTrustV1): CatalogBindingAccepted | null {
  const accepted = trust.accepted;
  if (accepted === null) return null;
  const catalogs = new Map<string, TransportCatalog>();
  for (const record of trust.catalogs) {
    const envelope = decodeCatalog(record.json);
    if (envelope !== null) catalogs.set(record.id, envelope.catalog);
  }
  const rotations = new Map<string, {parent: string; priorCatalog: string}>();
  for (const record of trust.rotations) {
    const envelope = decodeRotation(record.json);
    if (envelope !== null) rotations.set(record.id, envelope.rotation);
  }
  const starts = [accepted.catalog];
  for (let binding = accepted.binding, visited = new Set<string>(); !visited.has(binding);) {
    const rotation = rotations.get(binding);
    if (rotation === undefined) break;
    visited.add(binding);
    starts.push(rotation.priorCatalog);
    binding = rotation.parent;
  }
  const routes: Record<string, string> = {};
  const seen = new Set<string>();
  for (const start of starts) {
    for (let id: string | null = start; id !== null && !seen.has(id);) {
      const catalog = catalogs.get(id);
      if (catalog === undefined) break;
      seen.add(id);
      for (const e of catalog.entries) if (!Object.hasOwn(routes, e.route)) routes[e.route] = e.replica;
      id = catalog.previous;
    }
  }
  return {...accepted, routes};
}

/** As prepareTreehouseCatalogInstallation, with the proposed state wrapped. */
export async function prepareReplacementTrustInstallation(
  input: Parameters<typeof prepareTreehouseCatalogInstallation>[0],
): Promise<{decision: TreehouseCatalogTrustDecision; next: InstalledReplacementTrust | null}> {
  const decision = await prepareTreehouseCatalogInstallation(input);
  return {decision, next: decision.kind === "reject" ? null : wrapReplacementTrust(decision.next)};
}

export async function evaluateReplacementTrust(input: {
  installed: InstalledReplacementTrust; expected: TreehouseCatalogStoreToken; incoming: TreehouseCatalogEvidencePage;
}): Promise<ReplacementTrustResult> {
  const {installed, expected, incoming} = input;
  const {legacy, candidates, bound, revived} = split(installed, incoming);
  const judge = (page: TreehouseCatalogEvidencePage) =>
    evaluateTreehouseCatalogTrust({installed: installed.trust, expected, incoming: page});
  const {decision, settled} = await revive(judge, legacy, revived);
  const catalogs = [...installed.extra.catalogs.filter((json) => !settled.has(json)), ...bound];
  if (decision.kind === "reject") return decision;
  const heldRotations = installed.extra.rotations ?? [];
  const kept = classifyRotations(candidates, decision.next, heldRotations);
  if (kept === null) {
    // Row 526: an orphan rotation is judged exactly as before this row, with every incoming rotation. A block the trust
    // evaluator keeps stands (nothing is served and the orphan is not held); every held catalog stays held, since nothing
    // was taken.
    // A block the revived catalogs raised that this judgement does not carry (it sees the page without them) stands
    // instead, with the orphan not held: an orphan never turns a block into a reject or a weaker block (review round 3).
    const orphaned = await judge({...legacy, rotations: incoming.rotations});
    if (raises(decision, orphaned)) return settle(installed, decision, putExtra(catalogs, heldRotations));
    if (orphaned.kind === "reject") return orphaned;
    if (orphaned.kind !== "retain_blocked") return recovery("malformed_catalog");
    return settle(installed, orphaned, putExtra([...installed.extra.catalogs, ...bound], heldRotations));
  }
  return settle(installed, decision, putExtra(catalogs, [...heldRotations, ...kept]));
}

async function settle(installed: InstalledReplacementTrust,
  decision: Exclude<TreehouseCatalogTrustDecision, {kind: "reject"}>, extra: SidecarExtra): Promise<ReplacementTrustResult> {
  const ops = replaceIds(decision.next);
  if (ops.size === 0) return mirrored(installed, decision, extra, ops);
  try { return await composed(installed, decision, extra, ops); } catch { return recovery("malformed_catalog"); }
}

// Row 527: a held catalog whose binding is now known goes to the trust evaluator with this page. It is taken only when its
// exact JSON is in the trust state the evaluator proposes: a decision that is not a reject can still have refused the page
// under a block (retain_blocked keeps neither the page nor the catalog). When the page with every revived catalog is not taken
// whole, the page is judged alone and the revived catalogs are tried one at a time, in sidecar order, to a fixpoint, so a
// forged variant costs neither the authentic catalog nor the page's evidence and a held revision tried before its first
// catalog is not lost. A catalog still not taken is dropped for good only as droppable allows; otherwise it stays held.
// settled is every held catalog taken or dropped.
//
// Decisions are ranked: no block (or a reject), a block the graph may supersede, any other block. A judgement that outranks
// the page alone (a fork between held catalogs, or one a held catalog opens against the page) is final: it is returned with
// nothing settled, so every held catalog stays held and no subset retry can take one side of a fork or drop the other. A
// retry that outranks the decision so far ends the retries the same way, and the result never ranks below the page alone, so
// a held catalog that fails inside the trust evaluator (which then reports the older saved block) can never trade a stronger
// block for a weaker one (review round 3).
//
// The whole-set judgement sees every revived catalog; only the retries are bounded, to the first REVIVE_LIMIT in sidecar
// order. A subset is taken only when no revived catalog went untried: otherwise the page alone is the decision and only the
// window's droppable catalogs settle, so a catalog outside the window can never be the unseen side of a fork whose other side
// was taken.
const REVIVE_LIMIT = 16;

type Judge = (page: TreehouseCatalogEvidencePage) => Promise<TreehouseCatalogTrustDecision>;
type Left = {json: string; trial: TreehouseCatalogTrustDecision}[];

async function revive(judge: Judge, legacy: TreehouseCatalogEvidencePage, held: readonly string[]):
  Promise<{decision: TreehouseCatalogTrustDecision; settled: Set<string>}> {
  const withCatalogs = (jsons: readonly string[]) => ({...legacy, catalogs: [...legacy.catalogs, ...jsons]});
  if (held.length === 0) return {decision: await judge(legacy), settled: new Set()};
  const all = await judge(withCatalogs(held));
  const alone = await judge(legacy);
  if (taken(all, held) && rank(all) >= rank(alone)) return {decision: all, settled: new Set(held)};
  if (raises(all, alone)) return {decision: all, settled: new Set()};
  const window = held.slice(0, REVIVE_LIMIT);
  const outside = held.length > window.length;
  let decision = alone;
  const accepted: string[] = [];
  let rest = [...window];
  // Each catalog not taken, with its last trial.
  let left: Left = [];
  for (;;) {
    left = [];
    for (const json of rest) {
      const trial = await judge(withCatalogs([...accepted, json]));
      if (taken(trial, [...accepted, json])) { decision = trial; accepted.push(json); }
      else if (raises(trial, decision)) return {decision: rank(trial) < rank(alone) ? alone : trial, settled: new Set()};
      else left.push({json, trial});
    }
    const progress = left.length < rest.length;
    rest = left.map((l) => l.json);
    if (rest.length === 0 || !progress) break;
  }
  if ((accepted.length > 0 && outside) || rank(decision) < rank(alone))
    return {decision: alone, settled: new Set(await droppable(alone, left, legacy))};
  return {decision, settled: new Set([...accepted, ...await droppable(decision, left, legacy)])};
}

// Whether trial outranks baseline (the page without the held catalog).
function raises(trial: TreehouseCatalogTrustDecision, baseline: TreehouseCatalogTrustDecision): boolean {
  return rank(trial) > rank(baseline);
}

// 0: no block (a reject carries none); 1: a block the graph may supersede (D-882); 2: any other.
function rank(decision: TreehouseCatalogTrustDecision): number {
  if (decision.kind === "reject" || decision.next.blocked == null) return 0;
  return supersedable(decision.next, decision) ? 1 : 2;
}

function taken(decision: TreehouseCatalogTrustDecision, jsons: readonly string[]): boolean {
  if (decision.kind === "reject") return false;
  const retained = new Set(decision.next.catalogs.map((c) => c.json));
  return jsons.every((json) => retained.has(json));
}

// Never with overflow triggers. Without a block: a catalog whose binding the decision retains and whose last trial was not a
// trust_pending refusal (a revision whose predecessor has not arrived waits for it). Under a block the trust evaluator reports
// every refusal as the block, so a trial says nothing about the catalog: only one whose signature fails against its binding's
// key (the reviewed bootstrap's catalog key, or a retained or page rotation's new key, which the rotation id commits to) is
// dropped (review round 3).
async function droppable(decision: TreehouseCatalogTrustDecision, left: Left, legacy: TreehouseCatalogEvidencePage):
  Promise<string[]> {
  if (decision.kind === "reject" || (decision.next.blocked?.triggers.length ?? 0) > 0) return [];
  const trust = decision.next;
  if (rank(decision) > 0) {
    const keys = await bindingKeys(trust, legacy.rotations);
    return left.filter(({json}) => {
      const envelope = decodeCatalog(json);
      const key = envelope === null ? undefined : keys.get(envelope.catalog.binding);
      return envelope !== null && key !== undefined && !verifyCatalogEnvelope(envelope, key);
    }).map((l) => l.json);
  }
  const known = new Set([trust.review.bootstrapId, ...trust.rotations.map((r) => r.id)]);
  return left.filter(({json, trial}) => {
    if (trial.kind === "reject" && trial.reason === "trust_pending") return false;
    const envelope = decodeCatalog(json);
    return envelope !== null && known.has(envelope.catalog.binding);
  }).map((l) => l.json);
}

async function bindingKeys(trust: InstalledTreehouseCatalogTrustV1, rotations: readonly string[]):
  Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  const space = trust.histories.find((h) => h.replica === trust.review.space);
  try {
    const observed = space === undefined ? null : await treehouseCatalogBootstrapsFromFrames(space);
    const bootstrap = observed?.ok ? observed.bootstraps.find((b) => b.id === trust.review.bootstrapId) : undefined;
    if (bootstrap !== undefined) keys.set(bootstrap.id, bootstrap.record.catalogKey);
  } catch { /* no bootstrap key: nothing bound to it is dropped */ }
  for (const json of [...trust.rotations.map((r) => r.json), ...rotations]) {
    const envelope = decodeRotation(json);
    if (envelope !== null) keys.set(catalogRotationId(envelope), envelope.rotation.newCatalogKey);
  }
  return keys;
}

// The sidecar: catalogs always, rotations only when any are held, so a saved state, a view or a same() check from before row
// 526 is unchanged.
function putExtra(catalogs: readonly string[], rotations: readonly string[]): SidecarExtra {
  const extra: SidecarExtra = {catalogs: [...new Set(catalogs)].sort(compareUtf8)};
  const kept = [...new Set(rotations)].sort(compareUtf8);
  if (kept.length > 0) extra.rotations = kept;
  return extra;
}

// --- no replacement op: the trust decision, plus the mirrored watermark -------------------------------------------------

function mirrored(installed: InstalledReplacementTrust, decision: Exclude<TreehouseCatalogTrustDecision, {kind: "reject"}>,
  extra: SidecarExtra, owned: ReadonlySet<string>): Exclude<ReplacementTrustResult, {kind: "reject"}> {
  // owned: every binding whose watermark is the graph's, the replacement ops and every kept sidecar rotation (row 526).
  const binding = mirror(installed.binding, decision, owned);
  const kind = decision.kind === "unchanged" && !same(extra, installed.extra) ? "propose" : decision.kind;
  const waiting = extra.catalogs.length > 0 || (extra.rotations ?? []).length > 0;
  return {kind, reason: decision.reason ?? (waiting ? "trust_pending" : null), refused: {},
    next: {...installed, trust: decision.next, binding, extra, routes: decision.routes}, routes: decision.routes,
    servedOrigin: originOf(decision.routes), trustDecision: decision};
}

function mirror(binding: CatalogBindingState, decision: Exclude<TreehouseCatalogTrustDecision, {kind: "reject"}>,
  owned: ReadonlySet<string>): CatalogBindingState {
  const accepted = watermark(decision.next);
  if (accepted === null) return binding;
  // A watermark the graph holds on a replacement binding or a sidecar rotation is the graph's; the trust state's accepted
  // catalog never overwrites it.
  if (binding.accepted !== null && owned.has(binding.accepted.binding)) return binding;
  // The accepted chain's routes too, so a route moved by several catalogs on one page stays reserved (D-881).
  const routes: Record<string, string> = {...(binding.accepted?.routes ?? {}), ...accepted.routes};
  for (const r of decision.routes) routes[r.path] = r.replica;
  return {...binding, accepted: {...accepted, routes}};
}

// --- a replacement op exists: the graph decides -------------------------------------------------------------------------

async function composed(installed: InstalledReplacementTrust,
  decision: Exclude<TreehouseCatalogTrustDecision, {kind: "reject"}>, extra: SidecarExtra, ops: Set<string>):
  Promise<ReplacementTrustResult> {
  const trust = decision.next;
  const keys = catalogKeys(trust);
  const rotations = readyRotations(extra.rotations ?? [], ops, keys);
  for (const [id, envelope] of rotations.admitted) keys.set(id, envelope.rotation.newCatalogKey);
  const ready0 = readyCatalogs(extra.catalogs, new Set([...ops, ...rotations.admitted.keys()]), keys);
  const ready = ready0.ready;
  extra = putExtra(ready0.kept, rotations.kept);
  const owned = new Set([...ops, ...rotations.keptIds]);
  const input = await graphInput(installed, trust, ready, rotations.admitted);
  if (input === null) return recovery("trust_recovery_required");
  const result = await resolveCatalogBindingGraph(input);
  // As the trust evaluator reports a retained rotation without its first catalog, an admitted sidecar rotation the graph keeps
  // open whose catalog is not held keeps the reason trust_pending.
  const waiting = ready0.waiting + rotations.waiting + unbound(result, rotations.admitted, ready, trust);
  const advanced = advanceCatalogBindingState(installed.binding, result);
  const routes = serve(result, advanced, installed);
  // A replace-shaped op engages composition only when the resolver treats it as a replacement node or as raw refusal
  // evidence; a malformed or unauthorized op that is neither changes nothing.
  if (!engaged(result)) return mirrored(installed, decision, extra, owned);
  // A trust block is superseded only by the serving catalog of a replacement node the graph honors.
  if (trust.blocked !== null && !(supersedable(trust, decision) && supersedes(result, advanced, routes))) {
    return {...mirrored(installed, decision, extra, owned), refused: result.ok ? Object.fromEntries(result.graph.rawEvidence) : {}};
  }
  const binding: CatalogBindingState = {accepted: advanced.accepted, frozen: advanced.frozen};
  const next: InstalledReplacementTrust = {trust, binding, extra, routes: advanced.serving === null ? installed.routes : routes};
  return {kind: same(next, installed) ? "unchanged" : "propose", reason: reasonOf(result) ?? (waiting > 0 ? "trust_pending" : null),
    refused: result.ok ? Object.fromEntries(result.graph.rawEvidence) : {}, next, routes, servedOrigin: originOf(routes),
    trustDecision: decision};
}

function engaged(result: Awaited<ReturnType<typeof resolveCatalogBindingGraph>>): boolean {
  if (!result.ok) return true;
  return [...result.graph.nodes.values()].some((n) => n.kind === "replacement") || result.graph.rawEvidence.size > 0;
}

// Only the block classes the replacement graph resolves may be superseded (D-882); see the file header.
function supersedable(trust: InstalledTreehouseCatalogTrustV1,
  decision: Exclude<TreehouseCatalogTrustDecision, {kind: "reject"}>): boolean {
  const block = trust.blocked;
  if (block === null || (block.reason !== "authority_changed" && block.reason !== "catalog_fork")) return false;
  if (block.bootstrapIds.length > 0 || block.triggers.length > 0) return false;
  return decision.observed.bootstrapIds.every((id) => trust.review.observedBootstrapIds.includes(id));
}

function supersedes(result: Awaited<ReturnType<typeof resolveCatalogBindingGraph>>,
  advanced: {serving: string | null}, routes: readonly VerifiedTreehouseCatalogRoute[]): boolean {
  if (!result.ok || advanced.serving === null || routes.length === 0) return false;
  const catalog = result.graph.catalogs.get(advanced.serving);
  return catalog !== undefined && result.graph.nodes.get(catalog.binding)?.kind === "replacement";
}

// Sidecar catalogs whose binding is a held replacement op reach the graph, and only after their signature verifies against that
// op's catalog key: an unverifiable variant is dropped for good and a catalog id is admitted once (the graph input is keyed by
// catalog id, which excludes the signature). A catalog bound to an op that is not held waits, unverified.
function readyCatalogs(jsons: string[], ops: ReadonlySet<string>, keys: ReadonlyMap<string, string>):
  {ready: string[]; waiting: number; kept: string[]} {
  const ready: string[] = [], waiting: string[] = [], seen = new Set<string>();
  for (const json of jsons) {
    const envelope = decodeCatalog(json);
    if (envelope === null || !ops.has(envelope.catalog.binding)) { waiting.push(json); continue; }
    const key = keys.get(envelope.catalog.binding);
    if (key === undefined || !verifyCatalogEnvelope(envelope, key)) continue;
    const id = transportCatalogId(envelope.catalog);
    if (!seen.has(id)) { seen.add(id); ready.push(json); }
  }
  return {ready, waiting: waiting.length, kept: [...ready, ...waiting].sort(compareUtf8)};
}

// Row 526: sidecar rotations reach the graph only after their signatures verify against their parent's catalog key, to a
// fixpoint: the key a replacement op claims, or the new key of a rotation already admitted here. A rotation whose parent key is
// known and does not verify, or whose parent is a replacement op with no key (wrong arity, D-881), is dropped for good. One
// whose parent is not yet resolvable waits; that includes a child of a dropped variant, which stays trust_pending (the sidecar
// has no budget, row 355). The id covers the signatures, so a forged variant never replaces an authentic one.
function readyRotations(jsons: readonly string[], ops: ReadonlySet<string>, keys: ReadonlyMap<string, string>):
  {admitted: Map<string, CatalogRotationEnvelope>; waiting: number; kept: string[]; keptIds: string[]} {
  const admitted = new Map<string, {json: string; envelope: CatalogRotationEnvelope}>();
  let pending: {json: string; id: string; envelope: CatalogRotationEnvelope}[] = [];
  for (const json of jsons) {
    const envelope = decodeRotation(json);
    if (envelope !== null) pending.push({json, id: catalogRotationId(envelope), envelope});
  }
  for (;;) {
    const waiting: typeof pending = [];
    let progress = false;
    for (const entry of pending) {
      const parent = entry.envelope.rotation.parent;
      let key: string | undefined;
      const viaRotation = admitted.get(parent);
      if (viaRotation !== undefined) key = viaRotation.envelope.rotation.newCatalogKey;
      else if (ops.has(parent)) key = keys.get(parent);
      else { waiting.push(entry); continue; }
      progress = true;
      if (key === undefined || admitted.has(entry.id) || !verifyCatalogRotationEnvelope(entry.envelope, key)) continue;
      admitted.set(entry.id, {json: entry.json, envelope: entry.envelope});
    }
    pending = waiting;
    if (!progress || waiting.length === 0) break;
  }
  return {admitted: new Map([...admitted].map(([id, a]) => [id, a.envelope])), waiting: pending.length,
    kept: [...[...admitted.values()].map((a) => a.json), ...pending.map((p) => p.json)],
    keptIds: [...admitted.keys(), ...pending.map((p) => p.id)]};
}

// Only an admitted rotation the graph keeps open (a head that is not refused) waits for its first catalog; one closed out,
// refused or not a node explains nothing. An error result has its own reason.
function unbound(result: Awaited<ReturnType<typeof resolveCatalogBindingGraph>>, admitted: ReadonlyMap<string, unknown>,
  ready: readonly string[], trust: InstalledTreehouseCatalogTrustV1): number {
  if (!result.ok) return 0;
  const graph = result.graph, heads = new Set(graph.heads);
  const bindings = new Set<string>();
  for (const json of [...ready, ...trust.catalogs.map((c) => c.json)]) {
    const envelope = decodeCatalog(json);
    if (envelope !== null) bindings.add(envelope.catalog.binding);
  }
  return [...admitted.keys()].filter((id) => heads.has(id) && !bindings.has(id) && graph.nodes.get(id)?.refused !== true).length;
}

// Row 526: after the trust evaluator, each candidate rotation (one whose parent it does not know) must reach a replacement op in
// the retained Space history or a held sidecar rotation, possibly through other candidates. null when any reaches neither.
function classifyRotations(candidates: readonly Candidate[], trust: InstalledTreehouseCatalogTrustV1, held: readonly string[]):
  string[] | null {
  if (candidates.length === 0) return [];
  const reachable = new Set<string>(replaceIds(trust));
  for (const json of held) {
    const envelope = decodeRotation(json);
    if (envelope !== null) reachable.add(catalogRotationId(envelope));
  }
  let rest = [...candidates];
  for (;;) {
    const inReach = new Set(rest.filter((c) => reachable.has(c.parent)));
    if (inReach.size === 0) break;
    for (const c of inReach) reachable.add(c.id);
    // Remove what was admitted, not what is reachable now: the next layer's parents just became reachable.
    rest = rest.filter((c) => !inReach.has(c));
    if (rest.length === 0) break;
  }
  return rest.length === 0 ? candidates.map((c) => c.json) : null;
}

// The catalog key each replacement op claims, for ops whose claim decodes. The command decoder requires three arguments, so a
// catalog bound to an op of any other arity has no key and is dropped; the Elixir twin matches `[claim, _, _]` (D-881).
function catalogKeys(trust: InstalledTreehouseCatalogTrustV1): Map<string, string> {
  const keys = new Map<string, string>();
  try {
    const space = trust.histories.find((h) => h.replica === trust.review.space);
    if (space === undefined) return keys;
    const frames = space.frames.map((f) => decodeCarrierOpFrame(structuredClone(f)));
    for (const op of carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"))) {
      if (op.command !== "replace_catalog_v1" || op.commandError !== undefined || !Array.isArray(op.commandArgs)) continue;
      const claim = op.commandArgs[0] as {newCatalogKey?: unknown} | null | undefined;
      if (claim !== null && claim !== undefined && typeof claim.newCatalogKey === "string") keys.set(op.id, claim.newCatalogKey);
    }
  } catch { /* an undecodable history yields no keys; the graph then refuses the page as malformed input */ }
  return keys;
}

function recovery(reason: TreehouseCatalogTrustReason): ReplacementTrustResult {
  return {kind: "reject", reason, detail: {ids: [], coreReason: null, pendingProofIds: []}};
}

function reasonOf(result: Awaited<ReturnType<typeof resolveCatalogBindingGraph>>): string | null {
  if (!result.ok) return result.reason;
  const d = result.graph.decision;
  return d.block?.reason ?? d.reason;
}

// The serving catalog's routes from its graph node; on a pending delivery the stored table, and only while it is still the
// accepted catalog's.
function serve(result: Awaited<ReturnType<typeof resolveCatalogBindingGraph>>,
  advanced: {accepted: CatalogBindingAccepted | null; serving: string | null}, installed: InstalledReplacementTrust):
  VerifiedTreehouseCatalogRoute[] {
  const serving = advanced.serving;
  if (serving === null) return [];
  if (result.ok) {
    const catalog = result.graph.catalogs.get(serving);
    const node = catalog && result.graph.nodes.get(catalog.binding);
    if (catalog && node) return build(serving, catalog, node.origin);
  }
  return advanced.accepted?.catalog === serving ? installed.routes : [];
}

function build(id: string, catalog: TransportCatalog, origin: string): VerifiedTreehouseCatalogRoute[] {
  return catalog.entries.map((e) => ({replica: e.replica, kind: e.kind, schema: e.schema, root: e.root, genesis: e.genesis,
    creation: e.creation, reference: e.reference, binding: catalog.binding, catalog: id, revision: catalog.revision, origin,
    path: e.route, url: origin + e.route, serviceId: e.serviceId, serviceKey: e.serviceKey, realm: catalogServiceRealm(e.serviceId)}));
}

const originOf = (routes: readonly VerifiedTreehouseCatalogRoute[]): string | null => routes[0]?.origin ?? null;

// --- the graph's input, rebuilt from the retained evidence ------------------------------------------------------------

async function graphInput(installed: InstalledReplacementTrust, trust: InstalledTreehouseCatalogTrustV1,
  ready: string[], admitted: ReadonlyMap<string, CatalogRotationEnvelope>): Promise<CatalogBindingGraphInput | null> {
  const space = trust.histories.find((h) => h.replica === trust.review.space);
  if (space === undefined) return null;
  const observed = await treehouseCatalogBootstrapsFromFrames(space);
  if (!observed.ok) return null;
  const bootstrap = observed.bootstraps.find((b) => b.id === trust.review.bootstrapId);
  if (bootstrap === undefined) return null;
  const catalogs = new Map<string, CatalogEnvelope>();
  for (const json of [...trust.catalogs.map((c) => c.json), ...ready]) {
    const envelope = decodeCatalog(json);
    if (envelope === null) return null;
    catalogs.set(transportCatalogId(envelope.catalog), envelope);
  }
  const rotations = new Map<string, CatalogRotationEnvelope>();
  for (const record of trust.rotations) {
    const envelope = decodeRotation(record.json);
    if (envelope === null) return null;
    rotations.set(record.id, envelope);
  }
  for (const [id, envelope] of admitted) rotations.set(id, envelope);
  const histories: Record<string, readonly unknown[]> = {};
  for (const h of trust.histories) if (h.replica !== trust.review.space) histories[h.replica] = h.frames;
  return {bootstrap, frames: space.frames, rotations, catalogs, provenCutoffs: trust.cutoffProofs.map((p) => p.cutoff),
    accepted: installed.binding.accepted, histories};
}

function decodeCatalog(json: string): CatalogEnvelope | null {
  const parsed = parseCatalogArtifactJson(json);
  return parsed.ok ? catalogEnvelopeFromCarrierTerm(parsed.value) : null;
}

function decodeRotation(json: string): CatalogRotationEnvelope | null {
  const parsed = parseCatalogArtifactJson(json);
  return parsed.ok ? catalogRotationEnvelopeFromCarrierTerm(parsed.value) : null;
}

// --- partition: the legacy part to the trust evaluator, replacement-bound catalogs to the sidecar ------------------

/** The ids of replace_catalog_v1 ops in the retained Space history. */
function replaceIds(trust: InstalledTreehouseCatalogTrustV1): Set<string> {
  const ids = new Set<string>();
  for (const h of trust.histories) {
    if (h.replica !== trust.review.space) continue;
    for (const frame of h.frames) if (isReplaceFrame(frame)) ids.add((frame as {id: string}).id);
  }
  return ids;
}

function isReplaceFrame(frame: unknown): boolean {
  const f = frame as {kind?: unknown; body?: unknown};
  // As the Elixir `{:replace_catalog_v1, _}` match: a 2-tuple whose first element is the atom (D-881).
  if (f.kind !== "command" || !Array.isArray(f.body) || f.body[0] !== "tuple" || !Array.isArray(f.body[1]) ||
    f.body[1].length !== 2) return false;
  const first = f.body[1][0] as unknown;
  return Array.isArray(first) && first[0] === "atom" && first[1] === "replace_catalog_v1";
}

interface Candidate { json: string; id: string; parent: string }

// A rotation is legacy when its parent is the bootstrap, a retained rotation or (to a fixpoint) another legacy rotation on this
// page; an undecodable one is the trust evaluator's to refuse. Every other rotation is a candidate (row 526). A catalog bound to
// a legacy binding is legacy; the rest are bound for the sidecar. A held sidecar catalog whose binding is now legacy is revived
// (row 527) and goes to the trust evaluator with this page.
function split(installed: InstalledReplacementTrust, incoming: TreehouseCatalogEvidencePage):
  {legacy: TreehouseCatalogEvidencePage; candidates: Candidate[]; bound: string[]; revived: string[]} {
  try {
    const known = new Set<string>([installed.trust.review.bootstrapId, ...installed.trust.rotations.map((r) => r.id)]);
    let rest: Candidate[] = [];
    for (const json of incoming.rotations) {
      const envelope = decodeRotation(json);
      if (envelope !== null) rest.push({json, id: catalogRotationId(envelope), parent: envelope.rotation.parent});
    }
    for (;;) {
      const legacy = new Set(rest.filter((c) => known.has(c.parent)));
      if (legacy.size === 0) break;
      for (const c of legacy) known.add(c.id);
      rest = rest.filter((c) => !legacy.has(c));
    }
    const candidateJsons = new Set(rest.map((c) => c.json));
    const rotations = incoming.rotations.filter((json) => !candidateJsons.has(json));
    const legacyOf = (json: string): boolean | null => {
      const envelope = decodeCatalog(json);
      return envelope === null ? null : known.has(envelope.catalog.binding);
    };
    const legacy: string[] = [], bound: string[] = [];
    for (const json of incoming.catalogs) (legacyOf(json) !== false ? legacy : bound).push(json);
    const revived = installed.extra.catalogs.filter((json) => legacyOf(json) === true);
    return {legacy: {...incoming, catalogs: legacy, rotations}, candidates: rest, bound, revived};
  } catch {
    // A page that cannot be scanned is the trust evaluator's to refuse, whole.
    return {legacy: incoming, candidates: [], bound: [], revived: []};
  }
}

function same(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => compareUtf8(x, y));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
