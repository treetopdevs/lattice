// Plan 185 steps 4-5: launch the packaged Treehouse judge-spike app cold, serve it the vectors and
// the synthetic log over loopback, collect its in-app verdicts, and sample process RSS.
// The app cannot write files itself (no native command is added), so this collector writes the
// per-launch trace into the variant's own app data directory and the summary into evidence/.
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = new URL(".", import.meta.url);
const vectorDir = fileURLToPath(new URL("../../../clients/lattice-client/test/vectors/", here));
const app = process.env.LATTICE_JUDGE_APP || fileURLToPath(new URL(
  "../../../clients/treehouse-tauri-shell/src-tauri/target/release/bundle/macos/Treehouse Judge Spike.app", here));
const synthetic = process.env.LATTICE_JUDGE_SYNTHETIC;
const launches = Number(process.env.LATTICE_JUDGE_LAUNCHES || 3);
const syntheticLaunches = Number(process.env.LATTICE_JUDGE_SYNTHETIC_LAUNCHES || launches);
const launchTimeoutMs = Number(process.env.LATTICE_JUDGE_LAUNCH_TIMEOUT_MS || 1800000);
const bundleId = "dev.treetop.lattice.treehouse.judgespike";
const dataDir = `${homedir()}/Library/Application Support/${bundleId}`;
const executable = `${app}/Contents/MacOS/`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let current = null; // the launch being served
const cors = { "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin", "Cache-Control": "no-store" };
const files = (await readdir(vectorDir)).filter(f => f.endsWith(".json")).sort();
const syntheticText = synthetic ? await readFile(synthetic, "utf8") : null;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "content-type" }).end(); return; }
    if (req.method === "GET" && url.pathname === "/vectors") { res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify(files)); return; }
    if (req.method === "GET" && url.pathname.startsWith("/vector/")) {
      const file = decodeURIComponent(url.pathname.slice("/vector/".length));
      if (!files.includes(file)) { res.writeHead(404, cors).end(); return; }
      res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(await readFile(vectorDir + file)); return;
    }
    if (req.method === "GET" && url.pathname === "/synthetic") {
      if (!syntheticText || !current?.synthetic) { res.writeHead(204, cors).end(); return; }
      res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(syntheticText); return;
    }
    if (req.method === "POST" && (url.pathname === "/event" || url.pathname === "/result")) {
      let body = ""; for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      const receivedAt = Date.now();
      if (current) {
        if (url.pathname === "/event") { current.events.push({ ...message, receivedAt, rss: await rss(current) }); }
        else { current.result = message; current.resultAt = receivedAt; current.done?.(); }
      }
      res.writeHead(204, cors).end(); return;
    }
    res.writeHead(404, cors).end();
  } catch (error) { res.writeHead(500, cors).end(String(error)); }
});
await new Promise(r => server.listen(47185, "127.0.0.1", r));

const ps = () => execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], { encoding: "utf8" }).split("\n")
  .map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
  .map(([, pid, ppid, rssKb, comm]) => ({ pid: Number(pid), ppid: Number(ppid), rssKb: Number(rssKb), comm }));
const webkitNames = /com\.apple\.WebKit\.(WebContent|GPU|Networking)/;
async function rss(run) {
  const table = ps();
  const appProc = table.find(p => p.comm.startsWith(executable));
  // WKWebView helpers are launchd XPC services (ppid 1); attribute the ones born after this launch.
  const helpers = table.filter(p => webkitNames.test(p.comm) && !run.preexisting.has(p.pid));
  const sample = { at: Date.now(), appPid: appProc?.pid ?? null, appRssKb: appProc?.rssKb ?? null,
    helpers: helpers.map(h => ({ pid: h.pid, kind: h.comm.match(webkitNames)[1], rssKb: h.rssKb })) };
  return sample;
}

const evidence = { harness: "test/tauri-judge-macos.mjs", app, synthetic: synthetic ?? null, startedAt: new Date().toISOString(),
  host: { model: execFileSync("sysctl", ["-n", "hw.model"], { encoding: "utf8" }).trim(),
    macos: execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
    build: execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim() }, launches: [] };
