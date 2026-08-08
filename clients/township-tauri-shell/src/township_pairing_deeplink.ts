import {
  createOneShotPairingDeepLinkGate,
  createPairingDeepLinkListener,
  parseCarrierPairingDeepLink,
  type PairingDeepLinkOptions,
} from "@treetopdevs/lattice-mobile-core";
import {
  TOWNSHIP_CARRIER_PAIRING_HANDOFF_PREFIX,
  type TownshipCarrierPairingHandoffError,
  type TownshipCarrierPeerConfigInput,
} from "./township_carrier_peer";
import { TOWNSHIP_REPLICA } from "./township_actions";

// The product-neutral deep-link seam lives in
// @treetopdevs/lattice-mobile-core (plan 158 seam extraction); this module
// binds it to the township:// scheme and Township handoff prefix.
const TOWNSHIP_PAIRING_DEEPLINK_OPTIONS: PairingDeepLinkOptions = {
  scheme: "township",
  handoffPrefix: TOWNSHIP_CARRIER_PAIRING_HANDOFF_PREFIX,
  legacyHandoffPrefix: "township-pairing:",
  defaultReplica: TOWNSHIP_REPLICA,
};

export type TownshipPairingDeepLinkReason = TownshipCarrierPairingHandoffError | "invalid_pairing_deeplink";

export type TownshipPairingDeepLinkParse =
  | {
      ok: true;
      handoff: string;
      state: string | null;
      draft: TownshipCarrierPeerConfigInput;
      peerFingerprint: string;
    }
  | {
      ok: false;
      reason: TownshipPairingDeepLinkReason;
      message: string;
    };

export interface TownshipPairingDeepLinkSource {
  current(): Promise<readonly string[] | null>;
  onOpenUrl(callback: (urls: readonly string[]) => void): Promise<(() => void) | void>;
}

export interface TownshipPairingDeepLinkListener {
  stop(): void;
}

export type TownshipPairingDeepLinkBlockedReason = "not_armed" | "state_mismatch";

export type TownshipPairingDeepLinkGateConsumption =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: TownshipPairingDeepLinkBlockedReason;
    };

export interface TownshipPairingDeepLinkGateOptions {
  createState?: () => string;
}

export interface TownshipPairingDeepLinkGate {
  arm(): string;
  disarm(): void;
  armed(): boolean;
  state(): string | null;
  consume(parse: TownshipPairingDeepLinkParse): TownshipPairingDeepLinkGateConsumption;
}

export interface TownshipPairingDeepLinkBlocked {
  reason: TownshipPairingDeepLinkBlockedReason;
  parse: TownshipPairingDeepLinkParse;
}

export interface TownshipPairingDeepLinkListenerOptions {
  source: TownshipPairingDeepLinkSource;
  gate?: TownshipPairingDeepLinkGate | undefined;
  apply(parse: TownshipPairingDeepLinkParse): void;
  onBlocked?(blocked: TownshipPairingDeepLinkBlocked): void;
}

export function parseTownshipPairingDeepLink(value: string): TownshipPairingDeepLinkParse {
  return parseCarrierPairingDeepLink(value, TOWNSHIP_PAIRING_DEEPLINK_OPTIONS) as TownshipPairingDeepLinkParse;
}

export async function createTownshipPairingDeepLinkListener(
  options: TownshipPairingDeepLinkListenerOptions,
): Promise<TownshipPairingDeepLinkListener> {
  const onBlocked = options.onBlocked?.bind(options);
  return createPairingDeepLinkListener({
    source: options.source,
    gate: options.gate,
    parse: parseTownshipPairingDeepLink,
    apply: (parse) => options.apply(parse as TownshipPairingDeepLinkParse),
    ...(onBlocked
      ? {
          onBlocked: (blocked: { reason: TownshipPairingDeepLinkBlockedReason; parse: unknown }) =>
            onBlocked({ reason: blocked.reason, parse: blocked.parse as TownshipPairingDeepLinkParse }),
        }
      : {}),
  });
}

export function createOneShotTownshipPairingDeepLinkGate(
  options: TownshipPairingDeepLinkGateOptions = {},
): TownshipPairingDeepLinkGate {
  return createOneShotPairingDeepLinkGate({
    createState: options.createState ?? createPairingImportState,
  }) as TownshipPairingDeepLinkGate;
}

function createPairingImportState(): string {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) throw new Error("crypto unavailable for pairing import state");

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
