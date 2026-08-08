/**
 * Product-neutral pairing QR seam.
 *
 * Extracted from the Township shell's `township_pairing_qr.ts`: QR rendering
 * of a validated pairing handoff and QR image decoding back into a pairing
 * draft. The product supplies its handoff codec options and display label;
 * the module never embeds a product string of its own.
 */
import jsQR from "jsqr";
import QRCode from "qrcode";
import { importCarrierPairingHandoff, } from "./pairing_handoff";
const QUIET_ZONE_MODULES = 4;
export function renderPairingQrSvg(handoff, options) {
    const validated = importCarrierPairingHandoff(handoff, options);
    if (!validated.ok) {
        return qrRenderError(validated.errors[0] ?? "invalid_pairing_format", options);
    }
    const qr = QRCode.create(handoff, { errorCorrectionLevel: "M" });
    const modules = qrModules(qr.modules.size, qr.modules.data);
    return {
        ok: true,
        svg: svgFromModules(modules, options),
        modules,
        moduleCount: modules.length,
    };
}
export function decodePairingQrImageData(data, width, height, options) {
    const decoded = jsQR(data, width, height, { inversionAttempts: "dontInvert" });
    if (!decoded) {
        return qrDecodeError("invalid_pairing_qr", options);
    }
    const imported = importCarrierPairingHandoff(decoded.data, options);
    if (!imported.ok) {
        return qrDecodeError(imported.errors[0] ?? "invalid_pairing_format", options, imported.message);
    }
    return {
        ok: true,
        handoff: decoded.data,
        draft: imported.draft,
        peerFingerprint: imported.peerFingerprint,
    };
}
function qrModules(size, data) {
    const modules = [];
    for (let y = 0; y < size; y++) {
        const row = [];
        for (let x = 0; x < size; x++) {
            row.push(data[y * size + x] === 1);
        }
        modules.push(row);
    }
    return modules;
}
function svgFromModules(modules, options) {
    const viewBoxSize = modules.length + QUIET_ZONE_MODULES * 2;
    const path = modules
        .flatMap((row, y) => row.flatMap((dark, x) => {
        if (!dark)
            return [];
        const moduleX = x + QUIET_ZONE_MODULES;
        const moduleY = y + QUIET_ZONE_MODULES;
        return `M${moduleX} ${moduleY}h1v1H${moduleX}z`;
    }))
        .join("");
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${options.productLabel} pairing QR" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" shape-rendering="crispEdges">`,
        '<rect width="100%" height="100%" fill="#fff"/>',
        `<path fill="#111827" d="${path}"/>`,
        "</svg>",
    ].join("");
}
function qrRenderError(reason, options) {
    return {
        ok: false,
        reason,
        message: qrRenderErrorMessage(reason, options),
    };
}
function qrRenderErrorMessage(reason, options) {
    switch (reason) {
        case "unsupported_pairing_version":
            return `This ${options.productLabel} pairing handoff version is not supported.`;
        default:
            return `Enter a valid ${options.productLabel} pairing handoff.`;
    }
}
function qrDecodeError(reason, options, message) {
    return {
        ok: false,
        reason,
        message: message ?? qrDecodeErrorMessage(reason, options),
    };
}
function qrDecodeErrorMessage(reason, options) {
    switch (reason) {
        case "invalid_pairing_qr":
            return `Load an image containing a ${options.productLabel} pairing QR.`;
        case "unsupported_pairing_version":
            return `This ${options.productLabel} pairing handoff version is not supported.`;
        default:
            return `Enter a valid ${options.productLabel} pairing handoff.`;
    }
}
