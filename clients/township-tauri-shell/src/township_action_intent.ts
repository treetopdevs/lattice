export interface TownshipPostActionIntent {
  v: 1;
  id: string;
  replica: string;
  command: {
    command: "post";
    text: string;
  };
}

export interface TownshipStatusActionIntent {
  v: 2;
  id: string;
  replica: string;
  command: {
    command: "close_matter" | "reopen_matter";
  };
}

export type TownshipActionIntent = TownshipPostActionIntent | TownshipStatusActionIntent;

export type TownshipActionIntentParse =
  | { ok: true; intent: TownshipActionIntent }
  | {
      ok: false;
      reason: "invalid_action_deeplink" | "invalid_action_payload" | "unsupported_action_version";
      message: string;
    };

const MAX_REPLICA_BYTES = 1_024;
const MAX_TEXT_BYTES = 4_096;
const MAX_URL_BYTES = 8_192;
const INTENT_ID = /^[0-9a-f]{32}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function parseTownshipActionIntentDeepLink(value: string): TownshipActionIntentParse {
  if (typeof value !== "string" || utf8Bytes(value) > MAX_URL_BYTES) return deepLinkError();

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return deepLinkError();
  }

  const params = [...url.searchParams.keys()];
  const encodedValues = url.searchParams.getAll("intent");
  if (
    url.protocol !== "township:" ||
    url.hostname !== "action" ||
    url.port !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    params.length !== 1 ||
    params[0] !== "intent" ||
    encodedValues.length !== 1
  ) {
    return deepLinkError();
  }

  const encoded = encodedValues[0];
  if (!encoded || !BASE64URL.test(encoded)) return deepLinkError();

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Url(encoded));
  } catch {
    return payloadError();
  }

  if (!isRecord(payload)) return payloadError();
  if (payload.v !== 1 && payload.v !== 2) {
    return {
      ok: false,
      reason: "unsupported_action_version",
      message: "Township action request invalid: unsupported version.",
    };
  }
  if (!exactKeys(payload, ["command", "id", "replica", "v"])) return payloadError();
  if (typeof payload.id !== "string" || !INTENT_ID.test(payload.id)) return payloadError();
  if (!canonicalBoundedString(payload.replica, MAX_REPLICA_BYTES)) return payloadError();
  if (!isRecord(payload.command)) return payloadError();

  if (payload.v === 1) {
    if (!exactKeys(payload.command, ["command", "text"])) return payloadError();
    if (payload.command.command !== "post") return payloadError();
    if (!canonicalBoundedString(payload.command.text, MAX_TEXT_BYTES)) return payloadError();

    return {
      ok: true,
      intent: payload as unknown as TownshipPostActionIntent,
    };
  }

  if (!exactKeys(payload.command, ["command"])) return payloadError();
  if (payload.command.command !== "close_matter" && payload.command.command !== "reopen_matter") {
    return payloadError();
  }

  return {
    ok: true,
    intent: payload as unknown as TownshipStatusActionIntent,
  };
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;
  const binary = globalThis.atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function canonicalBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value === trimAsciiEdges(value) && utf8Bytes(value) <= maxBytes;
}

function trimAsciiEdges(value: string): string {
  return value.replace(/^[\u0009-\u000D\u0020]+|[\u0009-\u000D\u0020]+$/g, "");
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\u0000") === [...expected].sort().join("\u0000");
}

function deepLinkError(): TownshipActionIntentParse {
  return {
    ok: false,
    reason: "invalid_action_deeplink",
    message: "Township action request invalid: expected township://action with one intent.",
  };
}

function payloadError(): TownshipActionIntentParse {
  return {
    ok: false,
    reason: "invalid_action_payload",
    message: "Township action request invalid: payload could not be accepted.",
  };
}
