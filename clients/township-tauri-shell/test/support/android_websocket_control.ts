import { runAdb } from "./android_cdp";
import type { WebSocketProbeServer, WebSocketProbeServerStats } from "./websocket_probe_server";

export async function assertAndroidDeviceWebSocketEndpoint(serial: string, port: number, host = "127.0.0.1"): Promise<void> {
  const request = [
    "GET /carrier HTTP/1.1",
    `Host: ${host}:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dG93bnNoaXAtZGV2aWNl",
    "",
    "",
  ].join("\\n");
  await runAdb(serial, ["shell", `(printf '${request}'; sleep 1) | toybox nc ${host} ${port}`], 15_000);
}

export async function waitForProbeStats(
  probeServer: WebSocketProbeServer,
  expected: Partial<WebSocketProbeServerStats>,
  description: string,
): Promise<WebSocketProbeServerStats> {
  const deadline = Date.now() + 5_000;
  let lastStats = probeServer.stats();
  while (Date.now() < deadline) {
    lastStats = probeServer.stats();
    const matched = Object.entries(expected).every(([key, value]) => {
      if (value === undefined) return true;
      return lastStats[key as keyof WebSocketProbeServerStats] >= value;
    });
    if (matched) return lastStats;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}; expected ${JSON.stringify(expected)}, got ${JSON.stringify(lastStats)}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
