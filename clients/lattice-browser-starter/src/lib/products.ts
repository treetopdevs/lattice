import {
  analyzeAuthority,
  authorCarrierDelegation,
  authorCarrierOp,
  authorTownshipCommand,
  authorTreehouseCommand,
  base64ToBytes,
  canonicalOrder,
  carrierDelegationsFromFrames,
  carrierOpsToSemanticOps,
  custodyConsentPayload,
  frontier,
  index,
  materialize,
  observeTreehouse,
  townshipCapTerm,
  treehouseCommandDecoders,
  treehouseSpaceSchema,
  treehouseThreadSchema,
  type AuthorityAnalysis,
  type CarrierDelegation,
  type CarrierOpFrame,
  type CarrierOpSigner,
  type CarrierTerm,
  type CommandDecoder,
  type CommandDecoderMap,
  type DecodedTerm,
  type Op,
  type Payload,
  type ReplicaSchema,
  type TownshipCommand,
  type TreehouseCommand,
} from "@treetopdevs/lattice-client";
import { bytesToBase64, pubkeyFingerprint } from "./custody";

export type DemoProduct =
  | "Treehouse.Space"
  | "Treehouse.Thread"
  | "Township.Matter"
  | "Toolshed.Shed"
  | "Toolshed.Tool";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

function textBin(text: string): CarrierTerm {
  return ["bin", bytesToBase64(textEncoder.encode(text))];
}

function decodedText(term: DecodedTerm | undefined): string {
  if (typeof term === "string") return term;
  if (term && typeof term === "object" && "type" in term && term.type === "bin") {
    return textDecoder.decode(term.bytes);
  }
  return String(term ?? "");
}

function decodedBytes(term: DecodedTerm | undefined): Uint8Array | null {
  if (term && typeof term === "object" && "type" in term && term.type === "bin") {
    return term.bytes;
  }
  return null;
}

function makeCommandDecoder(
  arity: number,
  decode: (args: DecodedTerm[], realmByPubkey: Record<string, string>) => Payload,
): CommandDecoder {
  return { arity, decode };
}

function makeDecoderMap(
  entries: [string, CommandDecoder][],
  product?: string,
): CommandDecoderMap {
  const map = new Map<string, CommandDecoder>(entries) as CommandDecoderMap & { product?: string };
  if (product) map.product = product;
  return map;
}

function runAuthority(schema: ReplicaSchema, ops: Op[]): {
  byId: Map<string, Op>;
  order: string[];
  orderedOps: Op[];
  analysis: AuthorityAnalysis;
} {
  const byId = index(ops);
  const order = canonicalOrder(ops, byId);
  const included = new Set(order);
  const analysis = analyzeAuthority(schema, ops, included, order, byId);
  const orderedOps: Op[] = [];
  for (const id of order) {
    const op = byId.get(id);
    if (op) orderedOps.push(op);
  }
  return { byId, order, orderedOps, analysis };
}

function currentBeaconEpoch(analysis: AuthorityAnalysis): number | null {
  let max: number | null = null;
  for (const b of analysis.security.validBeacons) {
    const n = typeof b.epoch === "number" ? b.epoch : Number(b.epoch);
    if (Number.isSafeInteger(n) && (max === null || n > max)) {
      max = n;
    }
  }
  return max;
}

function effectiveRevokedIds(analysis: AuthorityAnalysis): Set<string> {
  return new Set(analysis.security.effectiveRevokes.map((r) => r.delegationId));
}

function currentRoleHolder(analysis: AuthorityAnalysis, role: string): {
  holder: string | null;
  holderPubkey: string | null;
} {
  const acquires = analysis.acquiresByRole.get(role);
  if (!acquires || acquires.length === 0) return { holder: null, holderPubkey: null };
  const last = acquires[acquires.length - 1]!;
  return { holder: last.holder, holderPubkey: last.holderPubkey ?? null };
}

// ── Township.Matter ──────────────────────────────────────────────────────────

export const townshipMatterSchema: ReplicaSchema = {
  name: "Township.Matter",
  fields: {
    title: { merge: "lww", default: "" },
    summary: { merge: "lww", default: "" },
    posts: { merge: "causal_list" },
    members: { merge: "or_set" },
    clerk_locked: { merge: "lww", gatedBy: "clerk", default: false },
    clerk: { authority: "clerk" },
  },
};

