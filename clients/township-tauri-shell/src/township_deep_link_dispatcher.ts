import {
  parseTownshipActionIntentDeepLink,
  type TownshipPostActionIntent,
} from "./township_action_intent";
import type { TownshipPairingDeepLinkSource } from "./township_pairing_deeplink";

export type TownshipActionIntentIngressReason = "invalid_action" | "pairing_missing" | "replica_mismatch";

export interface TownshipActionIntentRejection {
  reason: TownshipActionIntentIngressReason;
  intentId: string | null;
  message: string;
}

export interface TownshipActionIntentTrace {
  intentId: string | null;
  outcome: "staged" | TownshipActionIntentIngressReason;
}

export interface TownshipParticipantDeepLinkDispatcher {
  stop(): void;
}

export interface TownshipParticipantDeepLinkDispatcherOptions {
  source: TownshipPairingDeepLinkSource;
  expectedReplica(): string | null;
  stageAction(intent: TownshipPostActionIntent): void;
  rejectAction(rejection: TownshipActionIntentRejection): void;
  routeOther(url: string): void;
  traceAction?(trace: TownshipActionIntentTrace): void | Promise<void>;
}

export async function createTownshipParticipantDeepLinkDispatcher(
  options: TownshipParticipantDeepLinkDispatcherOptions,
): Promise<TownshipParticipantDeepLinkDispatcher> {
  const handleUrls = (urls: readonly string[] | null): void => {
    for (const url of urls ?? []) dispatchUrl(url, options);
  };

  const stop = await options.source.onOpenUrl(handleUrls);

  try {
    handleUrls(await options.source.current());
  } catch {
    // Warm events remain available when cold-start URL recovery is unavailable.
  }

  return {
    stop() {
      stop?.();
    },
  };
}

function dispatchUrl(url: string, options: TownshipParticipantDeepLinkDispatcherOptions): void {
  if (!isActionRoute(url)) {
    options.routeOther(url);
    return;
  }

  const parsed = parseTownshipActionIntentDeepLink(url);
  if (!parsed.ok) {
    reject(options, {
      reason: "invalid_action",
      intentId: null,
      message: parsed.message,
    });
    return;
  }

  const expectedReplica = safeExpectedReplica(options);
  if (expectedReplica === null) {
    reject(options, {
      reason: "pairing_missing",
      intentId: parsed.intent.id,
      message: "Pair this Township before reviewing the participant request.",
    });
    return;
  }

  if (parsed.intent.replica !== expectedReplica) {
    reject(options, {
      reason: "replica_mismatch",
      intentId: parsed.intent.id,
      message: "Participant request ignored: it targets a different Township replica.",
    });
    return;
  }

  options.stageAction(parsed.intent);
  trace(options, { intentId: parsed.intent.id, outcome: "staged" });
}

function reject(
  options: TownshipParticipantDeepLinkDispatcherOptions,
  rejection: TownshipActionIntentRejection,
): void {
  options.rejectAction(rejection);
  trace(options, { intentId: rejection.intentId, outcome: rejection.reason });
}

function trace(options: TownshipParticipantDeepLinkDispatcherOptions, event: TownshipActionIntentTrace): void {
  try {
    void Promise.resolve(options.traceAction?.(event)).catch(() => {});
  } catch {
    // Development tracing is optional and must not block participant ingress.
  }
}

function safeExpectedReplica(options: TownshipParticipantDeepLinkDispatcherOptions): string | null {
  try {
    const replica = options.expectedReplica();
    return typeof replica === "string" && replica.length > 0 ? replica : null;
  } catch {
    return null;
  }
}

function isActionRoute(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  return url.protocol === "township:" && url.hostname === "action";
}
