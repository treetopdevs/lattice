import {
  authorAndPersistTownshipDelegation,
  authorAndPersistTownshipCommand,
  authorTownshipRevocation,
  carrierDelegationsFromFrames,
  carrierOpsToSemanticOps,
  frontier,
  selectTownshipCapId,
  type CarrierOpFrame,
  type TownshipCommand,
} from "@treetopdevs/lattice-client";
import {
  createTownshipNativeWorkflow,
  type TownshipNativeWorkflow,
  type TownshipNativeWorkflowOptions,
} from "./native_workflow";

export const TOWNSHIP_REPLICA = "replica:matter:township-g1#root:QUB7owpVIsZn3IyoVLJbsFc5HLkozhi2PVBL5Lzhj3w";
export const TOWNSHIP_REALM_BY_PUBKEY: Record<string, string> = {
  "OMlRmFPtU6VkYbKW3MiZG4Il++Eb+GmRJyiGcbUDfSQ=": "resident",
  "ux8h/x3NkAWj/ejlP3T15/89nMJMvweh2kYZqcXYYPM=": "clerk",
};

const TOWNSHIP_ACTION_COMMANDS = [
  { command: "set_title", text: "" },
  { command: "set_summary", text: "" },
  { command: "post", text: "" },
  { command: "admit", member: "" },
  { command: "remove_member", member: "" },
  { command: "close_matter" },
  { command: "reopen_matter" },
] as const satisfies readonly TownshipCommand[];

export type TownshipPostFailureReason =
  | "author_failed"
  | "empty_post"
  | "missing_delegation"
  | "native_unavailable";

export type TownshipCommandFailureReason =
  | "author_failed"
  | "empty_member"
  | "empty_text"
  | "missing_delegation"
  | "native_unavailable";

export type TownshipDelegationFailureReason =
  | "author_failed"
  | "empty_audience"
  | "invalid_audience"
  | "missing_delegation"
  | "native_unavailable";

export type TownshipRevocationFailureReason =
  | "author_failed"
  | "empty_delegation"
  | "missing_delegation"
  | "native_unavailable"
  | "not_issuer";

interface TownshipCommandOptions extends TownshipNativeWorkflowOptions {
  replica?: string;
  realmByPubkey?: Record<string, string>;
  workflow?: TownshipNativeWorkflow;
}

export interface SubmitTownshipCommandOptions extends TownshipCommandOptions {
  command: TownshipCommand;
}

export interface SubmitTownshipPostOptions extends TownshipCommandOptions {
  text: string;
}

export interface LoadTownshipActionAvailabilityOptions extends TownshipCommandOptions {}

export interface SubmitTownshipDelegationOptions extends TownshipCommandOptions {
  audiencePubkey: string;
  ops?: readonly string[];
  roles?: readonly string[];
  live?: boolean;
}

export interface SubmitTownshipRevocationOptions extends TownshipCommandOptions {
  delegationId: string;
}

export interface TownshipCommandSuccess {
  ok: true;
  command: TownshipCommand;
  opId: string;
  frameId: string;
  capId: string;
  localOpCount: number;
  carrierFrameCount: number;
}

export interface TownshipCommandFailure {
  ok: false;
  reason: TownshipCommandFailureReason;
  commandName: TownshipCommand["command"];
  message: string;
}

export interface TownshipPostSuccess {
  ok: true;
  text: string;
  opId: string;
  frameId: string;
  capId: string;
  localOpCount: number;
  carrierFrameCount: number;
}

export interface TownshipPostFailure {
  ok: false;
  reason: TownshipPostFailureReason;
  message: string;
}

export interface TownshipDelegationSuccess {
  ok: true;
  audiencePubkey: string;
  ops: string[];
  opId: string;
  frameId: string;
  delegationId: string;
  parentId: string | null;
  localOpCount: number;
  carrierFrameCount: number;
  delegationFrameCount: number;
}

export interface TownshipDelegationFailure {
  ok: false;
  reason: TownshipDelegationFailureReason;
  message: string;
}

export interface TownshipRevocationSuccess {
  ok: true;
  delegationId: string;
  opId: string;
  frameId: string;
  localOpCount: number;
  carrierFrameCount: number;
}

