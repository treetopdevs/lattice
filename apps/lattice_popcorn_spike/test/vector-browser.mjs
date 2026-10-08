// Plan 185: run every signed Sim vector through the browser BEAM judge in Chromium.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compareVerdict } from "./vector-compare.mjs";

const here = new URL(".", import.meta.url);
const vectorDir = new URL("../../../clients/lattice-client/test/vectors/", here);
const port = Number(process.env.LATTICE_POPCORN_PREVIEW_PORT || 5179);
const origin = process.env.LATTICE_POPCORN_URL || `http://127.0.0.1:${port}`;
const evidence = { harness: "test/vector-browser.mjs", runtime: "chromium", passed: false,
  startedAt: new Date().toISOString(), vectors: [], skipped: [], consoleErrors: [] };
const reachable = async () => { try { return (await fetch(`${origin}/build.json`)).ok; } catch { return false; } };
let browser, preview;
try {
  if (!(await reachable())) {
    // Serve exactly dist/ with the research headers; the same server `npm run preview` runs.
    preview = spawn(process.execPath, [fileURLToPath(new URL("../scripts/preview.mjs", here))],
      { stdio: "ignore", env: { ...process.env, LATTICE_POPCORN_PREVIEW_PORT: String(port) } });
    for (let i = 0; i < 100 && !(await reachable()); i++) await new Promise(r => setTimeout(r, 100));
  }
  const build = await fetch(`${origin}/build.json`).then(r => r.json());
  evidence.build = { shared: build.shared, assets: build.assets.length };
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
  evidence.browserVersion = browser.version();
  const page = await browser.newPage();
  page.on("pageerror", error => evidence.consoleErrors.push(String(error)));
  const t0 = Date.now();
  await page.goto(`${origin}/judge.html`);
  evidence.boot = await page.evaluate(() => window.judge.ready());
  evidence.boot.navigationToReadyMs = Date.now() - t0;
  const files = (await readdir(vectorDir)).filter(f => f.endsWith(".json")).sort();
  for (const file of files) {
    const text = await readFile(new URL(file, vectorDir), "utf8");
    const vector = JSON.parse(text);
    const base = { file, scenario: vector.scenario, schema: vector.schema?.name,
      sha256: createHash("sha256").update(text).digest("hex") };
    if (!Array.isArray(vector.oracleCarrierOps)) {
      evidence.skipped.push({ ...base, reason: "no oracleCarrierOps: a TS-shaped `ops` vector with no signed frames for the BEAM judge to decode" });
      continue;
    }
    const started = Date.now();
    const result = await page.evaluate(([schema, frames, realms]) => window.judge.verdict(schema, frames, realms),
      [vector.schema.name, vector.oracleCarrierOps, vector.realmByPubkey ?? null]);
    const roundTripMs = Date.now() - started;
    if (evidence.vectors.length === 0) evidence.firstVerdictMs = Date.now() - t0;
    const comparison = compareVerdict(vector, result);
    evidence.vectors.push({ ...base, frames: vector.oracleCarrierOps.length, pass: comparison.pass,
      elapsed_us: result?.elapsed_us ?? null, phases_us: result?.phases_us ?? null, roundTripMs,
      structural: result?.structural ?? null, ...comparison });
    console.log(`${comparison.pass ? "PASS" : "FAIL"} ${file}${result?.ok ? "" : ` (${result?.error})`}`);
  }
  evidence.vm = await page.evaluate(() => window.judge.status());
  const failed = evidence.vectors.filter(v => !v.pass);
  evidence.summary = { loaded: evidence.vectors.length, passed: evidence.vectors.length - failed.length,
    failed: failed.length, skipped: evidence.skipped.length,
    failedScenarios: failed.map(v => v.scenario), skippedScenarios: evidence.skipped.map(v => v.scenario),
    structuralRejectOrQuarantine: evidence.vectors.filter(v => v.structural && (v.structural.rejected || v.structural.quarantined || v.structural.pending)).map(v => v.scenario) };
  evidence.passed = failed.length === 0 && evidence.consoleErrors.length === 0;
  console.log(`${evidence.summary.passed} passed, ${evidence.summary.failed} failed, ${evidence.summary.skipped} skipped`);
  console.log(`skipped: ${evidence.summary.skippedScenarios.join(", ")}`);
  if (failed.length) console.log(`failed: ${evidence.summary.failedScenarios.join(", ")}`);
} catch (error) { evidence.error = String(error?.stack ?? error); console.error(error); }
finally {
  evidence.finishedAt = new Date().toISOString();
  await mkdir(new URL("../evidence/", here), { recursive: true });
  await writeFile(new URL("../evidence/vectors.json", here), JSON.stringify(evidence, null, 2) + "\n");
  await browser?.close();
  preview?.kill();
  if (!evidence.passed) process.exitCode = 1;
}