export const townshipMatterDecoders: CommandDecoderMap = makeDecoderMap([
  [
    "set_title",
    makeCommandDecoder(1, (args) => ({
      field: "title",
      mutation: "write",
      value: decodedText(args[0]),
      command: "set_title",
    })),
  ],
  [
    "set_summary",
    makeCommandDecoder(1, (args) => ({
      field: "summary",
      mutation: "write",
      value: decodedText(args[0]),
      command: "set_summary",
    })),
  ],
  [
    "post",
    makeCommandDecoder(1, (args) => ({
      field: "posts",
      mutation: "append",
      value: decodedText(args[0]),
      command: "post",
    })),
  ],
  [
    "admit",
    makeCommandDecoder(1, (args) => ({
      field: "members",
      mutation: "add",
      value: decodedText(args[0]),
      command: "admit",
    })),
  ],
  [
    "remove_member",
    makeCommandDecoder(1, (args) => ({
      field: "members",
      mutation: "remove",
      value: decodedText(args[0]),
      command: "remove_member",
    })),
  ],
  [
    "link_election",
    makeCommandDecoder(1, () => ({
      field: "__authority",
      mutation: "write",
      value: null,
      command: "link_election",
    })),
  ],
  [
    "close_matter",
    makeCommandDecoder(0, () => ({
      field: "clerk_locked",
      mutation: "write",
      value: true,
      command: "close_matter",
    })),
  ],
  [
    "reopen_matter",
    makeCommandDecoder(0, () => ({
      field: "clerk_locked",
      mutation: "write",
      value: false,
      command: "reopen_matter",
    })),
  ],
]);

// ── Toolshed.Shed ────────────────────────────────────────────────────────────

export const toolshedShedSchema: ReplicaSchema = {
  name: "Toolshed.Shed",
  fields: {
    name: { merge: "lww", default: "" },
    neighbors: { merge: "or_set" },
    inventory: { merge: "or_set" },
    bulletin: { merge: "lww", gatedBy: "steward", default: "" },
    steward: { authority: "steward" },
  },
};

export const toolshedShedDecoders: CommandDecoderMap = makeDecoderMap([
  [
    "set_name",
    makeCommandDecoder(1, (args) => ({
      field: "name",
      mutation: "write",
      value: decodedText(args[0]),
      command: "set_name",
    })),
  ],
  [
    "vouch_in",
    makeCommandDecoder(1, (args) => ({
      field: "neighbors",
      mutation: "add",
      value: decodedText(args[0]),
      command: "vouch_in",
    })),
  ],
  [
    "drop_neighbor",
    makeCommandDecoder(1, (args) => ({
      field: "neighbors",
      mutation: "remove",
      value: decodedText(args[0]),
      command: "drop_neighbor",
    })),
  ],
  [
    "list_tool",
    makeCommandDecoder(1, (args) => ({
      field: "inventory",
      mutation: "add",
      value: decodedText(args[0]),
      command: "list_tool",
    })),
  ],
  [
    "delist_tool",
    makeCommandDecoder(1, (args) => ({
      field: "inventory",
      mutation: "remove",
      value: decodedText(args[0]),
      command: "delist_tool",
    })),
  ],
  [
    "post_bulletin",
    makeCommandDecoder(1, (args) => ({
      field: "bulletin",
      mutation: "write",
      value: decodedText(args[0]),
      command: "post_bulletin",
    })),
  ],
]);

export type ToolshedShedCommand =
  | { command: "set_name"; text: string }
  | { command: "vouch_in"; neighbor: string }
  | { command: "drop_neighbor"; neighbor: string }
  | { command: "list_tool"; toolReplica: string }
  | { command: "delist_tool"; toolReplica: string }
  | { command: "post_bulletin"; text: string };

