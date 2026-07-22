/**
 * Product-neutral pairing deep-link seam.
 *
 * Extracted from the Township shell's `township_pairing_deeplink.ts`. The
 * product scheme and handoff prefixes arrive through options, so
 * `toolshed://pairing?...` parses with the identical route/normalization
 * behavior the Township shell already proved on device. Cross-product links
 * refuse because the scheme is pinned per shell.
 */
import { type CarrierPairingHandoffError, type CarrierPeerConfigInput, type PairingHandoffOptions } from "./pairing_handoff";
export type PairingDeepLinkReason = CarrierPairingHandoffError | "invalid_pairing_deeplink";
export type PairingDeepLinkParse = {
    ok: true;
    handoff: string;
    state: string | null;
    draft: CarrierPeerConfigInput;
    peerFingerprint: string;
} | {
    ok: false;
    reason: PairingDeepLinkReason;
    message: string;
};
export interface PairingDeepLinkSource {
    current(): Promise<readonly string[] | null>;
    onOpenUrl(callback: (urls: readonly string[]) => void): Promise<(() => void) | void>;
}
export interface PairingDeepLinkListener {
    stop(): void;
}
export type PairingDeepLinkBlockedReason = "not_armed" | "state_mismatch";
export type PairingDeepLinkGateConsumption = {
    ok: true;
} | {
    ok: false;
    reason: PairingDeepLinkBlockedReason;
};
export interface PairingDeepLinkGateOptions {
    createState?: () => string;
}
export interface PairingDeepLinkGate {
    arm(): string;
    disarm(): void;
    armed(): boolean;
    state(): string | null;
    consume(parse: PairingDeepLinkParse): PairingDeepLinkGateConsumption;
}
export interface PairingDeepLinkBlocked {
    reason: PairingDeepLinkBlockedReason;
    parse: PairingDeepLinkParse;
}
export interface PairingDeepLinkOptions extends PairingHandoffOptions {
    /** Product deep-link scheme without the colon, e.g. `township`. */
    scheme: string;
}
export interface PairingDeepLinkListenerOptions {
    source: PairingDeepLinkSource;
    gate?: PairingDeepLinkGate | undefined;
    parse(value: string): PairingDeepLinkParse;
    apply(parse: PairingDeepLinkParse): void;
    onBlocked?(blocked: PairingDeepLinkBlocked): void;
}
export declare function parseCarrierPairingDeepLink(value: string, options: PairingDeepLinkOptions): PairingDeepLinkParse;
export declare function createPairingDeepLinkListener(options: PairingDeepLinkListenerOptions): Promise<PairingDeepLinkListener>;
export declare function createOneShotPairingDeepLinkGate(options?: PairingDeepLinkGateOptions): PairingDeepLinkGate;
