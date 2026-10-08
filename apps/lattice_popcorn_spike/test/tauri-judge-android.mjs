// Plan 185 step 6: install the judge-spike debug APK on an emulator or device, launch it cold,
// serve it the vectors and the synthetic log through `adb reverse`, and collect the in-app result.
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = new URL(".", import.meta.url);
const adb = process.env.ADB || `${homedir()}/Library/Android/sdk/platform-tools/adb`;
const apk = process.env.LATTICE_JUDGE_APK || fileURLToPath(new URL(
  "../../../clients/treehouse-tauri-shell/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk", here));
const pkg = process.env.LATTICE_JUDGE_PACKAGE || "dev.treetop.lattice.treehouse";
const vectorDir = fileURLToPath(new URL("../../../clients/lattice-client/test/vectors/", here));
const synthetic = process.env.LATTICE_JUDGE_SYNTHETIC;
const launches = Number(process.env.LATTICE_JUDGE_LAUNCHES || 3);
const timeoutMs = Number(process.env.LATTICE_JUDGE_LAUNCH_TIMEOUT_MS || 600000);
const run = (...args) => execFileSync(adb, args, { encoding: "utf8" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const files = (await readdir(vectorDir)).filter(f => f.endsWith(".json")).sort();
const syntheticText = synthetic ? await readFile(synthetic, "utf8") : null;
const cors = { "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin", "Cache-Control": "no-store" };
let current = null;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "OPTIONS") { res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "GET, POST" }).end(); return; }
  if (url.pathname === "/vectors") { res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify(files)); return; }
  if (url.pathname.startsWith("/vector/")) {
    const file = decodeURIComponent(url.pathname.slice(8));
    if (!files.includes(file)) { res.writeHead(404, cors).end(); return; }
    res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(await readFile(vectorDir + file)); return;
  }
  if (url.pathname === "/synthetic") {
    if (!syntheticText || !current?.synthetic) { res.writeHead(204, cors).end(); return; }
    res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(syntheticText); return;
  }
  if (req.method === "POST") {
    let body = ""; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (current) {
      if (url.pathname === "/event") current.events.push({ ...message, receivedAt: Date.now(), meminfo: meminfo() });
      else { current.result = message; current.done?.(); }
    }
    res.writeHead(204, cors).end(); return;
  }
  res.writeHead(404, cors).end();
});
await new Promise(r => server.listen(47185, "127.0.0.1", r));
// Total PSS and RSS (KB) of the app process, which hosts the System WebView renderer in-process or not.
function meminfo() {
  try {
    const out = run("shell", "dumpsys", "meminfo", pkg);
    const pss = out.match(/TOTAL PSS:\s+(\d+)/) ?? out.match(/TOTAL\s+(\d+)/);
    const rss = out.match(/TOTAL RSS:\s+(\d+)/);
    return { totalPssKb: pss ? Number(pss[1]) : null, totalRssKb: rss ? Number(rss[1]) : null };
  } catch { return null; }
}
const evidence = { harness: "test/tauri-judge-android.mjs", apk, startedAt: new Date().toISOString(),
  device: { model: run("shell", "getprop", "ro.product.model").trim(), sdk: run("shell", "getprop", "ro.build.version.sdk").trim(),
    abi: run("shell", "getprop", "ro.product.cpu.abi").trim(), webview: (run("shell", "dumpsys", "webviewupdate").match(/Current WebView package \(name, version\): \(([^)]*)\)/) ?? [])[1] ?? null },
  launches: [] };
run("install", "-r", apk);
run("reverse", "tcp:47185", "tcp:47185");
for (let i = 1; i <= launches; i++) {
  run("shell", "am", "force-stop", pkg);
  await sleep(1500);
  const r = { index: i, synthetic: true, events: [] };
  current = r;
  const done = new Promise(resolve => { r.done = resolve; });
  r.launchAt = Date.now();
  run("shell", "am", "start", "-W", "-n", `${pkg}/.MainActivity`);
  r.outcome = await Promise.race([done.then(() => "result"), sleep(timeoutMs).then(() => "timeout")]);
  r.meminfoAtEnd = meminfo();
  const result = r.result ?? {};
  const at = type => r.events.find(e => e.type === type);
  const summary = { index: i, outcome: r.outcome, crossOriginIsolated: result.crossOriginIsolated ?? at("page")?.crossOriginIsolated ?? null,
    sharedArrayBuffer: result.sharedArrayBuffer ?? at("page")?.sharedArrayBuffer ?? null, workerProbe: result.workerProbe ?? at("page")?.workerProbe ?? null,
    userAgent: result.userAgent ?? null, error: result.error ?? null,
    launchToPageMs: at("page") ? at("page").receivedAt - r.launchAt : null,
    launchToBootedMs: at("booted") ? at("booted").receivedAt - r.launchAt : null,
    launchToFirstVerdictMs: at("first_verdict") ? at("first_verdict").receivedAt - r.launchAt : null,
    vmBootMs: result.boot ? Math.round(result.boot.bootDoneMs - result.boot.bootStartMs) : null,
    vectors: result.summary ?? null, beamMemoryAfterVectors: result.vmAfterVectors?.memory_bytes ?? null,
    synthetic: result.synthetic ?? null, beamMemoryAfterSynthetic: result.vmAfterSynthetic?.memory_bytes ?? null,
    meminfoAtEvents: r.events.map(e => ({ type: e.type, ...e.meminfo })), meminfoAtEnd: r.meminfoAtEnd };
  evidence.launches.push(summary);
  console.log(JSON.stringify({ i, outcome: r.outcome, coi: summary.crossOriginIsolated, sab: summary.sharedArrayBuffer, firstVerdictMs: summary.launchToFirstVerdictMs, vectors: summary.vectors && [summary.vectors.passed, summary.vectors.failed, summary.vectors.skipped], synthetic: summary.synthetic && { us: summary.synthetic.elapsed_us, pass: summary.synthetic.pass, error: summary.synthetic.error }, mem: summary.meminfoAtEnd, error: summary.error?.message?.slice(0, 200) }));
  if (r.outcome === "timeout" && i === 1 && !at("booted")) break; // the runtime does not boot here; one launch suffices
}
current = null;
run("shell", "am", "force-stop", pkg);
server.close();
evidence.finishedAt = new Date().toISOString();
await mkdir(new URL("../evidence/", here), { recursive: true });
await writeFile(new URL("../evidence/tauri-android.json", here), JSON.stringify(evidence, null, 2) + "\n");