export async function authorToolshedShedCommand(input: {
  replica: string;
  deps: string[];
  signer: CarrierOpSigner;
  capId: string | null;
  command: ToolshedShedCommand;
}): Promise<CarrierOpFrame> {
  let argText: string;
  switch (input.command.command) {
    case "set_name":
    case "post_bulletin":
      argText = input.command.text;
      break;
    case "vouch_in":
    case "drop_neighbor":
      argText = input.command.neighbor;
      break;
    case "list_tool":
    case "delist_tool":
      argText = input.command.toolReplica;
      break;
  }
  const body: CarrierTerm = [
    "tuple",
    [["atom", input.command.command], ["list", [textBin(argText)]]],
  ];
  return authorCarrierOp({
    replica: input.replica,
    deps: input.deps,
    signer: input.signer,
    kind: "command",
    cap: townshipCapTerm(input.capId),
    body,
  });
}

// ── Toolshed.Tool (ADR 0007 Dual-Signed Custody + Q-06 Requests + Leases) ───

export const toolshedToolSchema: ReplicaSchema = {
  name: "Toolshed.Tool",
  fields: {
    description: { merge: "lww", default: "" },
    condition_notes: { merge: "causal_list" },
    holder: { merge: "lww", gatedBy: "custody", default: null },
    custody: { authority: "custody" },
  },
  consentCommands: ["custody_transfer"],
};

export const toolshedToolDecoders: CommandDecoderMap = makeDecoderMap([
  [
    "describe",
    makeCommandDecoder(1, (args) => ({
      field: "description",
      mutation: "write",
      value: decodedText(args[0]),
      command: "describe",
    })),
  ],
  [
    "note_condition",
    makeCommandDecoder(1, (args) => ({
      field: "condition_notes",
      mutation: "append",
      value: decodedText(args[0]),
      command: "note_condition",
    })),
  ],
  [
    "custody_transfer",
    makeCommandDecoder(3, (args, realmByPubkey) => {
      const toBytes = decodedBytes(args[0]);
      const toPub = toBytes === null ? "" : bytesToBase64(toBytes);
      const requestOpId = decodedText(args[1]);
      const sigBytes = decodedBytes(args[2]);
      return {
        field: "holder",
        mutation: "write",
        value: toPub ? (realmByPubkey[toPub] ?? toPub) : null,
        command: "custody_transfer",
        consent: {
          toPub,
          requestOpId,
          sig: args[2] === null || sigBytes === null ? null : bytesToBase64(sigBytes),
        },
      };
    }),
  ],
]);

export type ToolshedToolCommand =
  | { command: "describe"; text: string }
  | { command: "note_condition"; text: string }
  | {
      command: "custody_transfer";
      toPubkeyBase64: string;
      requestOpId: string;
      consentSigBase64: string | null;
    };

export async function authorToolshedToolCommand(input: {
  replica: string;
  deps: string[];
  signer: CarrierOpSigner;
  capId: string | null;
  command: ToolshedToolCommand;
}): Promise<CarrierOpFrame> {
  let body: CarrierTerm;
  switch (input.command.command) {
    case "describe":
    case "note_condition":
      body = [
        "tuple",
        [["atom", input.command.command], ["list", [textBin(input.command.text)]]],
      ];
      break;
    case "custody_transfer":
      body = [
        "tuple",
        [
          ["atom", "custody_transfer"],
          [
            "list",
            [
              ["bin", input.command.toPubkeyBase64],
              textBin(input.command.requestOpId),
              input.command.consentSigBase64 === null
                ? ["nil"]
                : ["bin", input.command.consentSigBase64],
            ],
          ],
        ],
      ];
      break;
  }
  return authorCarrierOp({
    replica: input.replica,
    deps: input.deps,
    signer: input.signer,
    kind: "command",
    cap: townshipCapTerm(input.capId),
    body,
  });
}

/**
 * Author a durable Q-06 `:inbox` borrow or return request on a `Toolshed.Tool` replica.
 * Uses only wire-vocabulary atoms (`request`, `custody_transfer`) and UTF-8 binaries.
 */
export async function authorToolshedRequest(input: {
  replica: string;
  deps: string[];
  signer: CarrierOpSigner;
  requestKind: "borrow" | "return";
  ref?: string;
}): Promise<CarrierOpFrame> {
  const args: CarrierTerm[] = input.requestKind === "return" ? [textBin("return")] : [];
  const body: CarrierTerm = [
    "tuple",
    [
      ["atom", "request"],
      textBin(input.ref ?? "custody"),
      ["tuple", [["atom", "custody_transfer"], ["list", args]]],
    ],
  ];
  return authorCarrierOp({
    replica: input.replica,
    deps: input.deps,
    signer: input.signer,
    kind: "inbox",
    cap: ["nil"],
    body,
  });
}

