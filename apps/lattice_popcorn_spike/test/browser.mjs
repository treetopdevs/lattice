import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const origin = process.env.LATTICE_POPCORN_URL || "http://127.0.0.1:5179";
const gateway = `http://127.0.0.1:${process.env.LATTICE_POPCORN_PORT || 4059}`;
const evidence = { passed: false, checks: [] };
let browser;
try {
  const manifestResponse = await fetch(`${origin}/build.json`);
  if (!manifestResponse.ok) throw new Error("build manifest missing; run npm run build and npm run preview");
  const manifest = await manifestResponse.json();
  Object.assign(evidence, manifest);
  for (const asset of manifest.assets) {
    const response = await fetch(`${origin}/${asset.path}`);
    if (!response.ok) throw new Error(`missing built asset: ${asset.path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
  }
  evidence.checks.push("served assets match build manifest and compiled shared-source hashes");
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
  const page = await browser.newPage();
  evidence.consoleErrors = [];
  page.on("pageerror", error => evidence.consoleErrors.push(String(error)));
  const workers = [];
  page.on("worker", worker => workers.push(worker.url()));
  // Test instrumentation only: terminate the actual Popcorn Worker, without using deinit.
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__testWorkers = [];
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); window.__testWorkers.push(this); }
    };
  });
  const response = await page.goto(origin);
  evidence.headers = await response.allHeaders();
  expect(evidence.headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(evidence.headers["cross-origin-embedder-policy"]).toBe("require-corp");
  expect(evidence.headers["content-security-policy"]).toContain("'unsafe-eval'");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  const start = Date.now();
  await page.click("#connect");
  const events = () => page.locator("#events").textContent().then(text => JSON.parse(text || "[]"));
  const waitEvent = async (predicate, after = 0) => expect.poll(async () => (await events()).slice(after).some(predicate), { timeout: 90000 }).toBe(true);
  await waitEvent(e => e.type === "welcome");
  evidence.bootAndConnectMs = Date.now() - start;
  evidence.runtime = await page.evaluate(() => window.lattice.status());
  expect(evidence.runtime.otp).toBe("29");
  expect(evidence.runtime.distributed).toBe(false);
  expect(workers.length).toBeGreaterThan(0);
  evidence.workers = workers;
  evidence.checks.push("OTP realm in real Worker; non-distributed; identity generated");
  const state = () => fetch(`${gateway}/proof/state`).then(r => r.json());
  await page.evaluate(() => window.lattice.requestCapability());
  await waitEvent(e => e.type === "grant");
  const cap = (await events()).find(e => e.type === "grant").cap.id;
  const proof = await page.evaluate(cap => window.lattice.invoke(cap, "hello from OTP"), cap);
  await waitEvent(e => e.type === "call_result" && e.ok && e.result.signature_verified);
  expect(await state()).toMatchObject({ deliveries: 1, verified: 1 });
  evidence.signedEnvelope = proof.envelope;
  evidence.checks.push("native server recomputed canonical bytes, hash and Ed25519 signature after Gateway delivery");
  await page.evaluate(() => window.lattice.invoke("forged-cap", "denied"));
  await waitEvent(e => e.type === "call_result" && e.ok === false);
  await page.evaluate(() => window.lattice.invoke(null, "missing"));
  await waitEvent(e => e.type === "error");
  expect(await state()).toMatchObject({ deliveries: 1, verified: 1 });
  evidence.checks.push("forged and missing caps denied before target delivery");
  const lease = await fetch(`${gateway}/proof/lease?tab_id=${encodeURIComponent(evidence.runtime.tab_id)}`, { method: "POST" }).then(r => r.json());
  expect(typeof lease.cap_id).toBe("string");
  await new Promise(resolve => setTimeout(resolve, 50));
  const beforeExpiry = (await events()).length;
  await page.evaluate(cap => window.lattice.invoke(cap, "expired"), lease.cap_id);
  await waitEvent(e => e.type === "call_result" && !e.ok && e.error === "unauthorized", beforeExpiry);
  expect(await state()).toMatchObject({ deliveries: 1, verified: 1 });
  evidence.checks.push("expired cap denied before target delivery");
  // Exercise forbidden protocol vocabulary on the real server from a second socket.
  const refusals = await page.evaluate(async () => {
    const ws = new WebSocket(new URL("/ws", location.href.replace(/^http/, "ws")));
    await new Promise(resolve => ws.onopen = resolve);
    const results = [];
    for (const type of ["rpc", "spawn", "send", "registered_name", "setnode"]) {
      results.push(await new Promise(resolve => {
        ws.onmessage = e => resolve(JSON.parse(e.data));
        ws.send(JSON.stringify({ type, target: "kernel", pid: "<0.1.0>" }));
      }));
    }
    ws.close();
    return results;
  });
  expect(refusals.every(r => r.type === "error")).toBe(true);
  evidence.refusals = refusals;
  evidence.checks.push("distribution/RPC/spawn/raw-send vocabulary refused by real JSON boundary");
  await page.evaluate(() => window.__testWorkers.forEach(worker => worker.terminate()));
  await expect.poll(async () => {
    const s = await state();
    return s.tabs.find(tab => tab.id === evidence.runtime.tab_id)?.state;
  }, { timeout: 15000 }).toBe("disconnected");
  evidence.checks.push("hard Worker termination closes host WebSocket via heartbeat and cleans server tab");
  const graceful = await browser.newPage();
  await graceful.goto(origin);
  await graceful.click("#connect");
  await expect(graceful.locator("#grant")).toBeEnabled({ timeout: 90000 });
  const gracefulStatus = await graceful.evaluate(() => window.lattice.status());
  await graceful.evaluate(() => window.lattice.disconnect());
  await expect.poll(async () => (await state()).tabs.find(tab => tab.id === gracefulStatus.tab_id)?.state,
    { timeout: 15000 }).toBe("disconnected");
  evidence.checks.push("graceful browser disconnect cleans server tab");
  evidence.finalServerState = await state();
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  await mkdir(new URL("../evidence/", import.meta.url), { recursive: true });
  await writeFile(new URL("../evidence/browser.json", import.meta.url), JSON.stringify(evidence, null, 2));
  await browser?.close();
}
