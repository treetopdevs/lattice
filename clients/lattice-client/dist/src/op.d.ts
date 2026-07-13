export type OpKind = "command" | "authority" | "inbox" | "tombstone";
export type Mutation = "write" | "append" | "add" | "remove" | "delete";
export interface AuthorityDelegationEvidence {
    id: string;
    replica: string;
    issuer: string;
    audience: string;
    issuerRealm: string;
    audienceRealm: string;
    parentId: string | null;
    ops: string[];
    roles: string[];
    live: boolean;
}
export type AuthorityEvidence = {
    type: "genesis";
    delegation: AuthorityDelegationEvidence;
} | {
    type: "grant";
    delegation: AuthorityDelegationEvidence;
} | {
    type: "transfer" | "succeed";
    role: string;
    delegation: AuthorityDelegationEvidence;
    atTick: number;
};
export interface Op {
    /** Content-address id from Elixir. In Tier A this is an opaque handle. */
    id: string;
    /** Causal parents (ids). The DAG edges. */
    deps: string[];
    kind: OpKind;
    /** Authoring realm / DID (the signer). */
    author: string;
    /** The replica field this op targets (e.g. "summary", "posts", "clerk"). */
    field: string;
    /** Absolute mutation applied to that field. */
    mutation: Mutation;
    /** The value written / appended / added / removed. */
    value: unknown;
    /**
   * Ordering key from Elixir, used ONLY as the LWW/order tiebreak in Tier A.
   * Today this is the opaque op id because Elixir reduces by `{height, op.id}`.
   * In Tier B this is derived from the canonical encoding and must match
   * byte-for-byte.
     */
    hash: string;
    /** Optional human label for display/debug (not load-bearing). */
    command?: string;
    /** Semantic authority facts retained from the verified carrier body. */
    authority?: AuthorityEvidence;
}
/** Compare two opaque ordering keys. Returns >0 if a>b. */
export declare function cmpHash(a: string, b: string): number;
