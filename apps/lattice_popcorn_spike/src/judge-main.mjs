import { Popcorn } from "@swmansion/popcorn";

// Plan 185 judge facade: exactly two commands reach the VM, `vector_verdict` and `status`.
const INGRESS = "Elixir.LatticeBrowser.Bridge";
const marks = { moduleStartMs: performance.now() };
const status = text => { document.querySelector("#status").textContent = text; };
let vm;
const ready = (async () => {
  marks.bootStartMs = performance.now();
  vm = new Popcorn({ onError: error => status(`VM error: ${JSON.stringify(error)}`) });
  const boot = await vm.boot();
  marks.bootDoneMs = performance.now();
  if (!boot.ok) throw new Error(`vm_boot_failed: ${JSON.stringify(boot.error ?? boot)}`);
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
  verdict: (schema, frames, realms, timeoutMs = 600000) => {
    const command = { command: "vector_verdict", schema, frames };
    if (realms) command.realms = realms;
    return call(command, timeoutMs);
  },
  status: () => call({ command: "status" }, 10000),
  show: summary => { document.querySelector("#results").textContent = JSON.stringify(summary, null, 2); }
});