export interface TownshipRevocationFailure {
  ok: false;
  reason: TownshipRevocationFailureReason;
  message: string;
}

export type TownshipCommandSubmission = TownshipCommandSuccess | TownshipCommandFailure;
export type TownshipPostSubmission = TownshipPostSuccess | TownshipPostFailure;
export type TownshipDelegationSubmission = TownshipDelegationSuccess | TownshipDelegationFailure;
export type TownshipRevocationSubmission = TownshipRevocationSuccess | TownshipRevocationFailure;
export type TownshipCommandName = TownshipCommand["command"];

export interface TownshipCommandAvailability {
  commandName: TownshipCommandName;
  allowed: boolean;
  capId: string | null;
}

export type TownshipCommandAvailabilityMap = Record<TownshipCommandName, TownshipCommandAvailability>;

export interface TownshipActionAvailabilityReady {
  ready: true;
  publicKeyBase64: string;
  commands: TownshipCommandAvailabilityMap;
}

export interface TownshipActionAvailabilityUnavailable {
  ready: false;
  reason: "native_unavailable";
  message: string;
}

export type TownshipActionAvailability =
  | TownshipActionAvailabilityReady
  | TownshipActionAvailabilityUnavailable;

const TOWNSHIP_DEFAULT_DELEGATION_OPS = ["admit", "post", "set_summary", "set_title"] as const;

export async function loadTownshipActionAvailability(
  options: LoadTownshipActionAvailabilityOptions = {},
): Promise<TownshipActionAvailability> {
  let workflow: TownshipNativeWorkflow;
  try {
    workflow = options.workflow ?? (await createTownshipNativeWorkflow(options));
  } catch {
    return nativeUnavailableAvailability();
  }

  try {
    const delegationFrames = await loadDelegationFrames(workflow);
    const delegations = carrierDelegationsFromFrames(delegationFrames);
    const commands = Object.fromEntries(
      TOWNSHIP_ACTION_COMMANDS.map((command) => {
        const capId = selectTownshipCapId(command, delegations, workflow.signer.publicKey);
        return [
          command.command,
          {
            commandName: command.command,
            allowed: capId !== null,
            capId,
          },
        ];
      }),
    ) as TownshipCommandAvailabilityMap;

    return {
      ready: true,
      publicKeyBase64: bytesBase64(workflow.signer.publicKey),
      commands,
    };
  } catch {
    return nativeUnavailableAvailability();
  }
}

export async function submitTownshipDelegation(
  options: SubmitTownshipDelegationOptions,
): Promise<TownshipDelegationSubmission> {
  const audience = normalizeAudiencePubkey(options.audiencePubkey);
  if (!audience.ok) return audience.failure;

  let workflow: TownshipNativeWorkflow;
  try {
    workflow = options.workflow ?? (await createTownshipNativeWorkflow(options));
  } catch {
    return {
      ok: false,
      reason: "native_unavailable",
      message: "Open in the Tauri shell to grant access from this device key.",
    };
  }

  try {
    const authored = await authorAndPersistTownshipDelegation({
      replica: options.replica ?? TOWNSHIP_REPLICA,
      audiencePubkey: audience.value,
      ops: options.ops ?? TOWNSHIP_DEFAULT_DELEGATION_OPS,
      roles: options.roles ?? [],
      live: options.live ?? false,
      signer: workflow.signer,
      localLog: workflow.localLog,
      carrierFrames: workflow.carrierFrames,
      delegationFrames: workflow.delegationFrames,
      realmByPubkey: options.realmByPubkey ?? TOWNSHIP_REALM_BY_PUBKEY,
    });
    const [localOps, carrierFrames, delegationFrames] = await Promise.all([
      workflow.localLog.load(),
      workflow.carrierFrames.load(),
      workflow.delegationFrames.load(),
    ]);

    return {
      ok: true,
      audiencePubkey: audience.value,
      ops: [...authored.delegation.ops],
      opId: authored.op.id,
      frameId: authored.frame.id,
      delegationId: authored.delegation.id,
      parentId: authored.parentId,
      localOpCount: localOps.length,
      carrierFrameCount: carrierFrames.length,
      delegationFrameCount: delegationFrames.length,
    };
  } catch (error) {
    const message = errorMessage(error);
    if (message.startsWith("no local delegation authorizes")) {
      return {
        ok: false,
        reason: "missing_delegation",
        message: "No local delegation can grant access from this device key yet.",
      };
    }

    return { ok: false, reason: "author_failed", message };
  }
}

