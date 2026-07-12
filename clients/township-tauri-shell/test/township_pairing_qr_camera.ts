import assert from "node:assert/strict";
import QRCode from "qrcode";
import {
  createTownshipPairingQrCameraScanner,
  type TownshipPairingQrCameraFrame,
} from "../src/township_pairing_qr_camera";
import {
  exportTownshipCarrierPairingHandoff,
  type TownshipCarrierPeerConfig,
} from "../src/township_carrier_peer";
import { TOWNSHIP_REPLICA } from "../src/township_actions";

console.log("\n▸ Township pairing QR camera capture");

const config: TownshipCarrierPeerConfig = {
  url: "wss://carrier.example/township",
  localRealm: "resident-device-local",
  expectedPeerRealm: "township-carrier",
  expectedPeerPubkey: Buffer.from(new Uint8Array(32).fill(11)).toString("base64"),
  replica: TOWNSHIP_REPLICA,
  keyId: "resident-device-key",
};
const handoff = exportTownshipCarrierPairingHandoff(config);

let frameSink: ((frame: TownshipPairingQrCameraFrame) => void) | null = null;
let stopCount = 0;
const applied: unknown[] = [];
const scanner = await createTownshipPairingQrCameraScanner({
  source: {
    async start(onFrame) {
      frameSink = onFrame;
      return () => {
        stopCount++;
      };
    },
  },
  apply(result) {
    applied.push(result);
  },
});

assert.ok(frameSink, "camera scanner should subscribe to frames");
frameSink(blankImageData(120, 120));
assert.equal(applied.length, 0, "blank camera frames should not overwrite pairing state");
assert.equal(stopCount, 0);

frameSink(qrImageData(handoff));
assert.equal(applied.length, 1);
const captured = applied[0];
assert.deepEqual(captured, {
  ok: true,
  handoff,
  draft: {
    url: config.url,
    expectedPeerRealm: config.expectedPeerRealm,
    expectedPeerPubkey: config.expectedPeerPubkey,
    replica: config.replica,
    submission: "push",
  },
  peerFingerprint: "0b0b0b0b...0b0b0b0b",
});
assert.equal(stopCount, 1, "camera source should stop after the first pairing QR result");
assert.doesNotMatch(JSON.stringify(captured), /resident-device-local|resident-device-key|localRealm|keyId/);

frameSink(qrImageData("township-pairing:v1:not-json"));
assert.equal(applied.length, 1, "frames after a captured result should be ignored");
scanner.stop();
assert.equal(stopCount, 1, "scanner stop should be idempotent after auto-stop");

const invalidApplied: unknown[] = [];
let invalidFrameSink: ((frame: TownshipPairingQrCameraFrame) => void) | null = null;
let invalidStopCount = 0;
await createTownshipPairingQrCameraScanner({
  source: {
    async start(onFrame) {
      invalidFrameSink = onFrame;
      return () => {
        invalidStopCount++;
      };
    },
  },
  apply(result) {
    invalidApplied.push(result);
  },
});

assert.ok(invalidFrameSink, "invalid scanner should subscribe to frames");
invalidFrameSink(qrImageData("township-pairing:v1:not-json"));
assert.deepEqual(invalidApplied, [
  {
    ok: false,
    reason: "invalid_pairing_payload",
    message: "Pairing handoff invalid: payload could not be decoded.",
  },
]);
assert.equal(invalidStopCount, 1, "camera source should stop after a non-empty invalid pairing QR");

console.log("\x1b[32m✓ Township pairing QR camera checks passed\x1b[0m");

function qrImageData(value: string): TownshipPairingQrCameraFrame {
  const qr = QRCode.create(value, { errorCorrectionLevel: "M" });
  const modules: boolean[][] = [];
  for (let y = 0; y < qr.modules.size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < qr.modules.size; x++) {
      row.push(qr.modules.data[y * qr.modules.size + x] === 1);
    }
    modules.push(row);
  }

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

function blankImageData(width: number, height: number): TownshipPairingQrCameraFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
  return { data, width, height };
}

function paintModule(data: Uint8ClampedArray, width: number, x: number, y: number, size: number): void {
  for (let py = y; py < y + size; py++) {
    for (let px = x; px < x + size; px++) {
      const offset = (py * width + px) * 4;
      data[offset] = 17;
      data[offset + 1] = 24;
      data[offset + 2] = 39;
      data[offset + 3] = 255;
    }
  }
}
