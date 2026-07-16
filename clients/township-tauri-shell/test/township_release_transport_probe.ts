import assert from "node:assert/strict";
import {
  TOWNSHIP_RELEASE_TRANSPORT_PROBE_LOG_PREFIX,
  logTownshipReleaseTransportProbesFromEnv,
  logTownshipReleaseTransportProbeFromEnv,
  logTownshipReleaseTransportProbe,
  probeTownshipReleaseTransport,
  townshipReleaseTransportProbeHostClass,
  townshipReleaseTransportProbeLogLine,
  townshipReleaseTransportProbeUrlFromEnv,
  townshipReleaseTransportProbeUrlsFromEnv,
} from "../src/township_release_transport_probe";

console.log("\n▸ Township release transport probe contract");

const loopbackUrl = "ws://127.0.0.1:43185/carrier";
const androidHostUrl = "ws://10.0.2.2:43185/carrier";

interface ProbeWebSocket {
  onopen: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
  send(data: string): void;
}

class OpeningWebSocket implements ProbeWebSocket {
  onopen: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    queueMicrotask(() => this.onopen?.());
  }

  close(): void {}

  send(data: string): void {
    this.sent.push(data);
    queueMicrotask(() => this.onmessage?.({ data }));
  }
}

class FailingWebSocket implements ProbeWebSocket {
  onopen: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    queueMicrotask(() => this.onerror?.({ type: "error" }));
  }

  close(): void {}

  send(_data: string): void {}
}

class RoutedWebSocket implements ProbeWebSocket {
  onopen: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    if (url.includes("10.0.2.2")) {
      queueMicrotask(() => this.onerror?.({ type: "error" }));
    } else {
      queueMicrotask(() => this.onopen?.());
    }
  }

  close(): void {}

  send(data: string): void {
    this.sent.push(data);
    queueMicrotask(() => this.onmessage?.({ data }));
  }
}

class UnexpectedWebSocket implements ProbeWebSocket {
  onopen: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    throw new Error(`unexpected probe socket for ${url}`);
  }

  close(): void {}

  send(_data: string): void {}
}

assert.equal(townshipReleaseTransportProbeUrlFromEnv({}), null);
assert.equal(
  townshipReleaseTransportProbeUrlFromEnv({
    VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URL: ` ${loopbackUrl} `,
  }),
  loopbackUrl,
);
assert.equal(
  townshipReleaseTransportProbeUrlFromEnv({
    VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URL: "https://carrier.example",
  }),
  null,
);
assert.deepEqual(townshipReleaseTransportProbeUrlsFromEnv({}), []);
assert.deepEqual(
  townshipReleaseTransportProbeUrlsFromEnv({
    VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URLS: ` ${loopbackUrl} , ${androidHostUrl} , https://carrier.example `,
  }),
  [loopbackUrl, androidHostUrl],
);

assert.equal(townshipReleaseTransportProbeHostClass("ws://127.0.0.1:43185/carrier"), "loopback");
assert.equal(townshipReleaseTransportProbeHostClass("ws://[::1]:43185/carrier"), "loopback");
assert.equal(townshipReleaseTransportProbeHostClass("ws://10.0.2.2:43185/carrier"), "android_host");
assert.equal(townshipReleaseTransportProbeHostClass("wss://carrier.example/township"), "remote");

const disabledLogs: string[] = [];
const didProbe = await logTownshipReleaseTransportProbeFromEnv(
  {},
  {
    webSocket: UnexpectedWebSocket,
    invoke(command, args) {
      disabledLogs.push(`${command}:${String(args.event)}`);
      return Promise.resolve();
    },
  },
);
assert.equal(didProbe, false);
assert.deepEqual(disabledLogs, []);

const connected = await probeTownshipReleaseTransport({
  url: loopbackUrl,
  timeoutMs: 1_000,
  webSocket: OpeningWebSocket,
});
assert.equal(connected.outcome, "connected");
assert.equal(connected.surface, "webview-websocket");
assert.equal(connected.urlScheme, "ws");
assert.equal(connected.hostClass, "loopback");
assert.equal(connected.message, "frame roundtrip");
assert.match(townshipReleaseTransportProbeLogLine(connected), /^township-release-transport-probe /);
assert.match(townshipReleaseTransportProbeLogLine(connected), / outcome=connected(?:\s|$)/);
assert.match(townshipReleaseTransportProbeLogLine(connected), /message=frame_roundtrip/);
assert.doesNotMatch(townshipReleaseTransportProbeLogLine(connected), /10\.0\.2\.2|stateReport|Sync outbox/);

const failed = await probeTownshipReleaseTransport({
  url: "ws://127.0.0.1:43186/carrier",
  timeoutMs: 1_000,
  webSocket: FailingWebSocket,
});
assert.equal(failed.outcome, "error");
assert.match(failed.message ?? "", /transport error/);
assert.match(townshipReleaseTransportProbeLogLine(failed), / outcome=error(?:\s|$)/);
assert.match(townshipReleaseTransportProbeLogLine(failed), /message=transport_error/);

const logs: string[] = [];
await logTownshipReleaseTransportProbe({
  url: loopbackUrl,
  timeoutMs: 1_000,
  webSocket: OpeningWebSocket,
  invoke(command, args) {
    assert.equal(command, "lattice_log_probe");
    logs.push(String(args.event));
    return Promise.resolve();
  },
});
assert.equal(logs.length, 1);
assert.match(logs[0], new RegExp(`^${TOWNSHIP_RELEASE_TRANSPORT_PROBE_LOG_PREFIX} `));
assert.match(logs[0], /outcome=connected/);

const multiLogs: string[] = [];
const multiResults = await logTownshipReleaseTransportProbesFromEnv(
  { VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URLS: `${loopbackUrl},${androidHostUrl}` },
  {
    timeoutMs: 1_000,
    webSocket: RoutedWebSocket,
    invoke(command, args) {
      assert.equal(command, "lattice_log_probe");
      multiLogs.push(String(args.event));
      return Promise.resolve();
    },
  },
);
assert.equal(multiResults.length, 2);
assert.equal(multiResults[0]?.hostClass, "loopback");
assert.equal(multiResults[0]?.outcome, "connected");
assert.equal(multiResults[1]?.hostClass, "android_host");
assert.equal(multiResults[1]?.outcome, "error");
assert.equal(multiLogs.length, 2);
assert.match(multiLogs[0] ?? "", /host_class=loopback/);
assert.match(multiLogs[0] ?? "", /outcome=connected/);
assert.match(multiLogs[1] ?? "", /host_class=android_host/);
assert.match(multiLogs[1] ?? "", /outcome=error/);

console.log("\x1b[32m✓ release transport probe contract checks passed\x1b[0m");