/**
 * Sign the ADR 0007 dual-signed custody consent bytes as the recipient (`toPub`).
 * `fromPubkeyBase64` is the current custody holder authoring `:custody_transfer`.
 */
export async function signToolshedCustodyConsent(input: {
  replica: string;
  requestOpId: string;
  fromPubkeyBase64: string;
  recipientSigner: CarrierOpSigner;
}): Promise<string> {
  const payload = custodyConsentPayload(
    input.replica,
    input.requestOpId,
    base64ToBytes(input.fromPubkeyBase64),
    input.recipientSigner.publicKey,
  );
  const sig = await input.recipientSigner.sign(payload);
  return bytesToBase64(sig);
}

/** Author a leased borrow Cap (`expires_epoch`) on `Toolshed.Tool` (plan 149). */
export async function authorToolshedBorrowGrant(input: {
  replica: string;
  deps: string[];
  parentDelegationId: string;
  borrowerPubkeyBase64: string;
  expiresEpoch: number;
  signer: CarrierOpSigner;
}): Promise<CarrierOpFrame> {
  const delegation = await authorCarrierDelegation({
    replica: input.replica,
    audiencePubkey: input.borrowerPubkeyBase64,
    parentId: input.parentDelegationId,
    ops: ["note_condition"],
    roles: [],
    live: false,
    expiresEpoch: input.expiresEpoch,
    signer: input.signer,
  });
  return authorCarrierOp({
    replica: input.replica,
    deps: input.deps,
    signer: input.signer,
    kind: "authority",
    cap: ["nil"],
    body: ["tuple", [["atom", "grant"], ["delegation", delegation]]],
  });
}

/** Author a root-signed logical epoch beacon (`{:beacon, epoch}`) to test lease expiry. */
export async function authorToolshedBeacon(input: {
  replica: string;
  deps: string[];
  epoch: number;
  signer: CarrierOpSigner;
}): Promise<CarrierOpFrame> {
  return authorCarrierOp({
    replica: input.replica,
    deps: input.deps,
    signer: input.signer,
    kind: "authority",
    cap: ["nil"],
    body: ["tuple", [["atom", "beacon"], ["int", input.epoch]]],
  });
}

// ── Shared Dispatch & Projections ────────────────────────────────────────────

export function schemaForProduct(product: DemoProduct): ReplicaSchema {
  switch (product) {
    case "Treehouse.Space":
      return treehouseSpaceSchema;
    case "Treehouse.Thread":
      return treehouseThreadSchema;
    case "Township.Matter":
      return townshipMatterSchema;
    case "Toolshed.Shed":
      return toolshedShedSchema;
    case "Toolshed.Tool":
      return toolshedToolSchema;
  }
}

export function decodersForProduct(product: DemoProduct): CommandDecoderMap {
  switch (product) {
    case "Treehouse.Space":
      return treehouseCommandDecoders("Treehouse.Space");
    case "Treehouse.Thread":
      return treehouseCommandDecoders("Treehouse.Thread");
    case "Township.Matter":
      return townshipMatterDecoders;
    case "Toolshed.Shed":
      return toolshedShedDecoders;
    case "Toolshed.Tool":
      return toolshedToolDecoders;
  }
}

export function framesToOps(
  product: DemoProduct,
  frames: CarrierOpFrame[],
  realmByPubkey: Record<string, string>,
): Op[] {
  return carrierOpsToSemanticOps(frames, realmByPubkey, decodersForProduct(product));
}

export function frontierIds(frames: CarrierOpFrame[]): string[] {
  const ops = frames.map((frame) => ({
    id: frame.id,
    deps: frame.deps,
  })) as unknown as Op[];
  return frontier(ops);
}