export async function submitTownshipRevocation(
  options: SubmitTownshipRevocationOptions,
): Promise<TownshipRevocationSubmission> {
  const delegationId = options.delegationId.trim();
  if (delegationId.length === 0) {
    return { ok: false, reason: "empty_delegation", message: "Enter a delegation id before revoking access." };
  }

  let workflow: TownshipNativeWorkflow;
  try {
    workflow = options.workflow ?? (await createTownshipNativeWorkflow(options));
  } catch {
    return {
      ok: false,
      reason: "native_unavailable",
      message: "Open in the Tauri shell to revoke access from this device key.",
    };
  }

  try {
    const delegationFrames = await loadDelegationFrames(workflow);
    const delegation = carrierDelegationsFromFrames(delegationFrames).find((candidate) => candidate.id === delegationId);
    if (!delegation) {
      return {
        ok: false,
        reason: "missing_delegation",
        message: "No local delegation evidence matches that id yet.",
      };
    }

    // UX guard only. Replica authority still enforces issuer/root revocation during sync.
    if (delegation.issuer !== bytesBase64(workflow.signer.publicKey)) {
      return {
        ok: false,
        reason: "not_issuer",
        message: "Only the device that issued this delegation can prepare this revoke from local evidence.",
      };
    }

    const localOps = await workflow.localLog.load();
    const frame = await authorTownshipRevocation({
      replica: options.replica ?? TOWNSHIP_REPLICA,
      deps: frontier(localOps),
      delegationId,
      signer: workflow.signer,
    });
    const op = carrierOpsToSemanticOps([frame], options.realmByPubkey ?? TOWNSHIP_REALM_BY_PUBKEY)[0];
    if (!op) throw new Error(`authored revocation frame ${frame.id} did not produce a semantic op`);

    await workflow.localLog.append(op);
    await workflow.carrierFrames.append(frame);

    const [savedLocalOps, carrierFrames] = await Promise.all([
      workflow.localLog.load(),
      workflow.carrierFrames.load(),
    ]);

    return {
      ok: true,
      delegationId,
      opId: op.id,
      frameId: frame.id,
      localOpCount: savedLocalOps.length,
      carrierFrameCount: carrierFrames.length,
    };
  } catch (error) {
    return { ok: false, reason: "author_failed", message: errorMessage(error) };
  }
}

export async function submitTownshipCommand(
  options: SubmitTownshipCommandOptions,
): Promise<TownshipCommandSubmission> {
  const command = normalizeCommand(options.command);
  const invalid = invalidCommand(command);
  if (invalid) return invalid;

  let workflow: TownshipNativeWorkflow;
  try {
    workflow = options.workflow ?? (await createTownshipNativeWorkflow(options));
  } catch {
    return {
      ok: false,
      reason: "native_unavailable",
      commandName: command.command,
      message: `Open in the Tauri shell to sign and save ${commandLabel(command.command)} changes.`,
    };
  }

  try {
    const authored = await authorAndPersistTownshipCommand({
      replica: options.replica ?? TOWNSHIP_REPLICA,
      command,
      signer: workflow.signer,
      localLog: workflow.localLog,
      carrierFrames: workflow.carrierFrames,
      delegationFrames: workflow.delegationFrames,
      realmByPubkey: options.realmByPubkey ?? TOWNSHIP_REALM_BY_PUBKEY,
    });
    const [localOps, carrierFrames] = await Promise.all([
      workflow.localLog.load(),
      workflow.carrierFrames.load(),
    ]);

    return {
      ok: true,
      command,
      opId: authored.op.id,
      frameId: authored.frame.id,
      capId: authored.capId,
      localOpCount: localOps.length,
      carrierFrameCount: carrierFrames.length,
    };
  } catch (error) {
    const message = errorMessage(error);
    if (message.startsWith("no local delegation authorizes")) {
      return {
        ok: false,
        reason: "missing_delegation",
        commandName: command.command,
        message: `No local delegation authorizes ${commandLabel(command.command)} from this device key yet.`,
      };
    }

    return { ok: false, reason: "author_failed", commandName: command.command, message };
  }
}

