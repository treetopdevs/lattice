#!/usr/bin/env node
import { spawn } from "node:child_process";
import net from "node:net";
import { chromium, expect } from "@playwright/test";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.LATTICE_E2E_PORT || (await freePort()));
const url = `http://localhost:${port}/`;

const serverExpr = `
Lattice.reset!()
LatticeServer.DemoHub.reset()
{:ok, _pid} =
  LatticeServer.start_http(
    port: ${port},
    auto_story?: false,
    grant_targets: %{"echo" => Lattice.Demo.EchoServer, {"echo", :ops} => ["call", "cast"]}
  )
`;

const server = spawn("mix", ["run", "--no-halt", "-e", serverExpr], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});

let browser;

try {
  await waitForHttp(url, 15_000);
  browser = await launchBrowser();

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await pageA.goto(url);
  await pageB.goto(url);

  await expect(pageA.getByText("2 tabs")).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText("2 tabs")).toBeVisible({ timeout: 5_000 });
  await expect(pageA.locator("#ledgerList .event-deny")).toHaveCount(0);

  await pageA.evaluate(() => {
    reconnectDelay = 1500;
    ws.close();
  });

  await expect(pageA.locator("#connectionState")).toHaveText("offline", { timeout: 5_000 });

  await pageB.getByRole("button", { name: /fake cap as/ }).click();
  await expect(pageB.locator("#ledgerList .event-deny")).toHaveCount(1, { timeout: 5_000 });

  await expect(pageA.locator("#connectionState")).not.toHaveText("offline", { timeout: 10_000 });
  await expect(pageA.locator("#ledgerList .event-deny")).toHaveCount(1, { timeout: 10_000 });

  console.log(`Lattice browser resume E2E passed at ${url}`);
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}

async function launchBrowser() {
  const channel = process.env.PLAYWRIGHT_CHANNEL || "chrome";

  try {
    return await chromium.launch({ channel, headless: true });
  } catch (error) {
    if (process.env.PLAYWRIGHT_CHANNEL) throw error;
    return chromium.launch({ headless: true });
  }
}

async function waitForHttp(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(target);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }

    await delay(100);
  }

  throw new Error(`Timed out waiting for ${target}: ${lastError?.message || "no response"}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
