import type { CarrierOpFrame } from "./carrier";
import type { CarrierOpSigner } from "./codec";
import type { CatalogEntry, CatalogPriorCatalog, CatalogReplacementClaim } from "./treehouse_catalog_codec";
/** One retained complete history: authenticated frames plus retained bad-signature evidence. */
export interface TreehouseCatalogReplacementHistory {
    frames: readonly unknown[];
    rejected: readonly {
        frame: unknown;
        reason: "bad_signature";
    }[];
}
export interface TreehouseCatalogReplacementRequest {
    author: string;
    nonce: string;
    parents: string[];
    priorCatalogs: CatalogPriorCatalog[];
    generation: number;
    newCatalogKey: string;
    newServiceId: string;
    newServiceKey: string;
    newOrigin: string;
    /** The exact first-catalog entry list under the new binding. */
    entries: CatalogEntry[];
    /** Thread replica → retained history; the Space cutoff comes from the frozen Space frames. */
    replicaHistories: Record<string, TreehouseCatalogReplacementHistory>;
}
export type TreehouseCatalogReplacementStatus = "awaiting_possession" | "cancelled" | "cancelled_after_signature" | "signed";
/** Caller-owned journal entry keyed by the claim nonce; never persisted here. */
export interface TreehouseCatalogReplacementJournalEntry {
    attemptId: string | null;
    claimBytes: Uint8Array | null;
    status: TreehouseCatalogReplacementStatus;
    reason: string | null;
    opId: string | null;
}
export type TreehouseCatalogReplacementJournal = Readonly<Record<string, TreehouseCatalogReplacementJournalEntry>>;
export interface TreehouseCatalogReplacementAttempt {
    attemptId: string;
    status: "awaiting_possession";
    replica: string;
    request: TreehouseCatalogReplacementRequest;
    claim: CatalogReplacementClaim;
    claimBytes: Uint8Array;
    catalogPossessionBytes: Uint8Array;
    servicePossessionBytes: Uint8Array;
    author: string;
    cap: string;
    frozenFrontier: string[];
    journalEntry: TreehouseCatalogReplacementJournalEntry;
}
export type TreehouseCatalogReplacementPrepareResult = {
    ok: true;
    attempt: TreehouseCatalogReplacementAttempt;
} | {
    ok: false;
    reason: string;
};
export type TreehouseCatalogReplacementAuthorResult = {
    ok: true;
    frame: CarrierOpFrame;
    bindingId: string;
    attemptId: string;
    journalEntry: TreehouseCatalogReplacementJournalEntry;
} | {
    ok: false;
    reason: string;
    journalEntry: TreehouseCatalogReplacementJournalEntry;
};
/** Current Space history: frames alone, or frames with retained bad-signature evidence. */
export type TreehouseCatalogReplacementCurrent = readonly unknown[] | TreehouseCatalogReplacementHistory;
/** Review step; signs nothing. Freezes the frontier and derives every claim field from the judged history. */
export declare function prepareTreehouseCatalogReplacementFromFrames(input: {
    replica: string;
    frames: readonly unknown[];
    rejected?: TreehouseCatalogReplacementHistory["rejected"];
    request: TreehouseCatalogReplacementRequest;
    journal: TreehouseCatalogReplacementJournal;
}): Promise<TreehouseCatalogReplacementPrepareResult>;
/** Re-read, refuse reclassification or a moved claim, verify both possessions, preflight, then sign once. */
export declare function authorTreehouseCatalogReplacementFromFrames(input: {
    currentFrames: () => TreehouseCatalogReplacementCurrent | Promise<TreehouseCatalogReplacementCurrent>;
    attempt: TreehouseCatalogReplacementAttempt;
    possession: {
        catalog: string;
        service: string;
    };
    signer: CarrierOpSigner;
}): Promise<TreehouseCatalogReplacementAuthorResult>;
