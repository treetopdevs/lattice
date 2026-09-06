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
/** Validate complete ordered effects before any capability or reduction work. */
export function validCommandEffects(schema, op) {
    if (op.kind !== "command" || op.effects === undefined)
        return true;
    if (!Array.isArray(op.effects))
        return false;
    return op.effects.every((effect) => {
        if (effect === null || typeof effect !== "object")
            return false;
        if (typeof effect.field !== "string" || !Object.hasOwn(schema.fields, effect.field))
            return false;
        const spec = schema.fields[effect.field];
        if (spec === undefined || isAuthorityField(spec))
            return false;
        if (spec.merge === "lww")
            return effect.mutation === "write";
        if (spec.merge === "or_set")
            return effect.mutation === "add" || effect.mutation === "remove";
        if (spec.merge !== "causal_list")
            return false;
        if (["append", "insert"].includes(effect.mutation))
            return true;
        if (effect.mutation === "delete")
            return typeof effect.value === "string";
        if (effect.mutation !== "edit" || effect.value === null || typeof effect.value !== "object")
            return false;
        const value = effect.value;
        return typeof value.target === "string" && Object.hasOwn(value, "value") && Object.keys(value).length === 2;
    });
}
