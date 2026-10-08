import { Popcorn } from "@swmansion/popcorn";

// Plan 185 judge facade: only `vector_verdict` (or its chunked form) and `status` reach the VM.
const INGRESS = "Elixir.LatticeBrowser.Bridge";
const CHUNK_BYTES = 24576;
const toBase64 = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(s); };
const marks = { moduleStartMs: performance.now() };
const vmErrors = [];
const vmOutput = [];
const collectorOrigin = new URL(location.href).searchParams.get("collector");
const trace = (type, data = {}) => { if (collectorOrigin && /^http:\/\/127\.0\.0\.1:\d+$/.test(collectorOrigin)) void fetch(`${collectorOrigin}/event`, { method: "POST", body: JSON.stringify({ type, at: Date.now(), ...data }) }).catch(() => {}); };
const output = stream => chunk => { if (vmOutput.length < 200) { vmOutput.push([stream, String(chunk)]); trace("vm_output", { stream, text: String(chunk).slice(0, 2000) }); } };
const status = text => { document.querySelector("#status").textContent = text; };
let vm;
const ready = (async () => {
  marks.bootStartMs = performance.now();
  // A 4,000-op vector is a multi-megabyte message; allow its send to take longer than the 5 s default.
  vm = new Popcorn({ timeoutsMs: { send: 600000 }, onStdout: output("stdout"), onStderr: output("stderr"), onError: error => { vmErrors.push(error); trace("vm_error", { error: JSON.stringify(error).slice(0, 4000) }); status(`VM error: ${JSON.stringify(error)}`); } });
  trace("boot_start");
  const boot = await vm.boot();
  marks.bootDoneMs = performance.now();
  if (!boot.ok) throw new Error(`vm_boot_failed: ${JSON.stringify(boot.error ?? boot)} ${String(boot.error?.cause ?? "")} ${JSON.stringify(vmErrors)}`);
  status("Browser OTP ready");
})();
const call = async (command, timeoutMs) => {
  await ready;
  const result = await vm.genserver.call(INGRESS, command, { timeoutMs });
  if (!result.ok) throw new Error(`vm_call_failed: ${JSON.stringify(result.error ?? result)}`);
  return result.data;
};
window.judge = Object.freeze({
  ready: () => ready.then(() => ({ ...marks, crossOriginIsolated: globalThis.crossOriginIsolated === true })),
  verdict: async (schema, frames, realms, timeoutMs = 600000) => {
    const text = JSON.stringify(frames);
    if (text.length <= CHUNK_BYTES) {
      const command = { command: "vector_verdict", schema, frames };
      if (realms) command.realms = realms;
      return call(command, timeoutMs);
    }
    // Popcorn 0.4.0-next.0 cannot deliver one JS-to-VM message much above 64 KiB: send base64 chunks.
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
      const reply = await call({ command: "vector_chunk", data: toBase64(bytes.subarray(i, i + CHUNK_BYTES)) }, 60000);
      if (!reply.ok) return reply;
    }
    const command = { command: "vector_verdict_buffered", schema };
    if (realms) command.realms = realms;
    return { ...(await call(command, timeoutMs)), chunks: Math.ceil(bytes.length / CHUNK_BYTES), frames_json_bytes: bytes.length };
  },
  status: () => call({ command: "status" }, 10000),
  show: summary => { document.querySelector("#results").textContent = JSON.stringify(summary, null, 2); }
});

// In-app mode (the Treehouse judge-spike build only): `?collector=<loopback origin>`. The page
// fetches the vectors and the synthetic log from the harness collector, judges them in this
// Worker, shows the summary, and posts it back. It sends nothing else anywhere.
import { compareVerdict } from "../test/vector-compare.mjs";
const params = new URL(location.href).searchParams;
const collector = params.get("collector");
if (collector && /^http:\/\/127\.0\.0\.1:\d+$/.test(collector)) void autorun(collector);

