// The client-side mirror of the Elixir Replica DSL's field declarations.
// A field is either a CRDT register (lww / or_set / causal_list), optionally
// gated by an authority role, or an authority register tracking a role holder.

export type CrdtKind = "lww" | "or_set" | "causal_list";

export type FieldSpec =
  | { merge: CrdtKind; gatedBy?: string; default?: unknown } // a value field; if gatedBy, only the role holder may write
  | { authority: string; default?: unknown }; // tracks the current holder of the named role

export interface ReplicaSchema {
  /** e.g. "Township.Matter" — provenance of the schema, matched against the oracle. */
  name: string;
  fields: Record<string, FieldSpec>;
  /**
   * ADR 0007: commands whose validity carries the co-signed consent conjunct —
   * the TS mirror of the replica module's `command_op_status/2` callback.
   */
  consentCommands?: readonly string[];
}

export function isAuthorityField(spec: FieldSpec): spec is { authority: string } {
  return (spec as { authority?: string }).authority !== undefined;
}

/** The authority role gating writes to `field`, or null if the field is ungated. */
export function gatedBy(schema: ReplicaSchema, field: string): string | null {
  const spec = schema.fields[field];
  if (!spec || isAuthorityField(spec)) return null;
  return spec.gatedBy ?? null;
}

/** The role name a field tracks the holder of, if it is an authority field. */
export function authorityRole(schema: ReplicaSchema, field: string): string | null {
  const spec = schema.fields[field];
  return spec && isAuthorityField(spec) ? spec.authority : null;
}

/** Validate complete ordered effects before any capability or reduction work. */
export function validCommandEffects(schema: ReplicaSchema, op: import("./op").Op): boolean {
  if (op.kind !== "command" || op.effects === undefined) return true;
  if (!Array.isArray(op.effects)) return false;
  return op.effects.every((effect) => {
    if (effect === null || typeof effect !== "object") return false;
    if (typeof effect.field !== "string" || !Object.hasOwn(schema.fields, effect.field)) return false;
    const spec = schema.fields[effect.field];
    if (spec === undefined || isAuthorityField(spec)) return false;
    if (spec.merge === "lww") return effect.mutation === "write";
    if (spec.merge === "or_set") return effect.mutation === "add" || effect.mutation === "remove";
    if (spec.merge !== "causal_list") return false;
    if (["append", "insert"].includes(effect.mutation)) return true;
    if (effect.mutation === "delete") return typeof effect.value === "string";
    if (effect.mutation !== "edit" || effect.value === null || typeof effect.value !== "object") return false;
    const value = effect.value as Record<string, unknown>;
    return typeof value.target === "string" && Object.hasOwn(value, "value") && Object.keys(value).length === 2;
  });
}
