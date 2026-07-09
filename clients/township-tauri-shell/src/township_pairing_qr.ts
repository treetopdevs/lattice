import jsQR from "jsqr";
import QRCode from "qrcode";
import {
  importTownshipCarrierPairingHandoff,
  type TownshipCarrierPairingHandoffError,
  type TownshipCarrierPeerConfigInput,
} from "./township_carrier_peer";

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

const QUIET_ZONE_MODULES = 4;

export function renderTownshipPairingQrSvg(handoff: string): TownshipPairingQrRender {
  const validated = importTownshipCarrierPairingHandoff(handoff);
  if (!validated.ok) {
    return qrRenderError(validated.errors[0] ?? "invalid_pairing_format");
  }

  const qr = QRCode.create(handoff, { errorCorrectionLevel: "M" });
  const modules = qrModules(qr.modules.size, qr.modules.data);

  return {
    ok: true,
    svg: svgFromModules(modules),
    modules,
    moduleCount: modules.length,
  };
}

export function decodeTownshipPairingQrImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): TownshipPairingQrDecode {
  const decoded = jsQR(data, width, height, { inversionAttempts: "dontInvert" });
  if (!decoded) {
    return qrDecodeError("invalid_pairing_qr");
  }

  const imported = importTownshipCarrierPairingHandoff(decoded.data);
  if (!imported.ok) {
    return qrDecodeError(imported.errors[0] ?? "invalid_pairing_format", imported.message);
  }

  return {
    ok: true,
    handoff: decoded.data,
    draft: imported.draft,
    peerFingerprint: imported.peerFingerprint,
  };
}

function qrModules(size: number, data: Uint8Array): readonly (readonly boolean[])[] {
  const modules: boolean[][] = [];

  for (let y = 0; y < size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x++) {
      row.push(data[y * size + x] === 1);
    }
    modules.push(row);
  }

  return modules;
}

function svgFromModules(modules: readonly (readonly boolean[])[]): string {
  const viewBoxSize = modules.length + QUIET_ZONE_MODULES * 2;
  const path = modules
    .flatMap((row, y) =>
      row.flatMap((dark, x) => {
        if (!dark) return [];
        const moduleX = x + QUIET_ZONE_MODULES;
        const moduleY = y + QUIET_ZONE_MODULES;
        return `M${moduleX} ${moduleY}h1v1H${moduleX}z`;
      }),
    )
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Township pairing QR" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" shape-rendering="crispEdges">`,
    '<rect width="100%" height="100%" fill="#fff"/>',
    `<path fill="#111827" d="${path}"/>`,
    "</svg>",
  ].join("");
}

function qrRenderError(reason: TownshipPairingQrRenderReason): TownshipPairingQrRender {
  return {
    ok: false,
    reason,
    message: qrRenderErrorMessage(reason),
  };
}

function qrRenderErrorMessage(reason: TownshipPairingQrRenderReason): string {
  switch (reason) {
    case "unsupported_pairing_version":
      return "This Township pairing handoff version is not supported.";
    default:
      return "Enter a valid Township pairing handoff.";
  }
}

function qrDecodeError(reason: TownshipPairingQrDecodeReason, message?: string): TownshipPairingQrDecode {
  return {
    ok: false,
    reason,
    message: message ?? qrDecodeErrorMessage(reason),
  };
}

function qrDecodeErrorMessage(reason: TownshipPairingQrDecodeReason): string {
  switch (reason) {
    case "invalid_pairing_qr":
      return "Load an image containing a Township pairing QR.";
    case "unsupported_pairing_version":
      return "This Township pairing handoff version is not supported.";
    default:
      return "Enter a valid Township pairing handoff.";
  }
}
