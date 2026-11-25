import {
  authorTreehouseCommand,
  base64ToBytes,
  carrierOpsToSemanticOps,
  frontier,
  materialize,
  memberCapability,
  treehouseCommandDecoders,
  treehouseSpaceSchema,
  treehouseThreadSchema,
} from "@treetopdevs/lattice-client";
import type { CarrierOpFrame, TreehouseCommand, TreehouseProduct } from "@treetopdevs/lattice-client";
import { ok, quarantineReason, refuse } from "../outcomes";
import type { Outcome, QuarantineReason } from "../outcomes";
import type { KeyCustody, ReplicaStore } from "../ports";

// The one command pipeline (03): ability check, author, pre-judge, save, publish, nudge. Every step uses
// lattice-client: grant selection is `memberCapability`, deps are `frontier`, the pre-judge is
// `materialize` over the held log plus the candidate. Nothing is saved unless the judge would count it.

export interface CommandContext {
  custody: KeyCustody;
  store: ReplicaStore;
  /** This device's public key as read at open, or null. */
  myKey(): string | null;
  /** Ask the relay link to sync; never awaited by the caller, never throws. */
  nudge(): void;
}

export type PipelineRefusal = "identity_unavailable" | "no_capability" | "storage_failed" | QuarantineReason;

export interface PipelineStep<R extends string> {
  replica: string;
  product: TreehouseProduct;
  command: TreehouseCommand;
  /** App-level refusal decided on the held frames before anything is signed (e.g. archived). */
  refuseEarly?(frames: readonly CarrierOpFrame[]): R | null;
}

const schemaOf = (product: TreehouseProduct) => (product === "Treehouse.Space" ? treehouseSpaceSchema : treehouseThreadSchema);

export async function runCommand<R extends string>(
  ctx: CommandContext,
  step: PipelineStep<R>,
): Promise<Outcome<{ id: string }, R | PipelineRefusal>> {
  // 1. Ability: a usable key, a held replica, an honored grant for this command.
  const key = ctx.myKey();
  if (key === null || (await ctx.custody.status()) !== "available") return refuse("identity_unavailable");
  const held = ctx.store.replicas().find((r) => r.replica === step.replica);
  const profile = ctx.store.profile(step.replica);
  if (!held || held.product !== step.product || !profile) return refuse("no_capability");
  const frames = profile.frames;
  const early = step.refuseEarly?.(frames) ?? null;
  if (early !== null) return refuse(early);
  const capability = memberCapability(frames, key, step.replica, { product: step.product, command: step.command.command });
  if (!capability) return refuse("no_capability");

  // 2. Author: deps are the held frontier, the signature comes from custody.
  const decoders = treehouseCommandDecoders(step.product);
  const ops = carrierOpsToSemanticOps([...frames], {}, decoders);
  let frame: CarrierOpFrame;
  try {
    frame = await authorTreehouseCommand({
      product: step.product,
      replica: step.replica,
      deps: frontier(ops),
      signer: { publicKey: base64ToBytes(key), sign: (bytes) => ctx.custody.sign(bytes) },
      capId: capability.id,
      command: step.command,
    });
  } catch {
    return refuse("identity_unavailable");
  }

  // 3. Pre-judge: refuse what the judge would quarantine, before it is saved.
  const candidate = carrierOpsToSemanticOps([...frames, frame], {}, decoders);
  const verdict = materialize(schemaOf(step.product), candidate).quarantineReasons.get(frame.id);
  if (verdict !== undefined) return refuse(quarantineReason(verdict));

  // 4. Save frame and outbox in one write. 5. Publish happens through the store's change event.
  try {
    await ctx.store.appendAuthored(step.replica, frame);
  } catch {
    return refuse("storage_failed");
  }

  // 6. Nudge the link; the outcome never waits for the relay.
  ctx.nudge();
  return ok({ id: frame.id });
}
