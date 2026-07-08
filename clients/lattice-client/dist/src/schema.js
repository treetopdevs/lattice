// The client-side mirror of the Elixir Replica DSL's field declarations.
// A field is either a CRDT register (lww / or_set / causal_list), optionally
// gated by an authority role, or an authority register tracking a role holder.
export function isAuthorityField(spec) {
    return spec.authority !== undefined;
}
/** The authority role gating writes to `field`, or null if the field is ungated. */
export function gatedBy(schema, field) {
    const spec = schema.fields[field];
    if (!spec || isAuthorityField(spec))
        return null;
    return spec.gatedBy ?? null;
}
/** The role name a field tracks the holder of, if it is an authority field. */
export function authorityRole(schema, field) {
    const spec = schema.fields[field];
    return spec && isAuthorityField(spec) ? spec.authority : null;
}
