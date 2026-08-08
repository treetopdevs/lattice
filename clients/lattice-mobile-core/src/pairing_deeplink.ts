/**
 * Product-neutral pairing deep-link seam.
 *
 * Extracted from the Township shell's `township_pairing_deeplink.ts`. The
 * product scheme and handoff prefixes arrive through options, so
 * `toolshed://pairing?...` parses with the identical route/normalization
 * behavior the Township shell already proved on device. Cross-product links
 * refuse because the scheme is pinned per shell.
 */

import {
  importCarrierPairingHandoff,
  type CarrierPairingHandoffError,
  type CarrierPeerConfigInput,
  type PairingHandoffOptions,
} from "./pairing_handoff";

export type PairingDeepLinkReason = CarrierPairingHandoffError | "invalid_pairing_deeplink";

export type PairingDeepLinkParse =
  | {
      ok: true;
      handoff: string;
      state: string | null;
      draft: CarrierPeerConfigInput;
      peerFingerprint: string;
    }
  | {
      ok: false;
      reason: PairingDeepLinkReason;
      message: string;
    };

export interface PairingDeepLinkSource {
  current(): Promise<readonly string[] | null>;
  onOpenUrl(callback: (urls: readonly string[]) => void): Promise<(() => void) | void>;
}

export interface PairingDeepLinkListener {
  stop(): void;
}

export type PairingDeepLinkBlockedReason = "not_armed" | "state_mismatch";

export type PairingDeepLinkGateConsumption =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: PairingDeepLinkBlockedReason;
    };

export interface PairingDeepLinkGateOptions {
  createState?: () => string;
}

export interface PairingDeepLinkGate {
  arm(): string;
  disarm(): void;
  armed(): boolean;
  state(): string | null;
  consume(parse: PairingDeepLinkParse): PairingDeepLinkGateConsumption;
}

export interface PairingDeepLinkBlocked {
  reason: PairingDeepLinkBlockedReason;
  parse: PairingDeepLinkParse;
}

export interface PairingDeepLinkOptions extends PairingHandoffOptions {
  /** Product deep-link scheme without the colon, e.g. `township`. */
  scheme: string;
}

export interface PairingDeepLinkListenerOptions {
  source: PairingDeepLinkSource;
  gate?: PairingDeepLinkGate | undefined;
  parse(value: string): PairingDeepLinkParse;
  apply(parse: PairingDeepLinkParse): void;
  onBlocked?(blocked: PairingDeepLinkBlocked): void;
}

export function parseCarrierPairingDeepLink(
  value: string,
  options: PairingDeepLinkOptions,
): PairingDeepLinkParse {
  const handoff = pairingHandoffFromLink(value, options);
  if (handoff === null) return deepLinkError("invalid_pairing_deeplink", options);

  const imported = importCarrierPairingHandoff(handoff, options);
  if (!imported.ok) {
    return deepLinkError(imported.errors[0] ?? "invalid_pairing_format", options, imported.message);
  }

  return {
    ok: true,
    handoff,
    state: pairingStateFromLink(value, options),
    draft: imported.draft,
    peerFingerprint: imported.peerFingerprint,
  };
}

