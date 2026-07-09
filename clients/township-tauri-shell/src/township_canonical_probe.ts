import {
  canonicalBytesForCarrierOp,
  canonicalHash,
  canonicalSuite,
  type CarrierOpFrame,
} from "@treetopdevs/lattice-client";
import townshipCarrierW1Vector from "../../lattice-client/test/vectors/township_carrier_w1.json";
import { logTownshipProbeEvent, type TownshipNativeWorkflowOptions } from "./native_workflow";

export const TOWNSHIP_CANONICAL_PROBE_VECTOR_ID = "township_carrier_w1";
export const TOWNSHIP_CANONICAL_PROBE_LOG_PREFIX = "township-canonical-probe";

interface CanonicalProbeVector {
  scenario: string;
  oracleCarrierOps: CarrierOpFrame[];
  canonicalOps: CanonicalProbeEntry[];
}

interface CanonicalProbeEntry {
  id: string;
  suite: typeof canonicalSuite;
  bytesHex: string;
  hash: string;
}

export interface TownshipCanonicalProbeResult {
  vectorId: string;
  suite: typeof canonicalSuite;
  opCount: number;
  digest: string;
  expectedDigest: string;
  mismatches: string[];
}

export interface TownshipCanonicalProbeDeepLinkSource {
  current(): Promise<readonly string[] | null>;
  onOpenUrl(callback: (urls: readonly string[]) => void): Promise<(() => void) | void>;
}

export interface TownshipCanonicalProbeDeepLinkListener {
  stop(): void;
}

export interface TownshipCanonicalProbeDeepLinkListenerOptions
  extends Pick<TownshipNativeWorkflowOptions, "invoke"> {
  source: TownshipCanonicalProbeDeepLinkSource;
  pollDurationMs?: number;
  pollIntervalMs?: number;
}

const defaultVector = townshipCarrierW1Vector as unknown as CanonicalProbeVector;
const textEncoder = new TextEncoder();

export function parseTownshipCanonicalProbeDeepLink(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "township:" || url.hostname !== "probe" || url.pathname !== "/canonical") {
    return null;
  }

  return url.searchParams.get("vector")?.trim() || TOWNSHIP_CANONICAL_PROBE_VECTOR_ID;
}

export async function createTownshipCanonicalProbeDeepLinkListener(
  options: TownshipCanonicalProbeDeepLinkListenerOptions,
): Promise<TownshipCanonicalProbeDeepLinkListener> {
  const seen = new Set<string>();
  let stopped = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let stopOpenUrl: (() => void) | void;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const pollUntil = Date.now() + (options.pollDurationMs ?? 15_000);
  const handleUrls = async (urls: readonly string[] | null): Promise<void> => {
    if (!urls || stopped) return;
    for (const url of urls) {
      if (seen.has(url)) continue;
      if (await maybeHandleTownshipCanonicalProbeDeepLink(url, options)) {
        seen.add(url);
      }
    }
  };
  const pollCurrent = async (): Promise<void> => {
    try {
      await handleUrls(await options.source.current());
    } catch {
      // Deep-link current probing is best-effort; future polls or events may still arrive.
    }
  };

  await pollCurrent();

  try {
    stopOpenUrl = await options.source.onOpenUrl((urls) => {
      void handleUrls(urls);
    });
  } catch {
    stopOpenUrl = undefined;
  }

  pollTimer = setInterval(() => {
    if (stopped || Date.now() > pollUntil) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    void pollCurrent();
  }, pollIntervalMs);

  return {
    stop() {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      stopOpenUrl?.();
    },
  };
}

export async function maybeHandleTownshipCanonicalProbeDeepLink(
  value: string,
  options: Pick<TownshipNativeWorkflowOptions, "invoke"> = {},
): Promise<boolean> {
  const vectorId = parseTownshipCanonicalProbeDeepLink(value);
  if (vectorId === null) return false;

  await logProbeLine(
    `${TOWNSHIP_CANONICAL_PROBE_LOG_PREFIX} variant=android vector=${probeToken(vectorId)} status=received`,
    options,
  );

  try {
    if (vectorId !== TOWNSHIP_CANONICAL_PROBE_VECTOR_ID) {
      await logProbeLine(
        `${TOWNSHIP_CANONICAL_PROBE_LOG_PREFIX} variant=android vector=${probeToken(vectorId)} status=unsupported`,
        options,
      );
      return true;
    }

    const result = await townshipCanonicalProbeResult();
    await logProbeLine(townshipCanonicalProbeLogLine(result), options);
  } catch (error) {
    await logProbeLine(
      `${TOWNSHIP_CANONICAL_PROBE_LOG_PREFIX} variant=android vector=${probeToken(vectorId)} status=error message=${probeToken(errorMessage(error))}`,
      options,
    );
  }

  return true;
}

