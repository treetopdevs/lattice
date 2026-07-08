import { authorAndPersistTownshipCommand } from "@treetopdevs/lattice-client";
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

export type TownshipPostFailureReason =
  | "author_failed"
  | "empty_post"
  | "missing_delegation"
  | "native_unavailable";

export interface SubmitTownshipPostOptions extends TownshipNativeWorkflowOptions {
  text: string;
  replica?: string;
  realmByPubkey?: Record<string, string>;
  workflow?: TownshipNativeWorkflow;
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

export type TownshipPostSubmission = TownshipPostSuccess | TownshipPostFailure;

export async function submitTownshipPost(
  options: SubmitTownshipPostOptions,
): Promise<TownshipPostSubmission> {
  const text = options.text.trim();
  if (text.length === 0) {
    return { ok: false, reason: "empty_post", message: "Write an update before posting." };
  }

  let workflow: TownshipNativeWorkflow;
  try {
    workflow = options.workflow ?? (await createTownshipNativeWorkflow(options));
  } catch {
    return {
      ok: false,
      reason: "native_unavailable",
      message: "Open in the Tauri shell to sign and save local posts.",
    };
  }

  try {
    const authored = await authorAndPersistTownshipCommand({
      replica: options.replica ?? TOWNSHIP_REPLICA,
      command: { command: "post", text },
      signer: workflow.signer,
      localLog: workflow.localLog,
      carrierFrames: workflow.carrierFrames,
      realmByPubkey: options.realmByPubkey ?? TOWNSHIP_REALM_BY_PUBKEY,
    });
    const [localOps, carrierFrames] = await Promise.all([
      workflow.localLog.load(),
      workflow.carrierFrames.load(),
    ]);

    return {
      ok: true,
      text,
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
        message: "No local delegation authorizes posting from this device key yet.",
      };
    }

    return { ok: false, reason: "author_failed", message };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
