#!/usr/bin/env node
import { chromium, expect } from "@playwright/test";
import { freePort, startServer } from "../tests/e2e/support/lattice-server.mjs";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.LATTICE_E2E_PORT || (await freePort()));

const server = await startServer({
  root,
  command: "mix",
  args: ["lattice.demo", String(port)],
  port,
});
const url = server.url;

let browser;

try {
  browser = await launchBrowser();

  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await pageA.goto(url);
  await pageB.goto(url);

  await expect(pageA.getByText("2 tabs")).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText("2 tabs")).toBeVisible({ timeout: 5_000 });
  await expect(pageA.getByText("server opened mediated path")).toBeVisible({ timeout: 5_000 });

  await pageA.getByRole("button", { name: "grant A -> Echo" }).click();
  await expect(pageA.getByRole("button", { name: "A holds Echo cap" })).toBeVisible({
    timeout: 5_000,
  });

  await pageA.getByRole("button", { name: "call Echo as A" }).click();
  await expect(pageA.getByText("A this tab called EchoServer")).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText("A peer tab called EchoServer")).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText("B this tab called EchoServer")).toHaveCount(0);

  await pageA.getByRole("button", { name: "fake cap as A" }).click();
  await expect(pageA.getByText("A this tab denied")).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText("A peer tab denied")).toBeVisible({ timeout: 5_000 });

  console.log(`Lattice browser E2E passed at ${url}`);
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
