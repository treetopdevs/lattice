#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { chromium, expect } from "@playwright/test";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.LATTICE_WORKER_E2E_PORT || (await freePort()));
const url = `http://localhost:${port}/`;
const outDir = `${root}/output/playwright`;
const outPath = `${outDir}/browser-worker-demo.json`;

const server = spawn("mix", ["lattice.demo", String(port)], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});

let browser;

try {
  await waitForHttp(`${url}worker.html`, 15_000);
  browser = await launchBrowser();

  const page = await browser.newPage();
  await page.goto(`${url}worker.html`);
  await installWorkerHarness(page);

  await expect
    .poll(() => page.evaluate(() => Object.keys(window.__workerTabs).length), { timeout: 5_000 })
    .toBe(2);

  await page.evaluate(() => {
    window.__workers["worker-a"].postMessage({
      type: "call",
      cap_id: "not-a-real-cap",
      payload: { op: "relay", body: "forged" },
    });
  });

  await expect
    .poll(() => page.evaluate(() => window.__workerEvents.some((event) => event.type === "call_result" && event.ok === false)), {
      timeout: 5_000,
    })
    .toBe(true);

  const demoResult = await page.evaluate(async () => {
    const response = await fetch("/api/federated-workers/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from_tab_id: window.__workerTabs["worker-a"],
        to_tab_id: window.__workerTabs["worker-b"],
      }),
    });

    return response.json();
  });

  expect(demoResult.denied_direct).toMatchObject({ ok: false, error: "bridge_required" });
  expect(demoResult.bridged).toMatchObject({
    ok: true,
    result: {
      realm: "browser_worker",
      worker: "worker-b",
      worker_b_received: "mediated",
    },
  });

  const relaysToWorkerB = await page.evaluate(() =>
    window.__workerEvents
      .filter((event) => event.workerName === "worker-b" && event.type === "tab_call" && event.payload?.op === "relay")
      .map((event) => event.payload.body),
  );

  expect(relaysToWorkerB).toEqual(["mediated"]);

  await mkdir(outDir, { recursive: true });
  await writeFile(
    outPath,
    JSON.stringify(
      {
        url,
        workerTabs: await page.evaluate(() => window.__workerTabs),
        demoResult,
        relaysToWorkerB,
      },
      null,
      2,
    ),
  );

  console.log(`Lattice browser Worker E2E passed at ${url}`);
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}

async function installWorkerHarness(page) {
  await page.evaluate(() => {
    window.__workerEvents = [];
    window.__workerTabs = {};
    window.__workers = {};

    for (const workerName of ["worker-a", "worker-b"]) {
      const worker = new Worker("/worker-client.js");
      window.__workers[workerName] = worker;

      worker.addEventListener("message", (event) => {
        const message = { workerName, ...event.data };
        window.__workerEvents.push(message);

        if (message.type === "welcome") {
          window.__workerTabs[workerName] = message.tab_id;
        }
      });

      worker.postMessage({
        type: "connect",
        name: workerName,
        client_id: `${workerName}-${Date.now()}`,
      });
    }
  });
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
