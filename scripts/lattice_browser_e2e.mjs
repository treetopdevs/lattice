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

  const actor = await tabLabel(pageA);
  const peer = actor === "A" ? "B" : "A";

  await pageA.getByRole("button", { name: `grant ${actor} -> Echo` }).click();
  await expect(pageA.getByRole("button", { name: `${actor} holds Echo cap` })).toBeVisible({
    timeout: 5_000,
  });

  await pageA.getByRole("button", { name: `call Echo as ${actor}` }).click();
  await expect(pageA.getByText(`${actor} this tab called EchoServer`)).toBeVisible({
    timeout: 5_000,
  });
  await expect(pageB.getByText(`${actor} peer tab called EchoServer`)).toBeVisible({
    timeout: 5_000,
  });
  await expect(pageB.getByText(`${peer} this tab called EchoServer`)).toHaveCount(0);

  await pageA.getByRole("button", { name: `fake cap as ${actor}` }).click();
  await expect(pageA.getByText(`${actor} this tab denied`)).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText(`${actor} peer tab denied`)).toBeVisible({ timeout: 5_000 });

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

async function tabLabel(page) {
  const grant = page.getByRole("button", { name: /grant [AB] -> Echo/ });
  await expect(grant).toBeVisible({ timeout: 5_000 });

  const label = (await grant.textContent())?.match(/^grant ([AB]) -> Echo$/)?.[1];
  if (!label) throw new Error("Could not read browser tab label from grant button");

  return label;
}
