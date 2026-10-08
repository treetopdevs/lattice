import type { CarrierOpSigner } from "./codec";
import type { CarrierDelegation, CarrierOpFrame } from "./carrier";
import type { TreehouseProduct } from "./treehouse";
/** The lite shell configures the Space plus at most this many Threads (four routes in all). */
export declare const TREEHOUSE_LITE_THREAD_CAP = 3;
/** Upper bound on the pasted offer text, prefix included. */
export declare const TREEHOUSE_OFFER_MAX_CHARS = 16384;
/** Upper bound on the pasted join request and acceptance texts. */
export declare const TREEHOUSE_REQUEST_MAX_CHARS = 4096;
export interface TreehouseJoinRequest {
    publicKey: string;
}
/** A route entry is an opaque record of text fields here. The shell owns its validation. */
export type TreehouseOfferRoute = Record<string, string>;
export interface TreehouseOfferThread {
    replica: string;
    archived: boolean;
}
export interface TreehouseOffer {
    space: string;
    invitationId: string;
    localRealm: string;
    routes: TreehouseOfferRoute[];
    threads: TreehouseOfferThread[];
}
export interface TreehouseAcceptanceArtifact {
    replica: string;
    invitationId: string;
    recipient: string;
    acceptance: string;
}
export type TreehouseArtifactError = "wrong_product" | "invalid_artifact_format" | "unsupported_artifact_version" | "invalid_artifact_payload" | "artifact_too_large" | "secret_field";
export declare function encodeTreehouseJoinRequest(request: TreehouseJoinRequest): string;
export declare function decodeTreehouseJoinRequest(text: string): TreehouseJoinRequest;
export declare function encodeTreehouseOffer(offer: TreehouseOffer): string;
export declare function decodeTreehouseOffer(text: string): TreehouseOffer;
export declare function encodeTreehouseAcceptance(acceptance: TreehouseAcceptanceArtifact): string;
export declare function decodeTreehouseAcceptance(text: string): TreehouseAcceptanceArtifact;
/**
 * The delegation naming `publicKey` as audience in `replica`'s frames, optionally one that carries `command`.
 * This generalizes the issuer-root lookup: a joiner's capability is an exact-audience grant, not the root.
 * `product` is required: only usable delegations qualify, so a quarantined, revoked or lapsed grant is never
 * offered.
 */
export declare function memberCapability(frames: readonly CarrierOpFrame[], publicKey: string | Uint8Array, replica: string, options: {
    product: TreehouseProduct;
    command?: string;
}): CarrierDelegation | null;
/** Delegations an op authored at the current frontier of `replica` can cite: honored, unrevoked and unexpired. */
export declare function liveTreehouseDelegations(product: TreehouseProduct, frames: readonly CarrierOpFrame[], replica: string): CarrierDelegation[];
export type TreehouseInvitationReview = {
    ok: true;
    invitationId: string;
    recipient: string;
    threads: string[];
    admitted: boolean;
} | {
    ok: false;
    reason: string;
};
/**
 * Review one invitation against retained Space frames. The scope returned is the signed scope, every honored
 * Thread (archived included). Pure: it signs and stores nothing.
 */
export declare function reviewTreehouseInvitation(input: {
    replica: string;
    frames: readonly CarrierOpFrame[];
    invitationId: string;
    recipient: string;
    offerThreads?: readonly string[];
}): TreehouseInvitationReview;
/** Joiner side: review, then sign the recipient-bound acceptance. Nothing is persisted or sent. */
export declare function signTreehouseAcceptance(input: {
    replica: string;
    frames: readonly CarrierOpFrame[];
    invitationId: string;
    signer: CarrierOpSigner;
}): Promise<TreehouseAcceptanceArtifact>;
/**
 * Founder side: one `issue_invitation` over the full honored Thread scope, archived Threads included.
 * Refuses `thread_scope_exceeds_routes` above the lite cap or when a Thread in scope has no supplied route.
 */
export declare function authorTreehouseIssueInvitation(input: {
    signer: CarrierOpSigner;
    replica: string;
    frames: readonly CarrierOpFrame[];
    threadFrames: Readonly<Record<string, readonly CarrierOpFrame[]>>;
    routes: readonly {
        replica: string;
    }[];
    recipient: string;
}): Promise<{
    frame: CarrierOpFrame;
    threads: TreehouseOfferThread[];
}>;
export interface TreehouseThreadGrant {
    replica: string;
    frame: CarrierOpFrame;
    delegation: CarrierDelegation;
}
/**
 * Founder side: the `admit_member` op plus one exact-audience Thread grant per Thread in the invitation scope,
 * each parented on the founder's own Thread delegation. Everything is authored or nothing is: all reviews and
 * lookups run before the first signature. Parts already present in the frames are skipped, so a retry after a
 * partial landing authors only what is missing (`admit` is null when the admission is already honored).
 */
export declare function authorTreehouseAdmitAndGrant(input: {
    signer: CarrierOpSigner;
    replica: string;
    frames: readonly CarrierOpFrame[];
    threadFrames: Readonly<Record<string, readonly CarrierOpFrame[]>>;
    acceptance: TreehouseAcceptanceArtifact;
}): Promise<{
    admit: CarrierOpFrame | null;
    grants: TreehouseThreadGrant[];
}>;
