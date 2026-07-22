/**
 * Product-neutral pairing QR seam.
 *
 * Extracted from the Township shell's `township_pairing_qr.ts`: QR rendering
 * of a validated pairing handoff and QR image decoding back into a pairing
 * draft. The product supplies its handoff codec options and display label;
 * the module never embeds a product string of its own.
 */
import { type CarrierPairingHandoffError, type CarrierPeerConfigInput, type PairingHandoffOptions } from "./pairing_handoff";
export type PairingQrRenderReason = CarrierPairingHandoffError;
export type PairingQrDecodeReason = CarrierPairingHandoffError | "invalid_pairing_qr";
export type PairingQrRender = {
    ok: true;
    svg: string;
    modules: readonly (readonly boolean[])[];
    moduleCount: number;
} | {
    ok: false;
    reason: PairingQrRenderReason;
    message: string;
};
export type PairingQrDecode = {
    ok: true;
    handoff: string;
    draft: CarrierPeerConfigInput;
    peerFingerprint: string;
} | {
    ok: false;
    reason: PairingQrDecodeReason;
    message: string;
};
export interface PairingQrOptions extends PairingHandoffOptions {
    /** Product display label used in the SVG aria-label and messages, e.g. `Township`. */
    productLabel: string;
}
export declare function renderPairingQrSvg(handoff: string, options: PairingQrOptions): PairingQrRender;
export declare function decodePairingQrImageData(data: Uint8ClampedArray, width: number, height: number, options: PairingQrOptions): PairingQrDecode;
