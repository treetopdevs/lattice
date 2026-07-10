import { authorCarrierDelegation, authorCarrierOp, canonicalHash } from "./codec";
import { carrierDelegationsFromFrames, carrierOpsToSemanticOps } from "./carrier";
import { frontier } from "./sync";
import type { AuthorCarrierDelegationInput, AuthorCarrierOpInput, CarrierOpSigner } from "./codec";
import type { CarrierDelegation, CarrierOpFrame, CarrierTerm } from "./carrier";
import type { CarrierFrameStore, LocalOpLogStore } from "./local_log";
import type { Op } from "./op";

export type TownshipCommand =
  | { command: "set_title"; text: string }
  | { command: "set_summary"; text: string }
  | { command: "post"; text: string }
  | { command: "admit"; member: string }
  | { command: "remove_member"; member: string }
  | { command: "close_matter" }
  | { command: "reopen_matter" };

export interface AuthorTownshipCommandInput
  extends Pick<AuthorCarrierOpInput, "replica" | "deps" | "signer"> {
  command: TownshipCommand;
  capId: string | null;
}

export interface AuthorTownshipCommandFromLogInput
  extends Pick<AuthorTownshipCommandInput, "replica" | "command" | "capId" | "signer"> {
  localOps: Op[];
}

export interface AuthorTownshipDelegationInput {
  replica: string;
  deps: string[];
  audiencePubkey: string | Uint8Array;
  parentId?: string | null;
  ops?: readonly string[];
  roles?: readonly string[];
  live?: boolean;
  signer: CarrierOpSigner;
}

export interface TownshipGenesisPolicy {
  successorPubkey: string | Uint8Array;
  dormantTicks: number;
}

export interface AuthorTownshipGenesisInput {
  replica: string;
  ops?: readonly string[];
  roles?: readonly string[];
  live?: boolean;
  policies?: Record<string, TownshipGenesisPolicy>;
  signer: CarrierOpSigner;
}

export interface AuthorTownshipRevocationInput
  extends Pick<AuthorCarrierOpInput, "replica" | "deps" | "signer"> {
  delegationId: string;
}

export interface AuthorAndPersistTownshipCommandInput
  extends Pick<AuthorTownshipCommandInput, "replica" | "command" | "signer"> {
  localLog: LocalOpLogStore;
  carrierFrames: CarrierFrameStore;
  delegationFrames?: CarrierFrameStore;
  realmByPubkey: Record<string, string>;
}

export interface AuthorAndPersistTownshipDelegationInput
  extends Pick<AuthorTownshipDelegationInput, "replica" | "audiencePubkey" | "ops" | "roles" | "live" | "signer"> {
  parentId?: string | null;
  localLog: LocalOpLogStore;
  carrierFrames: CarrierFrameStore;
  delegationFrames?: CarrierFrameStore;
  realmByPubkey: Record<string, string>;
}

export interface AuthorAndPersistTownshipCommandResult {
  frame: CarrierOpFrame;
  op: Op;
  capId: string;
}

export interface AuthorAndPersistTownshipDelegationResult {
  frame: CarrierOpFrame;
  op: Op;
  delegation: CarrierDelegation;
  parentId: string | null;
}

export function townshipCommandBody(command: TownshipCommand): CarrierTerm {
  switch (command.command) {
    case "set_title":
    case "set_summary":
    case "post":
      return commandBody(command.command, [command.text]);
    case "admit":
    case "remove_member":
      return commandBody(command.command, [command.member]);
    case "close_matter":
    case "reopen_matter":
      return commandBody(command.command, []);
  }
}

export function townshipCapTerm(capId: string | null): CarrierTerm {
  return capId === null ? ["nil"] : ["bin", textBase64(capId)];
}

export function townshipGrantBody(delegation: CarrierDelegation): CarrierTerm {
  return ["tuple", [["atom", "grant"], ["delegation", delegation]]];
}

export function townshipGenesisBody(
  delegation: CarrierDelegation,
  policies: Record<string, TownshipGenesisPolicy> = {},
): CarrierTerm {
  return ["tuple", [["atom", "genesis"], ["delegation", delegation], townshipGenesisPoliciesTerm(policies)]];
}

export function townshipRevokeBody(delegationId: string): CarrierTerm {
  return ["tuple", [["atom", "revoke"], ["bin", textBase64(delegationId)]]];
}

export function selectTownshipCapId(
  command: TownshipCommand,
  delegations: CarrierDelegation[],
  audiencePubkey: string | Uint8Array,
): string | null {
  const audience = typeof audiencePubkey === "string" ? audiencePubkey : bytesBase64(audiencePubkey);
  const role = townshipCommandRole(command.command);

  const delegation = delegations.find((candidate) => {
    if (candidate.audience !== audience) return false;
    if (!candidate.ops.includes(command.command)) return false;
    return role === null || candidate.roles.includes(role);
  });

  return delegation?.id ?? null;
}

