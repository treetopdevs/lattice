#!/usr/bin/env node
import { chromium, expect } from "@playwright/test";
import { freePort, startServer } from "../tests/e2e/support/lattice-server.mjs";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.LATTICE_E2E_PORT || (await freePort()));

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

const server = await startServer({
  root,
  command: "mix",
  args: ["run", "--no-halt", "-e", serverExpr],
  port,
});
const url = server.url;

let browser;

try {
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
  await server.stop();
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