export async function submitTownshipPost(
  options: SubmitTownshipPostOptions,
): Promise<TownshipPostSubmission> {
  const submitted = await submitTownshipCommand({
    ...options,
    command: { command: "post", text: options.text },
  });

  if (!submitted.ok && submitted.reason === "empty_text") {
    return { ok: false, reason: "empty_post", message: "Write an update before posting." };
  }
  if (!submitted.ok && submitted.reason === "native_unavailable") {
    return {
      ok: false,
      reason: "native_unavailable",
      message: "Open in the Tauri shell to sign and save local posts.",
    };
  }
  if (!submitted.ok) {
    const reason: TownshipPostFailureReason =
      submitted.reason === "missing_delegation" || submitted.reason === "author_failed"
        ? submitted.reason
        : "author_failed";
    return { ok: false, reason, message: submitted.message };
  }

  return {
    ok: true,
    text: submitted.command.command === "post" ? submitted.command.text : options.text.trim(),
    opId: submitted.opId,
    frameId: submitted.frameId,
    capId: submitted.capId,
    localOpCount: submitted.localOpCount,
    carrierFrameCount: submitted.carrierFrameCount,
  };
}

async function loadDelegationFrames(workflow: TownshipNativeWorkflow): Promise<CarrierOpFrame[]> {
  const delegationFrames = await workflow.delegationFrames.load();
  if (delegationFrames.length > 0) return delegationFrames;

  return workflow.carrierFrames.load();
}

function normalizeCommand(command: TownshipCommand): TownshipCommand {
  switch (command.command) {
    case "set_title":
    case "set_summary":
    case "post":
      return { ...command, text: command.text.trim() };
    case "admit":
    case "remove_member":
      return { ...command, member: command.member.trim() };
    case "close_matter":
    case "reopen_matter":
      return command;
  }
}

function invalidCommand(command: TownshipCommand): TownshipCommandFailure | null {
  switch (command.command) {
    case "set_title":
    case "set_summary":
    case "post":
      if (command.text.length > 0) return null;
      return {
        ok: false,
        reason: "empty_text",
        commandName: command.command,
        message: `Write ${commandLabel(command.command)} text before saving.`,
      };
    case "admit":
    case "remove_member":
      if (command.member.length > 0) return null;
      return {
        ok: false,
        reason: "empty_member",
        commandName: command.command,
        message: `Choose a member before saving ${commandLabel(command.command)}.`,
      };
    case "close_matter":
    case "reopen_matter":
      return null;
  }
}

function commandLabel(command: TownshipCommand["command"]): string {
  return command.replaceAll("_", " ");
}

function nativeUnavailableAvailability(): TownshipActionAvailabilityUnavailable {
  return {
    ready: false,
    reason: "native_unavailable",
    message: "Open in the Tauri shell to inspect local action permissions.",
  };
}

function normalizeAudiencePubkey(
  value: string,
): { ok: true; value: string } | { ok: false; failure: TownshipDelegationFailure } {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      failure: { ok: false, reason: "empty_audience", message: "Enter a device public key before granting access." },
    };
  }

  const bytes = base64Bytes(trimmed);
  if (!bytes || bytes.byteLength !== 32 || bytesBase64(bytes) !== trimmed) {
    return {
      ok: false,
      failure: { ok: false, reason: "invalid_audience", message: "Enter a 32-byte base64 device public key." },
    };
  }

  return { ok: true, value: trimmed };
}

function base64Bytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;

  try {
    const atobFn = (globalThis as unknown as { atob?: (encoded: string) => string }).atob;
    if (!atobFn) return null;
    return Uint8Array.from(atobFn(value), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function bytesBase64(bytes: Uint8Array): string {
  const btoaFn = (globalThis as unknown as { btoa?: (decoded: string) => string }).btoa;
  if (!btoaFn) throw new Error("base64 encoding unavailable");
  return btoaFn(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
