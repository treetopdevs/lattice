// scripts/lattice_atomvm_tab_smoke.mjs — boots the packed app in the AtomVM web bundle
// via headless Chromium (Playwright + HTTP server with COOP/COEP headers), does one
// Module.call boot round-trip, asserts a real hello. Exit 0 = SMOKE_OK.
//
// Module.call uses emscripten:promise_resolve which requires SharedArrayBuffer
// (pthreads), which requires cross-origin isolation (COOP/COEP headers).
// This matches the real deployment environment exactly.
// PHASE0 C4 proved this path: 300 round-trips p99 0.63ms in headless Chromium.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const S = path.join(ROOT, "examples", "atomvm_tab");
const LIBS = path.join(ROOT, "apps", "lattice_tab", ".atomvm_build", "AtomVM-src", "build", "libs");

const ISO = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
};

const FILES = {
  "/AtomVM-web-v0.7.0-alpha.1.js":   [path.join(S, "AtomVM-web-v0.7.0-alpha.1.js"),   "text/javascript; charset=utf-8"],
  "/AtomVM-web-v0.7.0-alpha.1.wasm": [path.join(S, "AtomVM-web-v0.7.0-alpha.1.wasm"), "application/wasm"],
  "/lattice_tab.avm":  [path.join(S, "lattice_tab.avm"),  "application/octet-stream"],
  "/atomvmlib.avm":    [path.join(S, "atomvmlib.avm"),    "application/octet-stream"],
  "/exavmlib.avm":     [path.join(S, "exavmlib.avm"),     "application/octet-stream"],
};

// Minimal boot page: same Module init pattern as examples/atomvm_tab/index.html
// but with a simple onRuntimeInitialized for the smoke test.
const BOOT_HTML = `<!doctype html><html><body>
<div id="app" data-atomvm-ready="false"></div>
<script>
var Module = {
  locateFile: p => p.endsWith('.wasm') ? '/AtomVM-web-v0.7.0-alpha.1.wasm' : p,
  arguments: ['/lattice_tab.avm', '/atomvmlib.avm', '/exavmlib.avm'],
};
</script>
<script async src="/AtomVM-web-v0.7.0-alpha.1.js"></script>
</body></html>`;

const server = await new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...ISO });
      res.end(BOOT_HTML);
      return;
    }
    const entry = FILES[url];
    if (!entry) { res.writeHead(404, ISO); res.end("not found\n"); return; }
    const [file, ctype] = entry;
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404, ISO); res.end("missing: " + file + "\n"); return; }
      res.writeHead(200, { "content-type": ctype, ...ISO });
      res.end(body);
    });
  });
  s.listen(0, "127.0.0.1", () => resolve(s));
});

const port = server.address().port;
const browser = await chromium.launch({
  headless: true,
  args: ["--enable-features=SharedArrayBuffer"],
});

try {
  const page = await browser.newPage();

  // Capture BEAM stdout
  page.on("console", (msg) => {
    if (msg.type() === "log") process.stderr.write("[browser] " + msg.text() + "\n");
  });

  await page.goto(`http://127.0.0.1:${port}/`);

  // Wait up to 10s for the Realm to register (data-atomvm-ready="true" is set by Bridge.ready_beacon)
  await page.waitForFunction(
    () => document.getElementById("app")?.getAttribute("data-atomvm-ready") === "true",
    { timeout: 10000 }
  );

  // Send one boot round-trip via Module.call
  const reply = await page.evaluate(async () => {
    return await Module.call("realm", JSON.stringify({ __lattice__: "boot", client_id: "smoke-1", last_seq: 0 }));
  });

  const { out } = JSON.parse(reply);
  const ok = out?.[0]?.type === "hello" && out[0].client_id === "smoke-1";
  console.log(ok ? "SMOKE_OK" : "SMOKE_FAIL:" + reply);
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.log("SMOKE_ERROR:" + e.message);
  process.exit(1);
} finally {
  await browser.close();
  server.close();
}
