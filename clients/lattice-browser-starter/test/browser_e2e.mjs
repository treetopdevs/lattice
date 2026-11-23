import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(path.join(REPO_ROOT, "package.json"));
const { chromium } = require("@playwright/test");

const TEST_DEMO_DIR = path.join(REPO_ROOT, "output/demo_ecosystem/browser_e2e_run");
const BASE_PORT = 4260;
const LIVEVIEW_PORT = 4126;
const WEB_PORT = 5186;

function spawnLines(cmd, args, env = process.env) {
  const child = spawn(cmd, args, {
    cwd: REPO_ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  const lines = [];
  const waiters = [];

  const handleChunk = (chunk) => {
    buffer += chunk.toString("utf8");
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      lines.push(line);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (line.includes(waiters[i].prefix)) {
          const w = waiters.splice(i, 1)[0];
          w.resolve(line);
        }
      }
    }
  };

  child.stdout?.on("data", handleChunk);
  child.stderr?.on("data", handleChunk);

  const waitFor = (prefix, timeoutMs = 60_000) => {
    const existing = lines.find((l) => l.includes(prefix));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for "${prefix}". Last lines:\n${lines.slice(-20).join("\n")}`));
      }, timeoutMs);
      waiters.push({
        prefix,
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      });
    });
  };

  return { child, waitFor };
}

const relayProc = spawnLines("scripts/demo_ecosystem_relay.sh", [
  "--reset",
  "--dir",
  TEST_DEMO_DIR,
  "--base-port",
  String(BASE_PORT),
]);
let liveViewProc = null;
let webProc = null;
let browser = null;

try {
  await relayProc.waitFor("PILOT_READY", 60_000);

  liveViewProc = spawnLines("scripts/demo_ecosystem_township_live.sh", [
    String(LIVEVIEW_PORT),
    TEST_DEMO_DIR,
  ]);
  await liveViewProc.waitFor("TOWNSHIP_DEMO_LIVE_READY", 60_000);

  webProc = spawnLines(
    "npm",
    ["--prefix", "clients/lattice-browser-starter", "run", "dev", "--", "--port", String(WEB_PORT), "--strictPort"],
    { ...process.env, DEMO_ECOSYSTEM_DIR: TEST_DEMO_DIR },
  );
  await webProc.waitFor(`http://127.0.0.1:${WEB_PORT}`, 30_000);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  const founderPage = await context.newPage();
  const neighborPage = await context.newPage();
  const liveViewPage = await context.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  for (const [label, page] of [
    ["founder", founderPage],
    ["neighbor", neighborPage],
    ["liveview", liveViewPage],
  ]) {
    page.on("pageerror", (err) => pageErrors.push(`${label}: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        consoleErrors.push(`${label}[${msg.type()}]: ${msg.text()}`);
      }
    });
  }

  await founderPage.goto(`http://127.0.0.1:${WEB_PORT}/?role=founder`, { waitUntil: "networkidle" });
  await neighborPage.goto(`http://127.0.0.1:${WEB_PORT}/?role=neighbor`, { waitUntil: "networkidle" });
  await liveViewPage.goto(`http://localhost:${LIVEVIEW_PORT}/township`, { waitUntil: "networkidle" });

  // Wait for both browser tabs to connect and pull initial Treehouse thread post
  await founderPage.getByText("Welcome to the unified Lattice demo relay!").waitFor({ timeout: 20_000 });
  await neighborPage.getByText("Welcome to the unified Lattice demo relay!").waitFor({ timeout: 20_000 });

  // Confirm Phoenix LiveView connected over LiveView WebSocket and rendered our seeded relay matter
  await liveViewPage.getByText("Maple Creek Footbridge Repair").first().waitFor({ timeout: 20_000 });
  await liveViewPage.getByText("Timber deck keeps maintenance local and within budget.").first().waitFor({ timeout: 20_000 });

  // 1. Treehouse: Neighbor goes offline, posts, comes back online -> Founder converges live!
  await neighborPage.getByTestId("online-toggle").click();
  await neighborPage.getByText("Offline (Local Outbox)").waitFor({ timeout: 10_000 });

  const offlineMsg = "Playwright offline Treehouse message!";
  await neighborPage.getByTestId("treehouse-post-input").fill(offlineMsg);
  await neighborPage.getByTestId("treehouse-post-submit").click();
  await neighborPage.getByText(offlineMsg).first().waitFor({ timeout: 10_000 });
  await neighborPage.getByText("outbox pending: 1").waitFor({ timeout: 10_000 });

  await neighborPage.getByTestId("online-toggle").click();
  try {
    await founderPage.getByText(offlineMsg).first().waitFor({ timeout: 15_000 });
  } catch (err) {
    const fBar = await founderPage.getByTestId("route-status-bar").textContent().catch(() => "");
    const nBar = await neighborPage.getByTestId("route-status-bar").textContent().catch(() => "");
    const fErr = await founderPage.getByTestId("boot-error").textContent().catch(() => "");
    const nErr = await neighborPage.getByTestId("boot-error").textContent().catch(() => "");
    console.error("DIAG founder routes:", fBar, "bootErr:", fErr);
    console.error("DIAG neighbor routes:", nBar, "bootErr:", nErr);
    console.error("DIAG pageErrors:", pageErrors, "consoleErrors:", consoleErrors);
    throw err;
  }

  // 2. Township: Neighbor posts in browser starter -> Phoenix LiveView DOM updates live!
  await neighborPage.getByTestId("tab-township").click();
  const civicMsg = "Playwright browser post pushed live into Phoenix LiveView!";
  await neighborPage.getByTestId("township-post-input").fill(civicMsg);
  await neighborPage.getByTestId("township-post-submit").click();
  await liveViewPage.getByText(civicMsg).first().waitFor({ timeout: 20_000 });

  // 3. Toolshed: Neighbor requests borrow & signs ADR 0007 consent; Founder tests unconsented quarantine + completes handoff!
  await neighborPage.getByTestId("tab-toolshed").click();
  await founderPage.getByTestId("tab-toolshed").click();

  await neighborPage.getByTestId("toolshed-request-borrow-btn").click();
  await neighborPage.getByTestId("toolshed-sign-consent-btn").waitFor({ timeout: 15_000 });
  await neighborPage.getByTestId("toolshed-sign-consent-btn").click();
  const consentSig = (await neighborPage.getByTestId("toolshed-consent-sig").textContent())?.trim();
  assert.ok(consentSig && consentSig.length > 40, "expected signed base64 ADR 0007 consent");

  // Founder observes borrow request, tries unconsented transfer -> sees quarantine, then completes dual-signed handoff
  await founderPage.getByTestId("toolshed-unconsented-btn").waitFor({ timeout: 15_000 });
  await founderPage.getByTestId("toolshed-unconsented-btn").click();
  await founderPage.getByText("quarantined: 1").first().waitFor({ timeout: 15_000 });

  await founderPage.getByTestId("toolshed-consent-input").fill(consentSig);
  await founderPage.getByTestId("toolshed-complete-handoff-btn").click();

  await founderPage.getByText("Checked Out").waitFor({ timeout: 15_000 });
  await neighborPage.getByText("Checked Out").waitFor({ timeout: 15_000 });
  await neighborPage.getByText("borrower: demo-neighbor").waitFor({ timeout: 15_000 });

  assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join("; ")}`);
  console.log("PASS: browser_e2e green across Founder tab + Neighbor tab + live Phoenix LiveView!");
} finally {
  if (browser) await browser.close();
  webProc?.child.kill("SIGTERM");
  liveViewProc?.child.kill("SIGTERM");
  relayProc.child.stdin?.end();
  relayProc.child.kill("SIGTERM");
  fs.rmSync(TEST_DEMO_DIR, { recursive: true, force: true });
}