export function selectTownshipDelegationParentId(
  delegations: readonly CarrierDelegation[],
  issuerPubkey: string | Uint8Array,
  options: {
    replica?: string;
    ops?: readonly string[];
    roles?: readonly string[];
    live?: boolean;
  } = {},
): string | null {
  const issuer = typeof issuerPubkey === "string" ? issuerPubkey : bytesBase64(issuerPubkey);
  const neededOps = new Set(options.ops ?? []);
  const neededRoles = new Set(options.roles ?? []);
  const neededLive = options.live ?? false;

  const delegation = delegations.find((candidate) => {
    if (candidate.audience !== issuer) return false;
    if (options.replica !== undefined && candidate.replica !== options.replica) return false;
    if (neededLive && !candidate.live) return false;
    if (!setSubset(neededOps, candidate.ops)) return false;
    return setSubset(neededRoles, candidate.roles);
  });

  return delegation?.id ?? null;
}

export function authorTownshipCommand(input: AuthorTownshipCommandInput): Promise<CarrierOpFrame> {
  return authorCarrierOp({
    replica: input.replica,
    deps: input.deps,
    kind: "command",
    body: townshipCommandBody(input.command),
    cap: townshipCapTerm(input.capId),
    signer: input.signer,
  });
}

export function authorTownshipCommandFromLog(input: AuthorTownshipCommandFromLogInput): Promise<CarrierOpFrame> {
  return authorTownshipCommand({
    replica: input.replica,
    deps: frontier(input.localOps),
    command: input.command,
    capId: input.capId,
    signer: input.signer,
  });
}

export async function authorTownshipDelegation(input: AuthorTownshipDelegationInput): Promise<CarrierOpFrame> {
  const delegationInput: AuthorCarrierDelegationInput = {
    replica: input.replica,
    audiencePubkey: input.audiencePubkey,
    signer: input.signer,
  };
  if (input.parentId !== undefined) delegationInput.parentId = input.parentId;
  if (input.ops !== undefined) delegationInput.ops = input.ops;
  if (input.roles !== undefined) delegationInput.roles = input.roles;
  if (input.live !== undefined) delegationInput.live = input.live;

  const delegation = await authorCarrierDelegation(delegationInput);

  return authorCarrierOp({
    replica: input.replica,
    deps: input.deps,
    kind: "authority",
    body: townshipGrantBody(delegation),
    cap: ["nil"],
    signer: input.signer,
  });
}

export async function authorTownshipGenesis(input: AuthorTownshipGenesisInput): Promise<CarrierOpFrame> {
  const replica = await bindTownshipReplica(input.replica, input.signer.publicKey);
  const delegationInput: AuthorCarrierDelegationInput = {
    replica,
    audiencePubkey: input.signer.publicKey,
    parentId: null,
    live: input.live ?? true,
    signer: input.signer,
  };
  if (input.ops !== undefined) delegationInput.ops = input.ops;
  if (input.roles !== undefined) delegationInput.roles = input.roles;

  const delegation = await authorCarrierDelegation(delegationInput);

  return authorCarrierOp({
    replica,
    deps: [],
    kind: "authority",
    body: townshipGenesisBody(delegation, input.policies),
    cap: ["nil"],
    signer: input.signer,
  });
}

export function authorTownshipRevocation(input: AuthorTownshipRevocationInput): Promise<CarrierOpFrame> {
  return authorCarrierOp({
    replica: input.replica,
    deps: input.deps,
    kind: "authority",
    body: townshipRevokeBody(input.delegationId),
    cap: ["nil"],
    signer: input.signer,
  });
}

export async function bindTownshipReplica(replica: string, rootPubkey: string | Uint8Array): Promise<string> {
  return townshipReplicaCommitment(replica) === null
    ? `${replica}#root:${await townshipReplicaRootTag(rootPubkey)}`
    : replica;
}

export function townshipReplicaCommitment(replica: string): string | null {
  const marker = "#root:";
  const offset = replica.indexOf(marker);
  if (offset === -1) return null;

  const commitment = replica.slice(offset + marker.length);
  return commitment.length > 0 ? commitment : null;
}

export function townshipReplicaRootTag(rootPubkey: string | Uint8Array): Promise<string> {
  return canonicalHash(pubkeyBytes(rootPubkey));
}

export async function authorAndPersistTownshipCommand(
  input: AuthorAndPersistTownshipCommandInput,
): Promise<AuthorAndPersistTownshipCommandResult> {
  const [localOps, delegationFrames] = await Promise.all([
    input.localLog.load(),
    loadAuthorDelegationFrames(input),
  ]);
  const capId = selectTownshipCapId(
    input.command,
    carrierDelegationsFromFrames(delegationFrames),
    input.signer.publicKey,
  );
  if (capId === null) throw new Error(`no local delegation authorizes ${input.command.command}`);

  const frame = await authorTownshipCommandFromLog({
    replica: input.replica,
    localOps,
    command: input.command,
    capId,
    signer: input.signer,
  });
  const op = carrierOpsToSemanticOps([frame], input.realmByPubkey)[0];
  if (!op) throw new Error(`authored carrier frame ${frame.id} did not produce a semantic op`);

  await input.localLog.append(op);
  await input.carrierFrames.append(frame);
  return { frame, op, capId };
}