await mkdir(dataDir, { recursive: true });
for (let i = 1; i <= launches; i++) {
  const run = { index: i, synthetic: i <= syntheticLaunches, events: [], samples: [],
    preexisting: new Set(ps().filter(p => webkitNames.test(p.comm) || p.comm.startsWith(executable)).map(p => p.pid)) };
  current = run;
  const finished = new Promise(r => { run.done = r; });
  run.launchAt = Date.now();
  spawn("open", ["-n", app], { stdio: "ignore" });
  // WebKit throttles a window that is not frontmost hard enough that its timers stop; activate it.
  for (const delay of [700, 2000, 4000]) setTimeout(() => spawn("osascript", ["-e", `tell application id "${bundleId}" to activate`], { stdio: "ignore" }), delay);
  const sampler = setInterval(async () => { run.samples.push(await rss(run)); }, 500);
  const outcome = await Promise.race([finished.then(() => "result"), sleep(launchTimeoutMs).then(() => "timeout")]);
  clearInterval(sampler);
  run.samples.push(await rss(run));
  run.outcome = outcome;
  const last = run.samples.at(-1);
  // Kill the app and its WebKit helpers so the next launch is cold.
  for (const pid of [last.appPid, ...last.helpers.map(h => h.pid)].filter(Boolean)) { try { process.kill(pid, "SIGTERM"); } catch {} }
  await sleep(1500);
  for (const p of ps().filter(p => p.comm.startsWith(executable))) { try { process.kill(p.pid, "SIGKILL"); } catch {} }
  await sleep(1500);
  const peak = (pick) => Math.max(0, ...run.samples.map(pick).filter(Number.isFinite));
  const helperPeak = kind => peak(s => Math.max(0, ...s.helpers.filter(h => h.kind === kind).map(h => h.rssKb)));
  const r = run.result ?? {};
  const first = run.events.find(e => e.type === "first_verdict");
  const summary = {
    index: i, outcome, synthetic: run.synthetic,
    workerProbe: r.workerProbe ?? run.events.find(e => e.type === "page")?.workerProbe ?? null,
    crossOriginIsolated: r.crossOriginIsolated ?? run.events.find(e => e.type === "page")?.crossOriginIsolated ?? null,
    sharedArrayBuffer: r.sharedArrayBuffer ?? run.events.find(e => e.type === "page")?.sharedArrayBuffer ?? null,
    launchToResultMs: run.resultAt ? run.resultAt - run.launchAt : null, error: r.error ?? null, userAgent: r.userAgent ?? null,
    launchToPageMs: run.events.find(e => e.type === "page") ? run.events.find(e => e.type === "page").at - run.launchAt : null,
    launchToBootedMs: run.events.find(e => e.type === "booted") ? run.events.find(e => e.type === "booted").at - run.launchAt : null,
    launchToFirstVerdictMs: first ? first.at - run.launchAt : null,
    shellOriginToFirstVerdictMs: r.firstVerdictAt && r.shellTimeOrigin ? Math.round(r.firstVerdictAt - r.shellTimeOrigin) : null,
    vmBootMs: r.boot ? Math.round(r.boot.bootDoneMs - r.boot.bootStartMs) : null,
    vectors: r.summary ?? null,
    beamMemoryAfterVectors: r.vmAfterVectors?.memory_bytes ?? null,
    synthetic: r.synthetic ?? null, beamMemoryAfterSynthetic: r.vmAfterSynthetic?.memory_bytes ?? null,
    peakRssKb: { app: peak(s => s.appRssKb), WebContent: helperPeak("WebContent"), GPU: helperPeak("GPU"), Networking: helperPeak("Networking") },
    rssAtEvents: run.events.map(e => ({ type: e.type, appRssKb: e.rss.appRssKb, webContentRssKb: Math.max(0, ...e.rss.helpers.filter(h => h.kind === "WebContent").map(h => h.rssKb)) })),
    samples: run.samples.length
  };
  evidence.launches.push(summary);
  await writeFile(`${dataDir}/judge-spike-trace-${i}.json`, JSON.stringify({ summary, result: run.result ?? null, events: run.events }, null, 2));
  console.log(JSON.stringify({ i, outcome, firstVerdictMs: summary.launchToFirstVerdictMs, coi: summary.crossOriginIsolated, vectors: summary.vectors, synthetic: summary.synthetic && { ms: summary.synthetic.roundTripMs, us: summary.synthetic.elapsed_us, ok: summary.synthetic.ok, pass: summary.synthetic.pass }, peakRssKb: summary.peakRssKb, error: summary.error }));
}
current = null;
server.close();
const sorted = evidence.launches.map(l => l.launchToFirstVerdictMs).filter(Number.isFinite).sort((a, b) => a - b);
evidence.medianLaunchToFirstVerdictMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
evidence.finishedAt = new Date().toISOString();
evidence.traceDir = dataDir;
await mkdir(new URL("../evidence/", here), { recursive: true });
await writeFile(new URL("../evidence/tauri-macos.json", here), JSON.stringify(evidence, null, 2) + "\n");
console.log(`median launch-to-first-verdict ms: ${evidence.medianLaunchToFirstVerdictMs}`);
