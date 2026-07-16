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