export async function authorAndPersistTownshipDelegation(
  input: AuthorAndPersistTownshipDelegationInput,
): Promise<AuthorAndPersistTownshipDelegationResult> {
  const [localOps, delegationFrames] = await Promise.all([
    input.localLog.load(),
    loadAuthorDelegationFrames(input),
  ]);
  const parentOptions: {
    replica?: string;
    ops?: readonly string[];
    roles?: readonly string[];
    live?: boolean;
  } = { replica: input.replica };
  if (input.ops !== undefined) parentOptions.ops = input.ops;
  if (input.roles !== undefined) parentOptions.roles = input.roles;
  if (input.live !== undefined) parentOptions.live = input.live;

  const parentId =
    input.parentId === undefined
      ? selectTownshipDelegationParentId(
          carrierDelegationsFromFrames(delegationFrames),
          input.signer.publicKey,
          parentOptions,
        )
      : input.parentId;
  if (parentId === null) throw new Error("no local delegation authorizes grant");

  const delegationInput: AuthorTownshipDelegationInput = {
    replica: input.replica,
    deps: frontier(localOps),
    audiencePubkey: input.audiencePubkey,
    parentId,
    signer: input.signer,
  };
  if (input.ops !== undefined) delegationInput.ops = input.ops;
  if (input.roles !== undefined) delegationInput.roles = input.roles;
  if (input.live !== undefined) delegationInput.live = input.live;

  const frame = await authorTownshipDelegation(delegationInput);
  const op = carrierOpsToSemanticOps([frame], input.realmByPubkey)[0];
  if (!op) throw new Error(`authored carrier frame ${frame.id} did not produce a semantic op`);
  const delegation = carrierDelegationsFromFrames([frame])[0];
  if (!delegation) throw new Error(`authored carrier frame ${frame.id} did not contain a delegation`);

  await input.localLog.append(op);
  await input.carrierFrames.append(frame);
  await input.delegationFrames?.append(frame);
  return { frame, op, delegation, parentId };
}

async function loadAuthorDelegationFrames(
  input: {
    carrierFrames: CarrierFrameStore;
    delegationFrames?: CarrierFrameStore;
  },
): Promise<CarrierOpFrame[]> {
  if (!input.delegationFrames) return input.carrierFrames.load();

  const delegationFrames = await input.delegationFrames.load();
  if (delegationFrames.length > 0) return delegationFrames;

  return input.carrierFrames.load();
}

function townshipCommandRole(command: TownshipCommand["command"]): string | null {
  switch (command) {
    case "close_matter":
    case "reopen_matter":
      return "clerk";
    case "set_title":
    case "set_summary":
    case "post":
    case "admit":
    case "remove_member":
      return null;
  }
}

function commandBody(command: string, args: string[]): CarrierTerm {
  return [
    "tuple",
    [
      ["atom", command],
      ["list", args.map((arg) => ["bin", textBase64(arg)] satisfies CarrierTerm)],
    ],
  ];
}

function townshipGenesisPoliciesTerm(policies: Record<string, TownshipGenesisPolicy>): CarrierTerm {
  return [
    "map",
    Object.entries(policies)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([role, policy]) => [
        ["atom", role],
        [
          "map",
          [
            [["atom", "successor"], ["bin", pubkeyBase64(policy.successorPubkey)]],
            [["atom", "dormant_ticks"], ["int", policy.dormantTicks]],
          ],
        ],
      ]) satisfies [CarrierTerm, CarrierTerm][],
  ];
}

function textBase64(value: string): string {
  return bytesBase64(new TextEncoder().encode(value));
}

function pubkeyBase64(value: string | Uint8Array): string {
  return typeof value === "string" ? value : bytesBase64(value);
}

function pubkeyBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? base64ToBytes(value) : value;
}

function bytesBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");

  const btoaFn = (globalThis as unknown as { btoa?: (decoded: string) => string }).btoa;
  if (!btoaFn) throw new Error("base64 encoding unavailable");
  return btoaFn(String.fromCharCode(...bytes));
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));

  const atobFn = (globalThis as unknown as { atob?: (encoded: string) => string }).atob;
  if (!atobFn) throw new Error("base64 decoding unavailable");
  return Uint8Array.from(atobFn(value), (char) => char.charCodeAt(0));
}

function setSubset<T>(needed: ReadonlySet<T>, availableValues: readonly T[]): boolean {
  const available = new Set(availableValues);
  for (const value of needed) {
    if (!available.has(value)) return false;
  }
  return true;
}
