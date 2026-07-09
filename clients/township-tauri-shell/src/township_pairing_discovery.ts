import {
  importTownshipCarrierPairingHandoff,
  type TownshipCarrierPairingHandoffError,
  type TownshipCarrierPeerConfigInput,
} from "./township_carrier_peer";

export interface TownshipPairingDiscoveryAdvert {
  label?: string | null | undefined;
  handoff: string;
}

export type TownshipPairingDiscoveryFailureReason = TownshipCarrierPairingHandoffError;

export type TownshipPairingDiscoveryResult =
  | {
      ok: true;
      id: string;
      label: string;
      handoff: string;
      draft: TownshipCarrierPeerConfigInput;
      peerFingerprint: string;
    }
  | {
      ok: false;
      label: string;
      reason: TownshipPairingDiscoveryFailureReason;
      message: string;
    };

export interface TownshipPairingDiscoverySource {
  start(onAdvert: (advert: TownshipPairingDiscoveryAdvert) => void): Promise<(() => void) | void>;
}

export interface TownshipPairingDiscovery {
  stop(): void;
}

export interface TownshipPairingDiscoveryOptions {
  source: TownshipPairingDiscoverySource;
  apply(result: TownshipPairingDiscoveryResult): void;
}

export async function createTownshipPairingDiscovery(
  options: TownshipPairingDiscoveryOptions,
): Promise<TownshipPairingDiscovery> {
  const seen = new Set<string>();
  let stopped = false;
  let stopSource: (() => void) | void;

  stopSource = await options.source.start((advert) => {
    if (stopped) return;

    const result = discoveryResultFromAdvert(advert);
    if (result.ok) {
      if (seen.has(result.id)) return;
      seen.add(result.id);
    }

    options.apply(result);
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      stopSource?.();
    },
  };
}

function discoveryResultFromAdvert(advert: TownshipPairingDiscoveryAdvert): TownshipPairingDiscoveryResult {
  const label = present(advert.label) ?? "Discovered carrier";
  const imported = importTownshipCarrierPairingHandoff(advert.handoff);
  if (!imported.ok) {
    return {
      ok: false,
      label,
      reason: imported.errors[0] ?? "invalid_pairing_format",
      message: imported.message,
    };
  }

  return {
    ok: true,
    id: `${imported.peerFingerprint}:${imported.draft.url ?? ""}`,
    label,
    handoff: advert.handoff,
    draft: imported.draft,
    peerFingerprint: imported.peerFingerprint,
  };
}

function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}
