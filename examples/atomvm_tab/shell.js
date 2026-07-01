// examples/atomvm_tab/shell.js — authority-blind shell for the AtomVM tab.
// It NEVER inspects envelope type/cap_id/result; it ferries bytes to the BEAM
// realm (Module.call) and paints render intents the realm returns.
const app = document.getElementById("app");
let ws, ready = false;
let lastSeq = Number(sessionStorage.getItem("lattice.resume.seq") || "0");
let clientId = sessionStorage.getItem("lattice.resume.client_id");
if (!clientId) {
  clientId = (crypto.randomUUID && crypto.randomUUID()) || `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  sessionStorage.setItem("lattice.resume.client_id", clientId);
}

async function whenRealmReady() {
  // The BEAM sets data-atomvm-ready="true" via the ready beacon once registered.
  while (app.getAttribute("data-atomvm-ready") !== "true") await new Promise((r) => setTimeout(r, 25));
  ready = true;
}

// Single bridge call: hand the realm one inbound message, get {out, render}.
async function toRealm(message) {
  const reply = await Module.call("realm", JSON.stringify(message));
  const { out = [], render = [] } = JSON.parse(reply);
  out.forEach((env) => ws.send(JSON.stringify(env)));
  render.forEach(applyIntent);
}

// Dumb kind -> DOM map. No authority decisions.
function applyIntent(intent) {
  switch (intent.kind) {
    case "status": app.querySelector("#status").textContent = intent.text + (intent.tab_id ? ` (${intent.tab_id.slice(0, 8)})` : ""); break;
    case "cap": app.querySelector("#status").textContent = `cap ${intent.text}`; break;
    case "call_result": app.querySelector("#status").textContent = intent.ok ? "call allowed" : "call denied"; break;
    case "cast_result": app.querySelector("#status").textContent = intent.ok ? "cast ok" : "cast denied"; break;
    case "pulse": pulse(intent.route); break;
    case "error": app.querySelector("#status").textContent = `error: ${intent.text}`; break;
    case "ledger_event": addLedger(intent); break;
  }
}
function pulse(route) {
  app.classList.add(`pulse-${route}`);
  setTimeout(() => app.classList.remove(`pulse-${route}`), 780);
}
function addLedger(intent) {
  const li = document.createElement("li");
  li.textContent = intent.text || intent.route || "event";
  app.querySelector("#ledger").prepend(li);
}
function rememberSeq(raw) {
  try { const m = JSON.parse(raw); if (typeof m.seq === "number" && m.seq > lastSeq) { lastSeq = m.seq; sessionStorage.setItem("lattice.resume.seq", String(lastSeq)); } } catch (_) {}
}

function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.addEventListener("open", async () => {
    await whenRealmReady();
    try {
      const r = await fetch(`/api/session-token?client_id=${encodeURIComponent(clientId)}`);
      ws.send(JSON.stringify({ type: "resume", seq: lastSeq, jwt: (await r.json()).token }));
    } catch (_) { lastSeq = 0; }
    // Ask the realm to build hello (carries the shell-owned client_id).
    await toRealm({ __lattice__: "boot", client_id: clientId, last_seq: lastSeq });
  });
  ws.addEventListener("message", (e) => { rememberSeq(e.data); if (ready) toRealm(JSON.parse(e.data)); });
  ws.addEventListener("close", () => { ready = false; setTimeout(connect, 500); });
}

connect();