/** Pick the best currently valid delegation id authorizing `commandName` for `pubkeyBase64`. */
export function pickCapabilityForCommand(
  product: DemoProduct,
  frames: CarrierOpFrame[],
  pubkeyBase64: string,
  commandName: string,
  realmByPubkey: Record<string, string>,
): string | null {
  const ops = framesToOps(product, frames, realmByPubkey);
  const schema = schemaForProduct(product);
  const { analysis } = runAuthority(schema, ops);
  const delegations = carrierDelegationsFromFrames(frames);
  const revoked = effectiveRevokedIds(analysis);
  const epoch = currentBeaconEpoch(analysis);

  let chosen: CarrierDelegation | null = null;
  for (const d of delegations) {
    if (d.audience !== pubkeyBase64) continue;
    if (!d.ops.includes(commandName)) continue;
    if (revoked.has(d.id)) continue;
    const record = analysis.security.delegations.get(d.id);
    if (record && !record.validation.valid) continue;
    if (d.expires_epoch !== undefined && epoch !== null && epoch > d.expires_epoch) {
      continue;
    }
    chosen = d;
  }
  return chosen?.id ?? null;
}

/** Pick the caller's root/genesis delegation id (useful for issuing child grants). */
export function pickRootDelegationId(
  frames: CarrierOpFrame[],
  pubkeyBase64: string,
): string | null {
  const delegations = carrierDelegationsFromFrames(frames);
  const root = delegations.find((d) => d.parent_id === null && d.audience === pubkeyBase64);
  return root?.id ?? null;
}

export interface TownshipMatterView {
  title: string;
  summary: string;
  members: string[];
  posts: { id: string; author: string; text: string }[];
  clerkLocked: boolean;
  clerkHolder: string | null;
  quarantinedCount: number;
}

export function observeTownshipMatter(
  frames: CarrierOpFrame[],
  realmByPubkey: Record<string, string>,
): TownshipMatterView {
  const ops = framesToOps("Township.Matter", frames, realmByPubkey);
  const projection = materialize(townshipMatterSchema, ops);
  const { orderedOps, analysis } = runAuthority(townshipMatterSchema, ops);
  const posts: TownshipMatterView["posts"] = [];
  for (const op of orderedOps) {
    if (
      op.kind === "command" &&
      op.command === "post" &&
      !projection.quarantineReasons.has(op.id)
    ) {
      posts.push({ id: op.id, author: op.author, text: String(op.value ?? "") });
    }
  }
  return {
    title: String(projection.state.title ?? ""),
    summary: String(projection.state.summary ?? ""),
    members: Array.isArray(projection.state.members)
      ? (projection.state.members as string[])
      : [],
    posts,
    clerkLocked: Boolean(projection.state.clerk_locked),
    clerkHolder: currentRoleHolder(analysis, "clerk").holder,
    quarantinedCount: projection.quarantineReasons.size,
  };
}

export interface ToolshedShedView {
  name: string;
  neighbors: string[];
  inventory: string[];
  bulletin: string;
  stewardHolder: string | null;
  quarantinedCount: number;
}

export function observeToolshedShed(
  frames: CarrierOpFrame[],
  realmByPubkey: Record<string, string>,
): ToolshedShedView {
  const ops = framesToOps("Toolshed.Shed", frames, realmByPubkey);
  const projection = materialize(toolshedShedSchema, ops);
  const { analysis } = runAuthority(toolshedShedSchema, ops);
  return {
    name: String(projection.state.name ?? ""),
    neighbors: Array.isArray(projection.state.neighbors)
      ? (projection.state.neighbors as string[])
      : [],
    inventory: Array.isArray(projection.state.inventory)
      ? (projection.state.inventory as string[])
      : [],
    bulletin: String(projection.state.bulletin ?? ""),
    stewardHolder: currentRoleHolder(analysis, "steward").holder,
    quarantinedCount: projection.quarantineReasons.size,
  };
}

export interface ToolshedToolRequest {
  opId: string;
  authorPubkey: string;
  authorLabel: string;
  ref: string;
  requestKind: "borrow" | "return";
  resolved: boolean;
}

export interface ToolshedToolView {
  listing: {
    description: string;
    conditionNotes: string[];
  };
  custody: {
    holder: string | null;
    holderPubkey: string | null;
    homeHolder: string | null;
    homeHolderPubkey: string | null;
    available: boolean;
  };
  loan: {
    borrower: string;
    borrowerPubkey: string;
    dueEpoch: number | null;
    overdue: boolean;
  } | null;
  currentEpoch: number | null;
  requests: ToolshedToolRequest[];
  quarantinedCount: number;
}