export async function logTownshipCanonicalProbe(
  options: Pick<TownshipNativeWorkflowOptions, "invoke"> = {},
): Promise<void> {
  await logProbeLine(townshipCanonicalProbeLogLine(await townshipCanonicalProbeResult()), options);
}

export async function townshipCanonicalProbeResult(
  vector: CanonicalProbeVector = defaultVector,
): Promise<TownshipCanonicalProbeResult> {
  const actualEntries = await actualCanonicalEntries(vector.oracleCarrierOps);
  const expectedEntries = normalizeEntries(vector.canonicalOps);
  const expectedById = new Map(expectedEntries.map((entry) => [entry.id, entry]));
  const actualById = new Map(actualEntries.map((entry) => [entry.id, entry]));
  const mismatches: string[] = [];

  for (const actual of actualEntries) {
    const expected = expectedById.get(actual.id);
    if (!expected) {
      mismatches.push(`${actual.id}:missing_expected`);
      continue;
    }
    if (actual.bytesHex !== expected.bytesHex) mismatches.push(`${actual.id}:bytes`);
    if (actual.hash !== expected.hash) mismatches.push(`${actual.id}:hash`);
  }

  for (const expected of expectedEntries) {
    if (!actualById.has(expected.id)) mismatches.push(`${expected.id}:missing_actual`);
  }

  return {
    vectorId: vector.scenario,
    suite: canonicalSuite,
    opCount: actualEntries.length,
    digest: await canonicalProbeDigest(actualEntries),
    expectedDigest: await canonicalProbeDigest(expectedEntries),
    mismatches,
  };
}

export async function expectedTownshipCanonicalProbeDigest(
  vector: CanonicalProbeVector = defaultVector,
): Promise<string> {
  return canonicalProbeDigest(vector.canonicalOps);
}

export function townshipCanonicalProbeLogLine(result: TownshipCanonicalProbeResult): string {
  return [
    TOWNSHIP_CANONICAL_PROBE_LOG_PREFIX,
    "variant=android",
    `vector=${probeToken(result.vectorId)}`,
    `suite=${probeToken(result.suite)}`,
    `ops=${result.opCount}`,
    `digest=${result.digest}`,
    `expected=${result.expectedDigest}`,
    `mismatches=${result.mismatches.length}`,
  ].join(" ");
}

async function actualCanonicalEntries(frames: readonly CarrierOpFrame[]): Promise<CanonicalProbeEntry[]> {
  const entries: CanonicalProbeEntry[] = [];

  for (const frame of frames) {
    const bytes = canonicalBytesForCarrierOp(frame);
    entries.push({
      id: frame.id,
      suite: canonicalSuite,
      bytesHex: bytesToHex(bytes),
      hash: await canonicalHash(bytes),
    });
  }

  return normalizeEntries(entries);
}

async function canonicalProbeDigest(entries: readonly CanonicalProbeEntry[]): Promise<string> {
  return canonicalHash(textEncoder.encode(JSON.stringify(normalizeEntries(entries))));
}

function normalizeEntries(entries: readonly CanonicalProbeEntry[]): CanonicalProbeEntry[] {
  return entries
    .map((entry) => ({
      id: entry.id,
      suite: entry.suite,
      bytesHex: entry.bytesHex,
      hash: entry.hash,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function logProbeLine(
  line: string,
  options: Pick<TownshipNativeWorkflowOptions, "invoke">,
): Promise<void> {
  try {
    await logTownshipProbeEvent(line, options);
  } catch {
    // The probe is observability-only; browsers without the native command should ignore it.
  }
}

function probeToken(value: string): string {
  return value.replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
