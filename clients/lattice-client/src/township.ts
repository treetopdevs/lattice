import { authorCarrierOp } from "./codec";
import { carrierDelegationsFromFrames, carrierOpsToSemanticOps } from "./carrier";
import { frontier } from "./sync";
import type { AuthorCarrierOpInput } from "./codec";
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

export interface AuthorAndPersistTownshipCommandInput
  extends Pick<AuthorTownshipCommandInput, "replica" | "command" | "signer"> {
  localLog: LocalOpLogStore;
  carrierFrames: CarrierFrameStore;
  realmByPubkey: Record<string, string>;
}

export interface AuthorAndPersistTownshipCommandResult {
  frame: CarrierOpFrame;
  op: Op;
  capId: string;
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

export async function authorAndPersistTownshipCommand(
  input: AuthorAndPersistTownshipCommandInput,
): Promise<AuthorAndPersistTownshipCommandResult> {
  const [localOps, carrierFrames] = await Promise.all([
    input.localLog.load(),
    input.carrierFrames.load(),
  ]);
  const capId = selectTownshipCapId(
    input.command,
    carrierDelegationsFromFrames(carrierFrames),
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

function textBase64(value: string): string {
  return bytesBase64(new TextEncoder().encode(value));
}

function bytesBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");

  const btoaFn = (globalThis as unknown as { btoa?: (decoded: string) => string }).btoa;
  if (!btoaFn) throw new Error("base64 encoding unavailable");
  return btoaFn(String.fromCharCode(...bytes));
}
