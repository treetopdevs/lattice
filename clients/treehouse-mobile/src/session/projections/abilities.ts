import { authorityRole, treehouseCommandDecoders, treehouseCommandOpStatus, treehouseCommandRoles, treehouseSpaceSchema, treehouseThreadSchema } from "@treetopdevs/lattice-client";
import type { Op, ReplicaSchema } from "@treetopdevs/lattice-client";
import type { ReplicaView } from "./replica_view";

// Abilities (03): per held replica, per command, whether this key could author it now. Composed only from
// synchronous lattice-client outputs, the way the Tauri shell's snapshot composes them:
//   - a live delegation (liveTreehouseDelegations) whose audience is this key, whose ops include the
//     command and whose roles carry every role the command's fields are gated by (treehouseCommandRoles);
//   - for each such role, the judge's materialized holder field naming this key (a role transferred away
//     leaves the old delegation live, but the judge then refuses it as not_holder);
//   - the judge's own application policy (lattice-client's treehouseCommandOpStatus), asked about a probe op
//     of this command by this key whose target is a probe post of this key's own, so that only a
//     target-independent refusal (the archive rule) can come back. The app holds no list of which commands an
//     archive blocks; the judge answers.
// The delegation match (audience, ops, roles over liveTreehouseDelegations) is the same filter
// memberCapability applies, as the Tauri shell's snapshot does (treehouse_workflow.ts); a Core test pins it
// to memberCapability for every key and command over the vectors. Target-dependent checks (wrong author,
// already tombstoned, invitation scope) are not per-command; the pipeline's pre-judge still runs.

export type AbilityRefusal = "identity_unavailable" | "no_capability" | "not_holder" | "archived thread";

export type Ability = { allowed: true } | { allowed: false; reason: AbilityRefusal };

export interface Abilities {
  /** replica -> command name -> ability, for every command the replica's product decodes. */
  replicas: Readonly<Record<string, Readonly<Record<string, Ability>>>>;
}

export interface AbilitiesInputs {
  views: readonly ReplicaView[];
  myKey: string | null;
}

const ALLOWED: Ability = { allowed: true };
const refused = (reason: AbilityRefusal): Ability => ({ allowed: false, reason });

const PROBE_POST = "ability-probe:post";
const PROBE_OP = "ability-probe:op";

const probeContexts = new WeakMap<ReplicaView, { visibleOps: Map<string, Op>; verdicts: Map<string, string>; visible: Set<string> }>();

/** The judge's causal context for a probe at the current frontier, built once per judged view. */
function probeContext(view: ReplicaView, myKey: string) {
  const cached = probeContexts.get(view);
  const post: Op = { ...probeBase(view, myKey), id: PROBE_POST, command: "post", commandArgs: ["probe"] };
  if (cached) {
    cached.visibleOps.set(PROBE_POST, post);
    return cached;
  }
  const visibleOps = new Map(view.byId);
  visibleOps.set(PROBE_POST, post);
  const verdicts = new Map<string, string>();
  for (const id of view.byId.keys()) verdicts.set(id, view.quarantine.get(id) ?? "honored");
  verdicts.set(PROBE_POST, "honored");
  const context = { visibleOps, verdicts, visible: new Set(visibleOps.keys()) };
  probeContexts.set(view, context);
  return context;
}

function probeBase(view: ReplicaView, myKey: string) {
  return { replica: view.replica, deps: [] as string[], kind: "command" as const, author: myKey, authorPubkey: myKey, field: "", mutation: "write" as const, value: null, hash: "", decodedProduct: view.product };
}

/**
 * The judge's target-independent application verdict for `command` by `myKey`, now. The probe op cites a
 * probe post of `myKey`'s own (honored, visible), so a target check passes and only a replica-wide rule
 * such as the archive can refuse it. Only that refusal is reported; anything else is the pre-judge's.
 */
function policyRefusal(view: ReplicaView, myKey: string, command: string): AbilityRefusal | null {
  const { visibleOps, verdicts, visible } = probeContext(view, myKey);
  const probe: Op = { ...probeBase(view, myKey), id: PROBE_OP, command, commandArgs: [PROBE_POST, PROBE_POST] };
  let status: ReturnType<typeof treehouseCommandOpStatus>;
  try {
    status = treehouseCommandOpStatus(schemaOf(view), probe, visible, { visibleOps, verdicts, validBeacons: [] });
  } catch {
    // A probe whose arguments the command's policy cannot read says nothing target-independent.
    return null;
  }
  return !status.ok && status.reason === "application_archived_thread" ? "archived thread" : null;
}

const schemaOf = (view: ReplicaView): ReplicaSchema => (view.product === "Treehouse.Space" ? treehouseSpaceSchema : treehouseThreadSchema);

/** The schema field that holds `role` (the field declared `authority: role`). */
function holderField(schema: ReplicaSchema, role: string): string | null {
  return Object.keys(schema.fields).find((field) => authorityRole(schema, field) === role) ?? null;
}

export function abilityOf(view: ReplicaView, myKey: string | null, command: string): Ability {
  if (myKey === null) return refused("identity_unavailable");
  const roles = treehouseCommandRoles(view.product, command);
  const permits = view.live.some(
    (d) => d.audience === myKey && d.ops.includes(command) && roles.every((role) => d.roles.includes(role)),
  );
  if (!permits) return refused("no_capability");
  const schema = schemaOf(view);
  for (const role of roles) {
    const field = holderField(schema, role);
    if (field === null || view.state[field] !== myKey) return refused("not_holder");
  }
  const policy = policyRefusal(view, myKey, command);
  if (policy !== null) return refused(policy);
  return ALLOWED;
}

export function projectAbilities(inputs: AbilitiesInputs): Abilities {
  const replicas: Record<string, Record<string, Ability>> = {};
  for (const view of inputs.views) {
    const entry: Record<string, Ability> = {};
    for (const command of treehouseCommandDecoders(view.product).keys()) entry[command] = abilityOf(view, inputs.myKey, command);
    replicas[view.replica] = entry;
  }
  return { replicas };
}