function decodeInboxRequestFrame(
  frame: CarrierOpFrame,
  realmByPubkey: Record<string, string>,
): Omit<ToolshedToolRequest, "resolved"> | null {
  if (frame.kind !== "inbox") return null;
  const body = frame.body;
  if (!Array.isArray(body) || body[0] !== "tuple" || !Array.isArray(body[1])) return null;
  const elems = body[1] as CarrierTerm[];
  if (elems.length !== 3) return null;
  const tag = elems[0];
  if (!Array.isArray(tag) || tag[0] !== "atom" || tag[1] !== "request") return null;
  const refTerm = elems[1];
  const ref =
    Array.isArray(refTerm) && refTerm[0] === "bin" && typeof refTerm[1] === "string"
      ? textDecoder.decode(base64ToBytes(refTerm[1]))
      : "custody";
  let requestKind: "borrow" | "return" = "borrow";
  const payloadTerm = elems[2];
  if (Array.isArray(payloadTerm) && payloadTerm[0] === "tuple" && Array.isArray(payloadTerm[1])) {
    const argsTerm = (payloadTerm[1] as CarrierTerm[])[1];
    if (Array.isArray(argsTerm) && argsTerm[0] === "list" && Array.isArray(argsTerm[1])) {
      const first = (argsTerm[1] as CarrierTerm[])[0];
      if (Array.isArray(first) && first[0] === "bin" && typeof first[1] === "string") {
        if (textDecoder.decode(base64ToBytes(first[1])) === "return") requestKind = "return";
      } else if (Array.isArray(first) && first[0] === "atom" && first[1] === "return") {
        requestKind = "return";
      }
    }
  }
  return {
    opId: frame.id,
    authorPubkey: frame.author,
    authorLabel: realmByPubkey[frame.author] ?? pubkeyFingerprint(frame.author),
    ref,
    requestKind,
  };
}

/**
 * TypeScript projection mirroring Elixir's `Toolshed.ReadModel.observe/1`.
 */
export function observeToolshedTool(
  frames: CarrierOpFrame[],
  realmByPubkey: Record<string, string>,
): ToolshedToolView {
  const ops = framesToOps("Toolshed.Tool", frames, realmByPubkey);
  const projection = materialize(toolshedToolSchema, ops);
  const { orderedOps, analysis } = runAuthority(toolshedToolSchema, ops);
  const frameById = new Map(frames.map((f) => [f.id, f]));
  const epoch = currentBeaconEpoch(analysis);

  const custodyRole = currentRoleHolder(analysis, "custody");
  const homeHolder = custodyRole.holder;
  let homeHolderPubkey = custodyRole.holderPubkey;
  if (!homeHolderPubkey) {
    const delById = new Map(carrierDelegationsFromFrames(frames).map((d) => [d.id, d]));
    for (const op of orderedOps) {
      if (
        op.kind === "authority" &&
        !projection.quarantineReasons.has(op.id) &&
        (op.authority?.type === "genesis" || op.authority?.type === "transfer") &&
        op.authority.delegation.roles.includes("custody")
      ) {
        homeHolderPubkey = delById.get(op.authority.delegation.id)?.audience ?? op.authorPubkey ?? null;
      }
    }
  }

  let holderPubkey: string | null = null;
  const resolvedRequests = new Set<string>();
  for (const op of orderedOps) {
    if (
      op.kind === "command" &&
      op.command === "custody_transfer" &&
      !projection.quarantineReasons.has(op.id) &&
      op.consent
    ) {
      holderPubkey = op.consent.toPub || null;
      resolvedRequests.add(op.consent.requestOpId);
    }
  }

  const holder =
    typeof projection.state.holder === "string" ? projection.state.holder : null;
  const available = holder === null || holder === homeHolder;

  // Derive active loan from latest honored leased grant to the current borrower.
  let loan: ToolshedToolView["loan"] = null;
  if (!available && holderPubkey) {
    const delegations = carrierDelegationsFromFrames(frames);
    let borrowCap: CarrierDelegation | null = null;
    for (const d of delegations) {
      if (d.audience !== holderPubkey || d.expires_epoch === undefined) continue;
      const rec = analysis.security.delegations.get(d.id);
      if (rec && !rec.validation.valid) continue;
      borrowCap = d;
    }
    const dueEpoch = borrowCap?.expires_epoch ?? null;
    const overdue = dueEpoch !== null && epoch !== null && epoch > dueEpoch;
    loan = {
      borrower: holder ?? pubkeyFingerprint(holderPubkey),
      borrowerPubkey: holderPubkey,
      dueEpoch,
      overdue,
    };
  }

  const requests: ToolshedToolRequest[] = [];
  for (const op of orderedOps) {
    const rawFrame = frameById.get(op.id);
    if (!rawFrame) continue;
    const req = decodeInboxRequestFrame(rawFrame, realmByPubkey);
    if (!req) continue;
    requests.push({
      ...req,
      resolved: resolvedRequests.has(req.opId),
    });
  }

  return {
    listing: {
      description: String(projection.state.description ?? ""),
      conditionNotes: Array.isArray(projection.state.condition_notes)
        ? (projection.state.condition_notes as string[])
        : [],
    },
    custody: {
      holder,
      holderPubkey,
      homeHolder,
      homeHolderPubkey,
      available,
    },
    loan,
    currentEpoch: epoch,
    requests,
    quarantinedCount: projection.quarantineReasons.size,
  };
}

