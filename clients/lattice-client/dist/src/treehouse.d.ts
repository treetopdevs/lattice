import type { CarrierOpSigner } from "./codec";
import type { CarrierDelegation, CarrierOpFrame, CarrierTerm, CommandDecoderMap } from "./carrier";
import type { Op } from "./op";
import type { ReplicaSchema } from "./schema";
import type { CommandOpStatus, CommandOpStatusContext } from "./policy";
import { authorTownshipRevocation } from "./township";
import type { CatalogBootstrap } from "./treehouse_catalog_codec";
export type TreehouseProduct = "Treehouse.Space" | "Treehouse.Thread";
export type TreehouseCommand = {
    command: "create_space";
    name: string;
} | {
    command: "create_thread";
    title: string;
    threadReplica?: string;
} | {
    command: "issue_invitation";
    recipient: string;
    threads: string[];
} | {
    command: "revoke_invitation";
    invitationId: string;
} | {
    command: "admit_member";
    invitationId: string;
    recipient: string;
    level: "member" | "moderator";
    acceptance: string;
} | {
    command: "remove_member";
    recipient: string;
} | {
    command: "catalog_bootstrap_v1";
    record: CatalogBootstrap;
} | {
    command: "post";
    text: string;
} | {
    command: "author_edit";
    postId: string;
    targetId: string;
    text: string;
} | {
    command: "author_tombstone" | "moderator_tombstone";
    postId: string;
    targetId: string;
} | {
    command: "archive_thread";
};
export declare const treehouseSpaceSchema: ReplicaSchema;
export declare const treehouseThreadSchema: ReplicaSchema;
export declare function treehouseCommandBody(product: TreehouseProduct, command: TreehouseCommand): CarrierTerm;
export declare function authorTreehouseCommand(input: {
    product: TreehouseProduct;
    replica: string;
    deps: string[];
    signer: CarrierOpSigner;
    capId: string | null;
    command: TreehouseCommand;
}): Promise<CarrierOpFrame>;
export type TreehouseInitialization = "uninitialized" | "incomplete" | "ready";
/** Product observation preserves signed post identity and counts original DAG nodes. */
export declare function observeTreehouse(product: TreehouseProduct, ops: Op[]): {
    operationCount: number;
    posts: {
        id: string;
        author: string;
        text: unknown;
    }[];
    state: Record<string, unknown>;
    quarantine: string[];
    quarantineReasons: ReadonlyMap<string, string>;
    order: string[];
    winners: Record<string, string | null>;
};
export type TreehouseCatalogBootstrapsResult = {
    ok: true;
    bootstraps: {
        id: string;
        record: CatalogBootstrap;
    }[];
    verifiedFrontier: string[];
} | {
    ok: false;
    reason: "invalid_verified_history";
};
/**
 * All honored bootstrap records in one authenticated complete Space snapshot.
 * Array order never selects an initial trust/fork winner. Authentic quarantined
 * frames remain in the verified frontier; callers own persistence and pinning.
 */
export declare function treehouseCatalogBootstrapsFromFrames(input: {
    replica: string;
    frames: readonly unknown[];
}): Promise<TreehouseCatalogBootstrapsResult>;
/** Observe retained semantic history; decoding must have used the Space product. */
export declare function treehouseSpaceInitialization(ops: Op[]): TreehouseInitialization;
/** Pure root-only preparation. Returned pending frames have not been persisted. */
export declare function prepareTreehouseSpaceCreation(input: {
    replica: string;
    name: string;
    signer: CarrierOpSigner;
    retained?: CarrierOpFrame[];
}): Promise<{
    replica: string;
    profile: "legacy_root_only";
    status: TreehouseInitialization;
    pending: CarrierOpFrame[];
}>;
/** One existing authority transfer, preserving the parent's command/lease bounds. */
export declare function authorTreehouseRoleTransfer(input: {
    replica: string;
    deps: string[];
    signer: CarrierOpSigner;
    parent: CarrierDelegation;
    recipient: string | Uint8Array;
    action: "transfer_admin" | "change_moderator";
}): Promise<{
    frame: CarrierOpFrame;
    delegation: CarrierDelegation;
}>;
/** Existing issuer-checked revocation, with no separate Treehouse grant primitive. */
export declare const authorTreehouseGrantRevocation: typeof authorTownshipRevocation;
/** Existing witnessed role proof only; this does not create the R04/R14 bounded profile. */
export declare function authorTreehouseWitnessedSuccession(input: {
    replica: string;
    deps: string[];
    signer: CarrierOpSigner;
    role: "admin" | "moderator";
    delegation: CarrierDelegation;
    certificate: CarrierTerm;
}): Promise<CarrierOpFrame>;
/** Explicit injection keeps Treehouse command names independent of Township. */
export declare function treehouseCommandDecoders(product: TreehouseProduct): CommandDecoderMap;
export declare function treehouseInvitationAcceptanceBytes(replica: string, invitation: Op): Uint8Array;
export declare function acceptTreehouseInvitation(replica: string, invitation: Op, signer: CarrierOpSigner): Promise<string>;
export declare function treehouseCommandOpStatus(schema: ReplicaSchema, op: Op, visible: ReadonlySet<string>, context: CommandOpStatusContext): CommandOpStatus;
