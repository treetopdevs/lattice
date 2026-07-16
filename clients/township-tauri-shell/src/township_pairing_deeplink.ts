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
    state: pairingStateFromLink(value),
    draft: imported.draft,
    peerFingerprint: imported.peerFingerprint,
  };
}

export async function createTownshipPairingDeepLinkListener(
  options: TownshipPairingDeepLinkListenerOptions,
): Promise<TownshipPairingDeepLinkListener> {
  const applyUrls = (urls: readonly string[]) => {
    for (const url of urls) {
      const parse = parseTownshipPairingDeepLink(url);
      const consumption = options.gate?.consume(parse) ?? { ok: true };
      if (!consumption.ok) {
        options.onBlocked?.({ reason: consumption.reason, parse });
        continue;
      }
      options.apply(parse);
    }
  };

  const stop = await options.source.onOpenUrl(applyUrls);
  const current = await options.source.current();
  if (current) applyUrls(current);

  return {
    stop() {
      options.gate?.disarm();
      stop?.();
    },
  };
}

export function createOneShotTownshipPairingDeepLinkGate(
  options: TownshipPairingDeepLinkGateOptions = {},
): TownshipPairingDeepLinkGate {
  let isArmed = false;
  let armedState: string | null = null;

  return {
    arm() {
      isArmed = true;
      armedState = present((options.createState ?? createPairingImportState)());
      if (armedState === null) throw new Error("pairing import state cannot be empty");
      return armedState;
    },
    disarm() {
      isArmed = false;
      armedState = null;
    },
    armed() {
      return isArmed;
    },
    state() {
      return armedState;
    },
    consume(parse: TownshipPairingDeepLinkParse) {
      if (!isArmed) return { ok: false, reason: "not_armed" };
      if (!parse.ok) return { ok: true };
      if (parse.state !== armedState) return { ok: false, reason: "state_mismatch" };
      isArmed = false;
      armedState = null;
      return { ok: true };
    },
  };
}

function createPairingImportState(): string {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) throw new Error("crypto unavailable for pairing import state");

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pairingHandoffFromLink(value: string): string | null {
  const townshipHandoff = pairingHandoffFromTownshipScheme(value);
  if (townshipHandoff !== null) return townshipHandoff;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "township:") return null;
  if (url.port !== "") return null;
  if (
    url.hostname !== "pairing" &&
    !(url.hostname === "" && androidPairingPath(url.pathname)) &&
    !tauriAndroidNoHostPairingRoute(url)
  ) {
    return null;
  }

  const queryHandoff = present(url.searchParams.get("handoff"));
  if (queryHandoff) return queryHandoff;

  const pathHandoff = present(pairingPathHandoff(url));
  return pathHandoff;
}

function pairingStateFromLink(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("township:")) return null;

  const queryStart = trimmed.indexOf("?");
  if (queryStart < 0) return null;
  const fragmentStart = trimmed.indexOf("#", queryStart);
  const query = trimmed.slice(queryStart + 1, fragmentStart > queryStart ? fragmentStart : undefined);
  return present(new URLSearchParams(query).get("state"));
}

function pairingHandoffFromTownshipScheme(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("township:")) return null;

  const withoutScheme = trimmed.slice("township:".length).replace(/^\/+/, "");
  const queryStart = withoutScheme.indexOf("?");
  const fragmentStart = withoutScheme.indexOf("#");
  const routeEndCandidates = [queryStart, fragmentStart].filter((index) => index >= 0);
  const routeEnd = routeEndCandidates.length > 0 ? Math.min(...routeEndCandidates) : withoutScheme.length;
  const route = decodePathSegment(withoutScheme.slice(0, routeEnd));
  const query =
    queryStart >= 0
      ? withoutScheme.slice(queryStart + 1, fragmentStart > queryStart ? fragmentStart : undefined)
      : "";

  if (!townshipPairingRoute(route)) return null;

  const queryHandoff = present(new URLSearchParams(query).get("handoff"));
  if (queryHandoff) return queryHandoff;

  return present(townshipPairingRouteHandoff(route));
}

function townshipPairingRoute(route: string): boolean {
  return (
    route === "pairing" ||
    route.startsWith("pairing/") ||
    route === "nohost/_pairing" ||
    route.startsWith("nohost/_pairing/") ||
    route.startsWith("nohost/_pairing_") ||
    route === "nohost:_pairing" ||
    route.startsWith("nohost:_pairing/") ||
    route.startsWith("nohost:_pairing_")
  );
}

function townshipPairingRouteHandoff(route: string): string | null {
  if (route.startsWith("pairing/")) return normalizeTauriAndroidRouteHandoff(route.slice("pairing/".length));
  if (route.startsWith("nohost/_pairing/")) {
    return normalizeTauriAndroidRouteHandoff(route.slice("nohost/_pairing/".length));
  }
  if (route.startsWith("nohost/_pairing_")) {
    return normalizeTauriAndroidRouteHandoff(route.slice("nohost/_pairing_".length));
  }
  if (route.startsWith("nohost:_pairing/")) {
    return normalizeTauriAndroidRouteHandoff(route.slice("nohost:_pairing/".length));
  }
  if (route.startsWith("nohost:_pairing_")) {
    return normalizeTauriAndroidRouteHandoff(route.slice("nohost:_pairing_".length));
  }
  return null;
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
  if (url.hostname !== "") return false;
  return path === "nohost:_pairing" || path.startsWith("nohost:_pairing/") || path.startsWith("nohost:_pairing_");
}

function pairingPathHandoff(url: URL): string {
  const path = pathWithoutLeadingSlash(url.pathname);
  if (url.hostname === "pairing") return normalizeTauriAndroidRouteHandoff(path);
  if (tauriAndroidNoHostPairingRoute(url)) {
    if (url.hostname === "nohost") return normalizeTauriAndroidRouteHandoff(path.replace(/^_pairing(?:\/|_)?/, ""));
    return normalizeTauriAndroidRouteHandoff(path.replace(/^nohost:_pairing(?:\/|_)?/, ""));
  }
  if (url.hostname !== "") return "";
  return normalizeTauriAndroidRouteHandoff(path.replace(/^pairing\/?/, ""));
}

function pathWithoutLeadingSlash(pathname: string): string {
  const withoutSlash = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  return decodePathSegment(withoutSlash);
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
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
