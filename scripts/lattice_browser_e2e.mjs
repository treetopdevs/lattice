#!/usr/bin/env node
import { spawn } from "node:child_process";
import net from "node:net";
import { chromium, expect } from "@playwright/test";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.LATTICE_E2E_PORT || (await freePort()));
const url = `http://localhost:${port}/`;

const server = spawn("mix", ["lattice.demo", String(port)], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});

let browser;

try {
  await waitForHttp(url, 15_000);
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