export interface InspectedOpRow {
  id: string;
  shortId: string;
  author: string;
  kind: Op["kind"];
  command: string;
  cap: string | null;
  depsCount: number;
  quarantined: boolean;
  reason: string | null;
}

export interface ReplicaInspection {
  product: DemoProduct;
  opCount: number;
  honoredCount: number;
  quarantinedCount: number;
  currentEpoch: number | null;
  holders: Record<string, string>;
  delegations: {
    id: string;
    issuer: string;
    audience: string;
    ops: string[];
    roles: string[];
    expiresEpoch: number | null;
    revoked: boolean;
  }[];
  ops: InspectedOpRow[];
}

export function inspectReplicaLog(
  product: DemoProduct,
  frames: CarrierOpFrame[],
  realmByPubkey: Record<string, string>,
): ReplicaInspection {
  const ops = framesToOps(product, frames, realmByPubkey);
  const schema = schemaForProduct(product);
  const projection = materialize(schema, ops);
  const { orderedOps, analysis } = runAuthority(schema, ops);
  const rawDelegations = carrierDelegationsFromFrames(frames);
  const revoked = effectiveRevokedIds(analysis);
  const epoch = currentBeaconEpoch(analysis);

  const holders: Record<string, string> = {};
  for (const [role, acquires] of analysis.acquiresByRole.entries()) {
    if (acquires.length > 0) {
      holders[role] = acquires[acquires.length - 1]!.holder;
    }
  }

  const rows: InspectedOpRow[] = orderedOps.map((op) => {
    const reason = projection.quarantineReasons.get(op.id) ?? null;
    return {
      id: op.id,
      shortId: op.id.slice(0, 10),
      author: op.author,
      kind: op.kind,
      command: op.command ?? op.kind,
      cap: op.cap ? op.cap.slice(0, 10) : null,
      depsCount: op.deps.length,
      quarantined: reason !== null,
      reason,
    };
  });

  return {
    product,
    opCount: rows.length,
    honoredCount: rows.filter((r) => !r.quarantined).length,
    quarantinedCount: rows.filter((r) => r.quarantined).length,
    currentEpoch: epoch,
    holders,
    delegations: rawDelegations.map((d) => ({
      id: d.id,
      issuer: realmByPubkey[d.issuer] ?? pubkeyFingerprint(d.issuer),
      audience: realmByPubkey[d.audience] ?? pubkeyFingerprint(d.audience),
      ops: [...d.ops],
      roles: [...d.roles],
      expiresEpoch: d.expires_epoch ?? null,
      revoked: revoked.has(d.id),
    })),
    ops: rows,
  };
}

export { authorTownshipCommand, authorTreehouseCommand, observeTreehouse };
export type { TownshipCommand, TreehouseCommand };
