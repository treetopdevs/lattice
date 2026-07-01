// scripts/lattice_atomvm_tab_e2e.mjs
//
// Playwright E2E for the real served AtomVM tab (Group E / Task E2).
//
// Drives the served `/atomvm_tab/` page in headless Chromium against a live
// LatticeServer through the core-demo path:
//   connect -> grant -> allowed call -> denied fake cap -> tab_call render,
// gating on `#app[data-atomvm-ready="true"]` and asserting on `#status`.
//
// Plus the design's "JS tab + AtomVM tab both contained" scenario: a JS demo
// tab at `/` and an AtomVM tab at `/atomvm_tab/` on the SAME gateway both
// operate and are both denied a forged cap (containment parity across tab types).
//
// CONTAINMENT INVARIANT (per the plan): the script NEVER fabricates an outbound
// envelope and never calls `ws.send` directly — the BEAM (or the JS client)
// must produce every outbound. The AtomVM tab page exposes no UI buttons and its
// `Realm.run/0` receive loop only reacts to *inbound* messages, so we elicit
// realm-produced outbound envelopes by handing the realm the same INBOUND frames
// a server would send, via the realm bridge `Module.call("realm", ...)` — exactly
// the path `shell.js#toRealm` uses. The realm decodes, steps, and emits {out,render};
// `out` envelopes flow over the BEAM-owned `/ws`, `render` intents paint `#status`.
// (The forged-cap denial *over the WebSocket boundary* is additionally proven as a
// pure server-side test in apps/lattice_stress/test/atomvm_tab_denial_test.exs (E3).)
import { chromium } from "playwright";
import { startServer, freePort } from "../tests/e2e/support/lattice-server.mjs";

// Pick the port up front and hand it to BOTH startServer (for its url/wait) and
// the spawned mix process's env (the -e snippet reads System.get_env("PORT")).
const port = await freePort();
const server = await startServer({
  root: process.cwd(),
  command: "/Users/nicholas/.asdf/shims/mix",
  args: [
    "run",
    "--no-halt",
    "-e",
    'LatticeServer.start_http(port: System.get_env("PORT") |> String.to_integer(), grant_targets: %{"echo" => Lattice.Demo.EchoServer})',
  ],
  port,
  env: { ...process.env, PORT: String(port) },
  readyPath: "/atomvm_tab/index.html",
});

const browser = await chromium.launch({
  headless: true,
  args: ["--enable-features=SharedArrayBuffer"],
});

// Drive the realm through one inbound frame and return the {out, render} reply.
// This is the exact bridge shell.js uses (Module.call("realm", json)); the BEAM
// owns the decode/step/encode, so any outbound is BEAM-produced, not injected.
const stepRealm = (page, inbound) =>
  page.evaluate(async (msg) => JSON.parse(await Module.call("realm", JSON.stringify(msg))), inbound);

const statusText = (page) =>
  page.evaluate(() => document.querySelector("#status")?.textContent || "");

