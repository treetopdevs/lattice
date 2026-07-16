export type CrdtKind = "lww" | "or_set" | "causal_list";
export type FieldSpec = {
    merge: CrdtKind;
    gatedBy?: string;
    default?: unknown;
} | {
    authority: string;
    default?: unknown;
};
export interface ReplicaSchema {
    /** e.g. "Township.Matter" — provenance of the schema, matched against the oracle. */
    name: string;
    fields: Record<string, FieldSpec>;
}
export declare function isAuthorityField(spec: FieldSpec): spec is {
    authority: string;
};
/** The authority role gating writes to `field`, or null if the field is ungated. */
export declare function gatedBy(schema: ReplicaSchema, field: string): string | null;
/** The role name a field tracks the holder of, if it is an authority field. */
export declare function authorityRole(schema: ReplicaSchema, field: string): string | null;
