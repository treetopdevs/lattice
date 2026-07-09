import assert from "node:assert/strict";
import jsQR from "jsqr";
import QRCode from "qrcode";
import {
  decodeTownshipPairingQrImageData,
  renderTownshipPairingQrSvg,
} from "../src/township_pairing_qr";
import {
  exportTownshipCarrierPairingHandoff,
  importTownshipCarrierPairingHandoff,
  TOWNSHIP_CARRIER_PAIRING_HANDOFF_PREFIX,
  type TownshipCarrierPeerConfig,
} from "../src/township_carrier_peer";
import { TOWNSHIP_REPLICA } from "../src/township_actions";

console.log("\n▸ Township pairing QR rendering");

const config: TownshipCarrierPeerConfig = {
  url: "wss://carrier.example/township",
  localRealm: "resident-device-local",
  expectedPeerRealm: "township-carrier",
  expectedPeerPubkey: Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
  replica: TOWNSHIP_REPLICA,
  keyId: "resident-device-key",
};
const handoff = exportTownshipCarrierPairingHandoff(config);

const rendered = renderTownshipPairingQrSvg(handoff);
assert.equal(rendered.ok, true);
assert.match(rendered.svg, /^<svg[^>]+role="img"/);
assert.match(rendered.svg, /aria-label="Township pairing QR"/);
assert.match(rendered.svg, /<path /);
assert.equal(rendered.moduleCount, rendered.modules.length);
assert.ok(rendered.moduleCount >= 21);
assert.ok(rendered.modules.every((row) => row.length === rendered.moduleCount));

const decoded = decodeQrModules(rendered.modules);
assert.equal(decoded, handoff);
assert.match(decoded, new RegExp(`^${escapeRegExp(TOWNSHIP_CARRIER_PAIRING_HANDOFF_PREFIX)}`));
assert.doesNotMatch(decoded, /resident-device-local/);
assert.doesNotMatch(decoded, /resident-device-key/);
assert.doesNotMatch(decoded, /localRealm/);
assert.doesNotMatch(decoded, /keyId/);
assert.doesNotMatch(decoded, /private|secret|seed/i);
assert.doesNotMatch(rendered.svg, /resident-device-local|resident-device-key|localRealm|keyId/);

const imported = importTownshipCarrierPairingHandoff(decoded);
assert.equal(imported.ok, true);
assert.deepEqual(imported.draft, {
  url: config.url,
  expectedPeerRealm: config.expectedPeerRealm,
  expectedPeerPubkey: config.expectedPeerPubkey,
  replica: config.replica,
});

const image = qrModulesToImageData(rendered.modules);
const scanned = decodeTownshipPairingQrImageData(image.data, image.width, image.height);
assert.equal(scanned.ok, true);
if (!scanned.ok) throw new Error(scanned.message);
assert.equal(scanned.handoff, handoff);
assert.deepEqual(scanned.draft, imported.draft);
assert.equal(scanned.peerFingerprint, imported.peerFingerprint);

const blank = blankImageData(image.width, image.height);
assert.deepEqual(decodeTownshipPairingQrImageData(blank.data, blank.width, blank.height), {
  ok: false,
  reason: "invalid_pairing_qr",
  message: "Load an image containing a Township pairing QR.",
});

const malformedQr = renderTextQr("township-pairing:v1:not-json");
const malformedImage = qrModulesToImageData(malformedQr);
const malformedScan = decodeTownshipPairingQrImageData(
  malformedImage.data,
  malformedImage.width,
  malformedImage.height,
);
assert.equal(malformedScan.ok, false);
if (malformedScan.ok) throw new Error("malformed QR unexpectedly decoded as valid");
assert.equal(malformedScan.reason, "invalid_pairing_payload");

const rerendered = renderTownshipPairingQrSvg(handoff);
assert.equal(rerendered.ok, true);
assert.deepEqual(rerendered.modules, rendered.modules);
assert.equal(rerendered.svg, rendered.svg);

const invalid = renderTownshipPairingQrSvg("not-a-township-handoff");
assert.deepEqual(invalid, {
  ok: false,
  reason: "invalid_pairing_format",
  message: "Enter a valid Township pairing handoff.",
});

console.log("\x1b[32m✓ Township pairing QR rendering checks passed\x1b[0m");

function renderTextQr(value: string): readonly (readonly boolean[])[] {
  const qr = QRCode.create(value, { errorCorrectionLevel: "M" });
  const modules: boolean[][] = [];
  for (let y = 0; y < qr.modules.size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < qr.modules.size; x++) {
      row.push(qr.modules.data[y * qr.modules.size + x] === 1);
    }
    modules.push(row);
  }
  return modules;
}

function decodeQrModules(modules: readonly (readonly boolean[])[]): string {
  const image = qrModulesToImageData(modules);
  const decoded = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
  assert.ok(decoded, "expected QR matrix to decode");
  return decoded.data;
}

function qrModulesToImageData(modules: readonly (readonly boolean[])[]): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const quietZone = 4;
  const scale = 6;
  const moduleCount = modules.length;
  const imageSize = (moduleCount + quietZone * 2) * scale;
  const data = new Uint8ClampedArray(imageSize * imageSize * 4);

  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }

  for (let moduleY = 0; moduleY < moduleCount; moduleY++) {
    for (let moduleX = 0; moduleX < moduleCount; moduleX++) {
      if (!modules[moduleY]?.[moduleX]) continue;
      paintModule(data, imageSize, (moduleX + quietZone) * scale, (moduleY + quietZone) * scale, scale);
    }
  }

  return { data, width: imageSize, height: imageSize };
}

function blankImageData(width: number, height: number): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
  return { data, width, height };
}

function paintModule(
  data: Uint8ClampedArray,
  imageSize: number,
  startX: number,
  startY: number,
  scale: number,
): void {
  for (let y = startY; y < startY + scale; y++) {
    for (let x = startX; x < startX + scale; x++) {
      const offset = (y * imageSize + x) * 4;
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      data[offset + 3] = 255;
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
