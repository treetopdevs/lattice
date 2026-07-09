import {
  importTownshipCarrierPairingHandoff,
  type TownshipCarrierPairingHandoffError,
  type TownshipCarrierPeerConfigInput,
} from "./township_carrier_peer";

export type TownshipPairingDeepLinkReason = TownshipCarrierPairingHandoffError | "invalid_pairing_deeplink";

export type TownshipPairingDeepLinkParse =
  | {
      ok: true;
      handoff: string;
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

export interface TownshipPairingDeepLinkListenerOptions {
  source: TownshipPairingDeepLinkSource;
  apply(parse: TownshipPairingDeepLinkParse): void;
}

const TAURI_ANDROID_PAIRING_HANDOFF_PREFIX = "township-pairing_3Av1_3A";

export function parseTownshipPairingDeepLink(value: string): TownshipPairingDeepLinkParse {
  const handoff = pairingHandoffFromLink(value);
  if (handoff === null) return deepLinkError("invalid_pairing_deeplink");

  const imported = importTownshipCarrierPairingHandoff(handoff);
  if (!imported.ok) {
    return deepLinkError(imported.errors[0] ?? "invalid_pairing_format", imported.message);
  }

  return {
    ok: true,
    handoff,
    draft: imported.draft,
    peerFingerprint: imported.peerFingerprint,
  };
}

export async function createTownshipPairingDeepLinkListener(
  options: TownshipPairingDeepLinkListenerOptions,
): Promise<TownshipPairingDeepLinkListener> {
  const applyUrls = (urls: readonly string[]) => {
    for (const url of urls) options.apply(parseTownshipPairingDeepLink(url));
  };

  const stop = await options.source.onOpenUrl(applyUrls);
  const current = await options.source.current();
  if (current) applyUrls(current);

  return {
    stop() {
      stop?.();
    },
  };
}

function pairingHandoffFromLink(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "township:") return null;
  if (
    url.hostname !== "pairing" &&
    !androidPairingPath(url.pathname) &&
    !tauriAndroidNoHostPairingRoute(url)
  ) {
    return null;
  }

  const queryHandoff = present(url.searchParams.get("handoff"));
  if (queryHandoff) return queryHandoff;

  const pathHandoff = present(pairingPathHandoff(url));
  return pathHandoff;
}

function androidPairingPath(pathname: string): boolean {
  const path = pathWithoutLeadingSlash(pathname);
  return path === "pairing" || path.startsWith("pairing/");
}

function tauriAndroidNoHostPairingRoute(url: URL): boolean {
  const path = pathWithoutLeadingSlash(url.pathname);
  if (url.hostname === "nohost") {
    return path === "_pairing" || path.startsWith("_pairing/") || path.startsWith("_pairing_");
  }
  return path === "nohost:_pairing" || path.startsWith("nohost:_pairing/") || path.startsWith("nohost:_pairing_");
}

function pairingPathHandoff(url: URL): string {
  const path = pathWithoutLeadingSlash(url.pathname);
  if (url.hostname === "pairing") return normalizeTauriAndroidRouteHandoff(path);
  if (tauriAndroidNoHostPairingRoute(url)) {
    if (url.hostname === "nohost") return normalizeTauriAndroidRouteHandoff(path.replace(/^_pairing(?:\/|_)?/, ""));
    return normalizeTauriAndroidRouteHandoff(path.replace(/^nohost:_pairing(?:\/|_)?/, ""));
  }
  return normalizeTauriAndroidRouteHandoff(path.replace(/^pairing\/?/, ""));
}

function pathWithoutLeadingSlash(pathname: string): string {
  const withoutSlash = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  try {
    return decodeURIComponent(withoutSlash);
  } catch {
    return withoutSlash;
  }
}

function normalizeTauriAndroidRouteHandoff(value: string): string {
  if (!value.startsWith(TAURI_ANDROID_PAIRING_HANDOFF_PREFIX)) return value;
  return `township-pairing:v1:${value.slice(TAURI_ANDROID_PAIRING_HANDOFF_PREFIX.length)}`;
}

function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function deepLinkError(reason: TownshipPairingDeepLinkReason, message?: string): TownshipPairingDeepLinkParse {
  return {
    ok: false,
    reason,
    message: message ?? deepLinkErrorMessage(reason),
  };
}

function deepLinkErrorMessage(reason: TownshipPairingDeepLinkReason): string {
  switch (reason) {
    case "invalid_pairing_deeplink":
      return "Pairing link invalid: expected township://pairing with a pairing handoff.";
    case "unsupported_pairing_version":
      return "Pairing handoff invalid: unsupported version.";
    case "invalid_pairing_payload":
      return "Pairing handoff invalid: payload could not be decoded.";
    default:
      return "Pairing config invalid: verify the carrier URL, peer realm, and peer public key.";
  }
}
