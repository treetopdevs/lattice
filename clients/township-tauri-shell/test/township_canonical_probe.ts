import assert from "node:assert/strict";
import type { TauriInvoke } from "@treetopdevs/lattice-client";
import {
  TOWNSHIP_CANONICAL_PROBE_LOG_PREFIX,
  TOWNSHIP_CANONICAL_PROBE_VECTOR_ID,
  expectedTownshipCanonicalProbeDigest,
  createTownshipCanonicalProbeDeepLinkListener,
  logTownshipCanonicalProbe,
  maybeHandleTownshipCanonicalProbeDeepLink,
  parseTownshipCanonicalProbeDeepLink,
  townshipCanonicalProbeLogLine,
  townshipCanonicalProbeResult,
} from "../src/township_canonical_probe";
import { TOWNSHIP_LOG_PROBE_COMMAND } from "../src/native_workflow";

console.log("\n▸ Township canonical probe contract");

assert.equal(
  parseTownshipCanonicalProbeDeepLink("township://probe/canonical?vector=township_carrier_w1"),
  TOWNSHIP_CANONICAL_PROBE_VECTOR_ID,
);
assert.equal(parseTownshipCanonicalProbeDeepLink("township://pairing?handoff=abc"), null);
assert.equal(parseTownshipCanonicalProbeDeepLink("https://example.test/probe/canonical"), null);

const expectedDigest = await expectedTownshipCanonicalProbeDigest();
const result = await townshipCanonicalProbeResult();
assert.equal(result.vectorId, TOWNSHIP_CANONICAL_PROBE_VECTOR_ID);
assert.equal(result.digest, expectedDigest);
assert.equal(result.mismatches.length, 0);
assert.equal(result.opCount > 0, true);

const logLine = townshipCanonicalProbeLogLine(result);
assert.match(logLine, new RegExp(`^${TOWNSHIP_CANONICAL_PROBE_LOG_PREFIX} `));
assert.match(logLine, new RegExp(`vector=${TOWNSHIP_CANONICAL_PROBE_VECTOR_ID}`));
assert.match(logLine, new RegExp(`digest=${expectedDigest}`));
assert.match(logLine, /mismatches=0/);

const calls: { command: string; args: Record<string, unknown> }[] = [];
const invoke: TauriInvoke = async <T = unknown>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> => {
  calls.push({ command, args });
  return null as T;
};

assert.equal(
  await maybeHandleTownshipCanonicalProbeDeepLink("township://probe/canonical?vector=township_carrier_w1", { invoke }),
  true,
);
assert.deepEqual(calls.map((call) => call.command), [TOWNSHIP_LOG_PROBE_COMMAND, TOWNSHIP_LOG_PROBE_COMMAND]);
assert.match(String(calls[0]?.args.event), /status=received/);
assert.equal(calls[1]?.args.event, logLine);

assert.equal(await maybeHandleTownshipCanonicalProbeDeepLink("township://pairing?handoff=abc", { invoke }), false);
assert.equal(calls.length, 2);

const directCalls: { command: string; args: Record<string, unknown> }[] = [];
const directInvoke: TauriInvoke = async <T = unknown>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> => {
  directCalls.push({ command, args });
  return null as T;
};

await logTownshipCanonicalProbe({ invoke: directInvoke });
assert.deepEqual(directCalls.map((call) => call.command), [TOWNSHIP_LOG_PROBE_COMMAND]);
assert.equal(directCalls[0]?.args.event, logLine);

let subscribed: ((urls: readonly string[]) => void) | null = null;
const listener = await createTownshipCanonicalProbeDeepLinkListener({
  source: {
    async current() {
      return ["township://probe/canonical?vector=township_carrier_w1"];
    },
    async onOpenUrl(callback) {
      subscribed = callback;
      return () => {
        subscribed = null;
      };
    },
  },
  invoke,
});

assert.equal(calls.length, 4);
assert.match(String(calls[2]?.args.event), /status=received/);
assert.equal(calls[3]?.args.event, logLine);
assert.ok(subscribed, "listener should subscribe to future probe links");
subscribed(["township://pairing?handoff=abc", "township://probe/canonical?vector=township_carrier_w1"]);
await delay(25);
assert.equal(calls.length, 4);
listener.stop();
assert.equal(subscribed, null);

const pollingCalls: { command: string; args: Record<string, unknown> }[] = [];
const pollingInvoke: TauriInvoke = async <T = unknown>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> => {
  pollingCalls.push({ command, args });
  return null as T;
};
let currentPolls = 0;
const pollingListener = await createTownshipCanonicalProbeDeepLinkListener({
  source: {
    async current() {
      currentPolls++;
      return currentPolls >= 2 ? ["township://probe/canonical?vector=township_carrier_w1"] : null;
    },
    async onOpenUrl() {
      throw new Error("deep-link events unavailable");
    },
  },
  invoke: pollingInvoke,
  pollIntervalMs: 10,
  pollDurationMs: 100,
});

await waitForCallCount(pollingCalls, 2);
assert.match(String(pollingCalls[0]?.args.event), /status=received/);
assert.equal(pollingCalls[1]?.args.event, logLine);
pollingListener.stop();

console.log("\x1b[32m✓ canonical probe contract checks passed\x1b[0m");

async function waitForCallCount(calls: readonly unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (calls.length >= count) return;
    await delay(10);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
