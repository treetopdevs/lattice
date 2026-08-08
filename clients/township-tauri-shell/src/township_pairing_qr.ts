import {
  decodePairingQrImageData,
  renderPairingQrSvg,
  type PairingQrOptions,
} from "@treetopdevs/lattice-mobile-core";
import {
  TOWNSHIP_CARRIER_PAIRING_HANDOFF_PREFIX,
  type TownshipCarrierPairingHandoffError,
  type TownshipCarrierPeerConfigInput,
} from "./township_carrier_peer";
import { TOWNSHIP_REPLICA } from "./township_actions";

// The product-neutral pairing QR seam lives in
// @treetopdevs/lattice-mobile-core (plan 158 seam extraction); this module
// binds it to the Township handoff prefix and display label.
const TOWNSHIP_PAIRING_QR_OPTIONS: PairingQrOptions = {
  handoffPrefix: TOWNSHIP_CARRIER_PAIRING_HANDOFF_PREFIX,
  legacyHandoffPrefix: "township-pairing:",
  defaultReplica: TOWNSHIP_REPLICA,
  productLabel: "Township",
};

export type TownshipPairingQrRenderReason = TownshipCarrierPairingHandoffError;
export type TownshipPairingQrDecodeReason = TownshipCarrierPairingHandoffError | "invalid_pairing_qr";

export type TownshipPairingQrRender =
  | {
      ok: true;
      svg: string;
      modules: readonly (readonly boolean[])[];
      moduleCount: number;
    }
  | {
      ok: false;
      reason: TownshipPairingQrRenderReason;
      message: string;
    };

export type TownshipPairingQrDecode =
  | {
      ok: true;
      handoff: string;
      draft: TownshipCarrierPeerConfigInput;
      peerFingerprint: string;
    }
  | {
      ok: false;
      reason: TownshipPairingQrDecodeReason;
      message: string;
    };

export function renderTownshipPairingQrSvg(handoff: string): TownshipPairingQrRender {
  return renderPairingQrSvg(handoff, TOWNSHIP_PAIRING_QR_OPTIONS) as TownshipPairingQrRender;
}

export function decodeTownshipPairingQrImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): TownshipPairingQrDecode {
  return decodePairingQrImageData(data, width, height, TOWNSHIP_PAIRING_QR_OPTIONS) as TownshipPairingQrDecode;
}