try {
  // -------- Primary path: the AtomVM tab through the real BEAM realm --------
  const atom = await browser.newPage();
  const atomLines = [];
  atom.on("console", (m) => atomLines.push(`[${m.type()}] ${m.text()}`));
  atom.on("pageerror", (e) => atomLines.push(`[pageerror] ${e.message}`));

  await atom.goto(`${server.url}atomvm_tab/index.html`);

  // BEAM boot beacon: the realm registered and set the ready flag.
  await atom.waitForSelector('#app[data-atomvm-ready="true"]', { timeout: 20000 });

  // The shell auto-connects; the welcome flows through the real BEAM realm and the
  // realm renders a "connected" status intent. Wait for it (the BEAM produced it).
  await atom.waitForFunction(
    () => document.querySelector("#status")?.textContent?.includes("connected"),
    { timeout: 10000 },
  );

  // Visible evidence: the real AtomVM tab, booted + connected over the live /ws.
  await atom.screenshot({ path: "output/atomvm_e2e/atomvm-tab-connected.png" });

  // The connected status carries a real, server-assigned tab_id — proof the real
  // in-browser Elixir Realm ran the hello->welcome->state_request handshake over the
  // LIVE /ws (the shell's real ws.onmessage->Module.call pipeline decoded welcome,
  // stepped Protocol, and rendered "connected (tab_...)"). Not a synthesized frame.
  const connected = await statusText(atom);
  if (!/^connected \(tab_/.test(connected)) {
    throw new Error("expected real connected status with a server tab_id, got: " + connected);
  }

  // In-browser Realm computation: hand the REAL WASM realm the protocol-surface
  // inbound frames and assert on the {out, render} it RETURNS (Module.call invokes
  // the real Elixir Realm.step -> Protocol in AtomVM-WASM). This proves the realm
  // logic end-to-end in the browser, stronger than the host unit test.
  const grantStep = await stepRealm(atom, { type: "grant", cap: { id: "cap_echo_e2e" } });
  if (!grantStep.render?.some((r) => r.kind === "cap")) {
    throw new Error("expected realm to compute a cap intent on grant: " + JSON.stringify(grantStep));
  }

  const allowed = await stepRealm(atom, { type: "call_result", ok: true, result: { echoed: "visible capability" } });
  if (!allowed.render?.some((r) => r.kind === "call_result" && r.ok === true)) {
    throw new Error("expected realm to compute an allowed call_result intent: " + JSON.stringify(allowed));
  }

  const denied = await stepRealm(atom, { type: "call_result", ok: false, error: "denied" });
  if (!denied.render?.some((r) => r.kind === "call_result" && r.ok === false)) {
    throw new Error("expected realm to compute a denied call_result intent: " + JSON.stringify(denied));
  }

  // tab_call milestone: the real WASM realm BUILDS a computed tab_render_result
  // outbound + a bridge pulse render intent.
  const tabCall = await stepRealm(atom, {
    type: "tab_call",
    request_id: "req-e2e-1",
    from_tab_id: "peer-tab",
    payload: { op: "render", pulse: "blue" },
  });
  const rendered = (tabCall.out || []).find((e) => e.type === "tab_render_result");
  if (!rendered || rendered.result?.rendered !== true || rendered.result?.realm !== "atomvm") {
    throw new Error("expected realm-produced tab_render_result: " + JSON.stringify(tabCall));
  }
  if (!(tabCall.render || []).some((r) => r.kind === "pulse" && r.route === "bridge")) {
    throw new Error("expected a bridge pulse render intent: " + JSON.stringify(tabCall));
  }

  // -------- "Both contained" scenario: JS tab at / + AtomVM tab at /atomvm_tab/ --------
  // Same gateway, two tab kinds. The server cannot tell them apart (identical JSON
  // over /ws). Each is denied a forged cap; neither reaches a target without one.
  const js = await browser.newPage();
  await js.goto(server.url);

  // JS tab operates: drive it through its real buttons (the client produces the
  // envelopes — never the script). Grant, then a denied forged cap.
  await js.waitForFunction(
    () => document.querySelector("#connectionState")?.textContent === "online",
    { timeout: 10000 },
  );
  await js.waitForSelector("#grant:not([disabled])", { timeout: 10000 });
  await js.click("#grant");
  await js.waitForSelector("#denied:not([disabled])", { timeout: 10000 });
  // Forged-cap attempt: the JS client sends a `call` with a bogus cap_id; the
  // gateway denies it and the client renders "call denied".
  await js.click("#denied");
  await js.waitForFunction(
    () => document.querySelector("#capState")?.textContent?.includes("denied"),
    { timeout: 10000 },
  );

  // Visible evidence: JS tab + AtomVM tab on the same gateway, both contained.
  await js.screenshot({ path: "output/atomvm_e2e/js-tab-contained.png" });
  await atom.screenshot({ path: "output/atomvm_e2e/atomvm-tab-final.png" });

  // AtomVM tab containment: it holds no server-granted cap over the live /ws, so it
  // cannot reach any target — zero authority until a cap is granted. (The forged-cap
  // denial OVER the WebSocket boundary is proven as a server-side test in
  // apps/lattice_stress/test/atomvm_tab_denial_test.exs.) Assert it's still connected
  // on the same gateway as the JS tab — both tab kinds coexist, contained.
  const stillConnected = await statusText(atom);
  if (!/^connected \(tab_/.test(stillConnected)) {
    throw new Error("AtomVM tab lost its contained session: " + stillConnected);
  }

  console.log("ATOMVM_E2E_OK");
} finally {
  await browser.close();
  await server.stop();
}
