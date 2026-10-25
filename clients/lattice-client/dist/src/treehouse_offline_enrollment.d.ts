import type { CarrierOpFrame } from "./carrier";
export declare const OFFLINE_INVITATION_FORMAT = "treehouse-offline-invitation-v1";
export declare const OFFLINE_EVIDENCE_MAX_BYTES: number;
/** Stable group identity code; invitation scope is separately reviewed against the current signed Space. */
export declare function treehouseGroupFingerprint(space: string, spaceRoot: string, bootstrapId: string): Promise<string>;
export declare const normalizeTreehouseFingerprint: (value: string) => string;
/** Candidate evidence only. A successful decode installs no profile, route, catalog pin or trust receipt. */
export interface OfflineInvitationReview {
    space: string;
    spaceRoot: string;
    name: string;
    threadTitles: {
        replica: string;
        title: string;
    }[];
    bootstrapId: string;
    invitationId: string;
    recipient: string;
    threads: string[];
    fingerprint: string;
    frames: CarrierOpFrame[];
    text: string;
}
/** Rebuild public frames through the established canonical wire encoder, never export retained app state. */
export declare function buildOfflineInvitation(input: {
    space: string;
    frames: readonly CarrierOpFrame[];
    invitationId: string;
    recipient: string;
}): Promise<string>;
/** Bound bytes before parsing; exact re-encoding rejects duplicate keys, extra fields and alternate spellings. */
export declare function reviewOfflineInvitation(bytes: Uint8Array, recipient: string): Promise<OfflineInvitationReview>;
/** Public provisioning candidate; the Linux importer independently verifies its ceremony and full staging policy. */
export declare function buildInitialProvisioningBundle(input: {
    space: string;
    spaceFrames: readonly CarrierOpFrame[];
    thread: string;
    threadFrames: readonly CarrierOpFrame[];
}): Promise<string>;
