import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
const origin = process.env.LATTICE_POPCORN_URL || "http://127.0.0.1:5179";
const gateway = `http://127.0.0.1:${process.env.LATTICE_POPCORN_PORT || 4059}`;
const evidence = { passed: false, checks: [], consoleErrors: [] };
let browser;
try {
  evidence.build = await fetch(`${origin}/build.json`).then(r => r.json());
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
  // Separate contexts model distinct devices: independent storage and Workers.
  const ac = await browser.newContext(), bc = await browser.newContext();
  const a = await ac.newPage(), b = await bc.newPage();
  const ready = async page => {
    await page.waitForFunction(() => Boolean(window.replica), null, { timeout: 90000 });
  };
  const status = page => page.evaluate(() => window.replica.status());
  for (const page of [a, b]) {
    page.on("pageerror", error => evidence.consoleErrors.push(String(error)));
    await page.addInitScript(() => {
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        addEventListener(type, callback, options) {
          if (type !== "message") return super.addEventListener(type, callback, options);
          return super.addEventListener(type, event => {
            const frame = JSON.parse(event.data);
            if (window.__reorderNext && frame.type === "call_result" && frame.result?.log) {
              const ops = frame.result.log.ops;
              frame.result.log.ops = [...ops].reverse().concat(ops);
              window.__reorderNext = false;
              window.__reordered = true;
              callback(new MessageEvent("message", { data: JSON.stringify(frame) }));
            } else callback(event);
          }, options);
        }
      };
      const Worker = window.Worker;
      window.__workers = [];
      window.Worker = class extends Worker {
        constructor(...args) { super(...args); window.__workers.push(this); }
      };
    });
  }
  await a.goto(`${origin}/replica.html?replica=alice`); await ready(a);
  await b.goto(`${origin}/replica.html?replica=bob`); await ready(b);
  evidence.aliceKey = (await status(a)).public_key;
  evidence.bobKey = (await status(b)).public_key;
  expect(evidence.aliceKey).not.toBe(evidence.bobKey);
  await a.evaluate(() => window.replica.connect());
  await b.evaluate(() => window.replica.connect());
  await a.evaluate(() => window.replica.sync());
  for (const page of [a, b]) await page.evaluate(() => window.replica.offline());
  await a.evaluate(() => window.replica.post("Alice offline"));
  await b.evaluate(() => window.replica.post("Bob offline"));
  const beforeReload = await status(a);
  await a.reload(); await ready(a);
  expect((await status(a)).public_key).toBe(evidence.aliceKey);
  expect((await status(a)).op_ids).toEqual(beforeReload.op_ids);
  expect((await status(a)).notes).toContain("Alice offline");
  evidence.checks.push("independent BEAM identities; offline signed write and identity survive page reload via IndexedDB");
  await a.evaluate(() => window.replica.connect());
  await b.evaluate(() => window.replica.connect());
  await a.evaluate(() => window.replica.sync());
  await a.evaluate(() => { window.__reorderNext = true; });
  await a.evaluate(() => window.replica.sync());
  expect(await a.evaluate(() => window.__reordered)).toBe(true);
  evidence.checks.push("reversed and duplicated incoming signed ops revalidated in browser BEAM");
  const converged = await status(a);
  expect(converged.notes).toEqual((await status(b)).notes);
  expect(converged.op_ids).toEqual((await status(b)).op_ids);
  expect([...converged.notes].sort()).toEqual(["Alice offline", "Bob offline"]);
  expect((await a.evaluate(() => window.replica.sync())).accepted).toEqual([]);
  evidence.checks.push("two real browser OTP replicas converge through Gateway; duplicate sync is idempotent");
  // Storage ownership: a second tab using the same record cannot start a writer.
  const duplicate = await ac.newPage();
  await duplicate.goto(`${origin}/replica.html?replica=alice`);
  await expect(duplicate.locator("#error")).toContainText("another tab");
  await duplicate.close();
  evidence.checks.push("same-record concurrent writer prevented by Web Lock");
  await a.evaluate(() => window.replica.offline());
  const stale = await a.evaluate(() => window.replica.post("Revoked offline write"));
  const revoke = await fetch(`${gateway}/proof/revoke?public_key=${encodeURIComponent(evidence.aliceKey)}`, { method: "POST" }).then(r => r.json());
  expect(revoke.error).toBeUndefined();
  const rejected = await a.evaluate(() => window.replica.connect());
  expect(rejected.accepted).not.toContain(stale.op_id);
  expect(rejected.rejected[stale.op_id]).toBe("revoked_capability");
  expect(rejected.notes).not.toContain("Revoked offline write");
  const refusal = await a.evaluate(async () => {
    try { await window.replica.post("After known revoke"); return "unexpected_success"; }
    catch (error) { return error.message; }
  });
  expect(refusal).toBe("revoked_capability");
  await b.evaluate(() => window.replica.sync());
  expect((await status(a)).notes).toEqual((await status(b)).notes);
  expect((await status(a)).op_ids).toEqual((await status(b)).op_ids);
  evidence.checks.push("offline concurrent revoked op quarantined on both replicas, absent from accepted state; observed revoke refuses a new local write");
  await a.reload(); await ready(a);
  expect((await status(a)).rejected[stale.op_id]).toBe("revoked_capability");
  expect((await status(a)).public_key).toBe(evidence.aliceKey);
  evidence.checks.push("revocation verdict recomputed from persisted signed log after reload");
  // Hard VM termination cannot lose the last committed local write.
  await b.evaluate(() => window.replica.post("Bob survives Worker crash"));
  const saved = await status(b);
  await b.evaluate(() => window.__workers.forEach(w => w.terminate()));
  await b.reload(); await ready(b);
  expect((await status(b)).op_ids).toEqual(saved.op_ids);
  expect((await status(b)).public_key).toBe(evidence.bobKey);
  await b.evaluate(() => window.replica.connect());
  await a.evaluate(() => window.replica.connect());
  evidence.finalAlice = await status(a); evidence.finalBob = await status(b);
  expect(evidence.finalAlice.notes).toEqual(evidence.finalBob.notes);
  expect(evidence.finalAlice.op_ids).toEqual(evidence.finalBob.op_ids);
  const server = await fetch(`${gateway}/proof/replica`).then(r => r.json());
  expect(server.view.notes).toEqual(evidence.finalAlice.notes);
  expect(server.view.op_ids).toEqual(evidence.finalAlice.op_ids);
  evidence.checks.push("hard Worker termination and reload retain committed identity/log; both replicas equal native server state");
  expect(evidence.consoleErrors).toEqual([]);
  evidence.passed = true;
} catch (error) { evidence.error = String(error); throw error; }
finally {
  await mkdir(new URL("../evidence/", import.meta.url), { recursive: true });
  await writeFile(new URL("../evidence/replicas.json", import.meta.url), JSON.stringify(evidence, null, 2));
  await browser?.close();
}