export async function createPairingDeepLinkListener(
  options: PairingDeepLinkListenerOptions,
): Promise<PairingDeepLinkListener> {
  const applyUrls = (urls: readonly string[]) => {
    for (const url of urls) {
      const parse = options.parse(url);
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

export function createOneShotPairingDeepLinkGate(
  options: PairingDeepLinkGateOptions = {},
): PairingDeepLinkGate {
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
    consume(parse: PairingDeepLinkParse) {
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

/** The Tauri Android route encoding of the handoff prefix (`:` -> `_3A`). */
function androidRouteHandoffPrefix(options: PairingDeepLinkOptions): string {
  return options.handoffPrefix.replaceAll(":", "_3A").replace(/_3A$/u, "_3A");
}

function pairingHandoffFromLink(value: string, options: PairingDeepLinkOptions): string | null {
  const schemeHandoff = pairingHandoffFromProductScheme(value, options);
  if (schemeHandoff !== null) return schemeHandoff;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== `${options.scheme}:`) return null;
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

  const pathHandoff = present(pairingPathHandoff(url, options));
  return pathHandoff;
}

function pairingStateFromLink(value: string, options: PairingDeepLinkOptions): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(`${options.scheme}:`)) return null;

  const queryStart = trimmed.indexOf("?");
  if (queryStart < 0) return null;
  const fragmentStart = trimmed.indexOf("#", queryStart);
  const query = trimmed.slice(queryStart + 1, fragmentStart > queryStart ? fragmentStart : undefined);
  return present(new URLSearchParams(query).get("state"));
}

function pairingHandoffFromProductScheme(value: string, options: PairingDeepLinkOptions): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(`${options.scheme}:`)) return null;

  const withoutScheme = trimmed.slice(`${options.scheme}:`.length).replace(/^\/+/, "");
  const queryStart = withoutScheme.indexOf("?");
  const fragmentStart = withoutScheme.indexOf("#");
  const routeEndCandidates = [queryStart, fragmentStart].filter((index) => index >= 0);
  const routeEnd = routeEndCandidates.length > 0 ? Math.min(...routeEndCandidates) : withoutScheme.length;
  const route = decodePathSegment(withoutScheme.slice(0, routeEnd));
  const query =
    queryStart >= 0
      ? withoutScheme.slice(queryStart + 1, fragmentStart > queryStart ? fragmentStart : undefined)
      : "";

  if (!pairingRoute(route)) return null;

  const queryHandoff = present(new URLSearchParams(query).get("handoff"));
  if (queryHandoff) return queryHandoff;

  return present(pairingRouteHandoff(route, options));
}

function pairingRoute(route: string): boolean {
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

function pairingRouteHandoff(route: string, options: PairingDeepLinkOptions): string | null {
  if (route.startsWith("pairing/")) {
    return normalizeTauriAndroidRouteHandoff(route.slice("pairing/".length), options);
  }
  if (route.startsWith("nohost/_pairing/")) {
    return normalizeTauriAndroidRouteHandoff(route.slice("nohost/_pairing/".length), options);
  }
  if (route.startsWith("nohost/_pairing_")) {
    return normalizeTauriAndroidRouteHandoff(route.slice("nohost/_pairing_".length), options);
  }
  if (route.startsWith("nohost:_pairing/")) {
    return normalizeTauriAndroidRouteHandoff(route.slice("nohost:_pairing/".length), options);
  }
  if (route.startsWith("nohost:_pairing_")) {
    return normalizeTauriAndroidRouteHandoff(route.slice("nohost:_pairing_".length), options);
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

function pairingPathHandoff(url: URL, options: PairingDeepLinkOptions): string {
  const path = pathWithoutLeadingSlash(url.pathname);
  if (url.hostname === "pairing") return normalizeTauriAndroidRouteHandoff(path, options);
  if (tauriAndroidNoHostPairingRoute(url)) {
    if (url.hostname === "nohost") {
      return normalizeTauriAndroidRouteHandoff(path.replace(/^_pairing(?:\/|_)?/, ""), options);
    }
    return normalizeTauriAndroidRouteHandoff(path.replace(/^nohost:_pairing(?:\/|_)?/, ""), options);
  }
  if (url.hostname !== "") return "";
  return normalizeTauriAndroidRouteHandoff(path.replace(/^pairing\/?/, ""), options);
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

function normalizeTauriAndroidRouteHandoff(value: string, options: PairingDeepLinkOptions): string {
  const routePrefix = androidRouteHandoffPrefix(options);
  if (!value.startsWith(routePrefix)) return value;
  return `${options.handoffPrefix}${value.slice(routePrefix.length)}`;
}

function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function deepLinkError(
  reason: PairingDeepLinkReason,
  options: PairingDeepLinkOptions,
  message?: string,
): PairingDeepLinkParse {
  return {
    ok: false,
    reason,
    message: message ?? deepLinkErrorMessage(reason, options),
  };
}

function deepLinkErrorMessage(reason: PairingDeepLinkReason, options: PairingDeepLinkOptions): string {
  switch (reason) {
    case "invalid_pairing_deeplink":
      return `Pairing link invalid: expected ${options.scheme}://pairing with a pairing handoff.`;
    case "unsupported_pairing_version":
      return "Pairing handoff invalid: unsupported version.";
    case "invalid_pairing_payload":
      return "Pairing handoff invalid: payload could not be decoded.";
    default:
      return "Pairing config invalid: verify the carrier URL, peer realm, and peer public key.";
  }
}
