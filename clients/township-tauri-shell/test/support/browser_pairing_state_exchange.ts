import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX } from "../../src/township_release_pairing_probe";
import { runAdb } from "./android_cdp";

export interface BrowserPageObservation {
  path: string;
  observedAtMs: number;
}

export interface BrowserPairingPageServerLike {
  waitForPath(path: string, afterMs: number): Promise<BrowserPageObservation>;
}

export interface PairingStateExchangeServer {
  port: number;
  server: Server;
  waitForState(): Promise<string>;
}

export async function startPairingStateExchangeServer(exchangeUrl: string): Promise<PairingStateExchangeServer> {
  const parsed = new URL(exchangeUrl);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.pathname, "/pairing-state");
  const port = Number(parsed.port);
  assert.ok(Number.isInteger(port) && port > 0, `state exchange URL must include a TCP port: ${exchangeUrl}`);
  let observedState: string | null = null;

  const server = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "POST, OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type");
    response.setHeader("cache-control", "no-store");

    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    if (request.method !== "POST" || request.url?.split("?")[0] !== "/pairing-state") {
      response.writeHead(404).end("missing state exchange route");
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 256) request.destroy(new Error("state exchange body too large"));
    });
    request.on("end", () => {
      const state = body.trim();
      if (!/^[0-9a-f]{32}$/.test(state)) {
        response.writeHead(400).end("invalid state");
        return;
      }
      observedState = state;
      response.writeHead(204).end();
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  return {
    port,
    server,
    async waitForState(): Promise<string> {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (observedState) return observedState;
        await delay(250);
      }
      throw new Error("timed out waiting for app-minted browser pairing state exchange");
    },
  };
}

export async function openBrowserPairingPageAndTapUntilBlocked(
  serial: string,
  browserPackage: string,
  pageServer: BrowserPairingPageServerLike,
  pageBaseUrl: string,
  path: "/no-state" | "/wrong-state",
  waitForBlockedLine: () => Promise<string>,
  runtimeArmState?: string,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await openBrowserPairingPageAndTapOnce(serial, browserPackage, pageServer, pageBaseUrl, path);
      const blockedLine = await waitForBlockedLine();
      if (runtimeArmState !== undefined) {
        assert.doesNotMatch(blockedLine, new RegExp(escapeRegExp(runtimeArmState)));
      }
      return blockedLine;
    } catch (error) {
      lastError = error;
      await tapFirstVisibleText(serial, ["Close app", "Wait"]);
      await delay(750);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function assertNoPairingSavedYet(serial: string): Promise<void> {
  const output = await runAdb(serial, ["logcat", "-d", "-s", "LATTICE_PROBE"], 10_000);
  const savedLine = output
    .split(/\r?\n/)
    .find(
      (candidate) =>
        candidate.includes(TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX) &&
        candidate.includes("phase=pairing") &&
        candidate.includes("outcome=saved"),
    );
  assert.equal(savedLine, undefined, `no-state browser pairing link should not save peer config before runtime state:\n${savedLine ?? output}`);
}

export async function assertLogcatDoesNotContain(serial: string, value: string, message: string): Promise<void> {
  const output = await runAdb(serial, ["logcat", "-d", "-s", "LATTICE_PROBE"], 10_000);
  assert.doesNotMatch(output, new RegExp(escapeRegExp(value)), message);
}

async function openBrowserPairingPageAndTapOnce(
  serial: string,
  browserPackage: string,
  pageServer: BrowserPairingPageServerLike,
  pageBaseUrl: string,
  path: "/no-state" | "/wrong-state",
): Promise<void> {
  const pageUrl = `${pageBaseUrl}${path}`;
  for (let pageAttempt = 0; pageAttempt < 3; pageAttempt += 1) {
    await tapFirstVisibleText(serial, ["Close app"]);
    await runAdb(serial, ["shell", "am", "force-stop", browserPackage], 30_000).catch(() => undefined);
    const startRequestedAtMs = Date.now();
    const startOutput = await runAdb(
      serial,
      [
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-c",
        "android.intent.category.BROWSABLE",
        "-d",
        pageUrl,
        "-p",
        browserPackage,
      ],
      30_000,
    );
    console.log(`  opened browser pairing page ${pageUrl} with ${browserPackage}${startOutput.trim() ? ` (${startOutput.trim()})` : ""}`);
    await settleBrowserFirstRun(serial);
    try {
      await pageServer.waitForPath(path, startRequestedAtMs);
    } catch (error) {
      await settleBrowserFirstRun(serial);
      if (pageAttempt < 2) continue;
      throw error;
    }
    await delay(1_500);
    if (await tapFirstVisibleText(serial, ["Close app"])) {
      await delay(500);
      continue;
    }
    await tapFirstVisibleText(serial, ["Wait"]);
    await delay(300);
    await tapBrowserPairingLink(serial);
    return;
  }
  throw new Error(`browser pairing page ${path} could not be opened without Chrome crash UI`);
}

async function settleBrowserFirstRun(serial: string): Promise<void> {
  await tapFirstVisibleText(serial, ["Use without an account", "Accept & continue"]);
  await delay(1_000);
  await tapFirstVisibleText(serial, ["No thanks"]);
  await delay(500);
}

async function tapBrowserPairingLink(serial: string): Promise<void> {
  const { width, height } = await screenSize(serial);
  await runAdb(serial, ["shell", "input", "tap", String(Math.floor(width / 2)), String(Math.floor(height / 2))], 10_000);
}

async function tapFirstVisibleText(serial: string, labels: string[]): Promise<boolean> {
  const xml = await windowHierarchyXml(serial).catch(() => "");
  if (!xml) return false;
  for (const label of labels) {
    const bounds = boundsForVisibleText(xml, label);
    if (!bounds) continue;
    await runAdb(serial, ["shell", "input", "tap", String(bounds.x), String(bounds.y)], 10_000);
    return true;
  }
  return false;
}

async function windowHierarchyXml(serial: string): Promise<string> {
  await runAdb(serial, ["shell", "uiautomator", "dump", "/sdcard/township-window.xml"], 10_000);
  return runAdb(serial, ["shell", "cat", "/sdcard/township-window.xml"], 10_000);
}

function boundsForVisibleText(xml: string, label: string): { x: number; y: number } | null {
  const escaped = escapeRegExp(escapeXmlAttribute(label));
  const pattern = new RegExp(`<(?:node)\\b[^>]*text="${escaped}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`);
  const match = pattern.exec(xml);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return null;
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  return { x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2) };
}

function screenSize(serial: string): Promise<{ width: number; height: number }> {
  return runAdb(serial, ["shell", "wm", "size"], 10_000).then((output) => {
    const match = /Physical size:\s*(\d+)x(\d+)/.exec(output);
    assert.ok(match?.[1] && match[2], `expected wm size output to include physical dimensions:\n${output}`);
    return { width: Number(match[1]), height: Number(match[2]) };
  });
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