async function autorun(origin) {
  const post = (path, body) => fetch(`${origin}${path}`, { method: "POST", body: JSON.stringify(body) });
  const getJson = path => fetch(`${origin}${path}`).then(r => { if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.json(); });
  const report = { runtime: "tauri-webview", userAgent: navigator.userAgent,
    shellTimeOrigin: Number(params.get("shellOrigin")) || null, pageTimeOrigin: performance.timeOrigin,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer === "function", atomics: typeof Atomics === "object", vectors: [], skipped: [] };
  try {
    // Diagnostic: what a dedicated Worker in this webview exposes (Popcorn boots inside one).
    report.workerProbe = await new Promise(resolve => {
      try {
        const url = URL.createObjectURL(new Blob(["postMessage({ sab: typeof SharedArrayBuffer, coi: self.crossOriginIsolated === true, wasm: typeof WebAssembly })"], { type: "text/javascript" }));
        const w = new Worker(url); w.onmessage = e => { resolve(e.data); w.terminate(); }; w.onerror = e => resolve({ error: String(e.message) });
        setTimeout(() => resolve({ error: "probe_timeout" }), 3000);
      } catch (error) { resolve({ error: String(error?.message ?? error) }); }
    });
    await post("/event", { type: "page", at: Date.now(), crossOriginIsolated: report.crossOriginIsolated,
      sharedArrayBuffer: report.sharedArrayBuffer, atomics: report.atomics, workerProbe: report.workerProbe });
    report.boot = await window.judge.ready();
    report.bootDoneAt = Date.now();
    await post("/event", { type: "booted", at: report.bootDoneAt });
    for (const file of await getJson("/vectors")) {
      const vector = await getJson(`/vector/${encodeURIComponent(file)}`);
      if (!Array.isArray(vector.oracleCarrierOps)) { report.skipped.push({ file, scenario: vector.scenario }); continue; }
      const result = await window.judge.verdict(vector.schema.name, vector.oracleCarrierOps, vector.realmByPubkey ?? null);
      if (report.firstVerdictAt === undefined) {
        report.firstVerdictAt = Date.now();
        await post("/event", { type: "first_verdict", at: report.firstVerdictAt });
      }
      const comparison = compareVerdict(vector, result);
      report.vectors.push({ file, scenario: vector.scenario, pass: comparison.pass, elapsed_us: result?.elapsed_us ?? null,
        error: result?.ok ? undefined : result?.error, undecodable: result?.undecodable?.map(u => u.id) });
    }
    report.vmAfterVectors = await window.judge.status();
    report.vectorsDoneAt = Date.now();
    await post("/event", { type: "vectors_done", at: report.vectorsDoneAt });
    // The collector answers 204 when this launch should skip the synthetic log.
    const syntheticResponse = await fetch(`${origin}/synthetic`);
    if (syntheticResponse.status !== 200) report.synthetic = { skipped: true };
    else {
      const synthetic = await syntheticResponse.json();
      const started = Date.now();
      await post("/event", { type: "synthetic_start", at: started });
      const result = await window.judge.verdict(synthetic.schema.name, synthetic.oracleCarrierOps, synthetic.realmByPubkey, 3600000);
      const comparison = compareVerdict(synthetic, result);
      report.synthetic = { scenario: synthetic.scenario, frames: synthetic.oracleCarrierOps.length, roundTripMs: Date.now() - started,
        ok: result?.ok, error: result?.error, detail: result?.detail, op_count: result?.op_count, elapsed_us: result?.elapsed_us,
        phases_us: result?.phases_us, json_decode_us: result?.json_decode_us, chunks: result?.chunks,
        structural: result?.structural, quarantine: result?.quarantine?.length, pass: comparison.pass };
      report.vmAfterSynthetic = await window.judge.status();
      report.syntheticDoneAt = Date.now();
      await post("/event", { type: "synthetic_done", at: report.syntheticDoneAt });
    }
    const failed = report.vectors.filter(v => !v.pass);
    report.summary = { loaded: report.vectors.length, passed: report.vectors.length - failed.length, failed: failed.length,
      skipped: report.skipped.length, failedScenarios: failed.map(v => v.scenario) };
  } catch (error) { report.error = { message: String(error?.message ?? error), stack: String(error?.stack ?? ""), vmErrors }; }
  report.finishedAt = Date.now();
  window.judge.show(report.summary ?? report);
  await post("/result", report).catch(() => {});
}
