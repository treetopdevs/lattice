import {
  decodeTownshipPairingQrImageData,
  type TownshipPairingQrDecode,
} from "./township_pairing_qr";

export interface TownshipPairingQrCameraFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface TownshipPairingQrCameraSource {
  start(onFrame: (frame: TownshipPairingQrCameraFrame) => void): Promise<(() => void) | void>;
}

export interface TownshipPairingQrCameraScanner {
  stop(): void;
}

export interface TownshipPairingQrCameraScannerOptions {
  source: TownshipPairingQrCameraSource;
  apply(result: TownshipPairingQrDecode): void;
  decode?(frame: TownshipPairingQrCameraFrame): TownshipPairingQrDecode;
}

export async function createTownshipPairingQrCameraScanner(
  options: TownshipPairingQrCameraScannerOptions,
): Promise<TownshipPairingQrCameraScanner> {
  const decode = options.decode ?? decodePairingQrCameraFrame;
  let stopped = false;
  let stopSource: (() => void) | void;
  let stopRequestedDuringStart = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (stopSource) {
      stopSource();
    } else {
      stopRequestedDuringStart = true;
    }
  };

  stopSource = await options.source.start((frame) => {
    if (stopped) return;

    const result = decode(frame);
    if (!result.ok && result.reason === "invalid_pairing_qr") return;

    options.apply(result);
    stop();
  });

  if (stopRequestedDuringStart && stopSource) stopSource();

  return { stop };
}

function decodePairingQrCameraFrame(frame: TownshipPairingQrCameraFrame): TownshipPairingQrDecode {
  return decodeTownshipPairingQrImageData(frame.data, frame.width, frame.height);
}
