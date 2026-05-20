const els = {
  connectionState: document.querySelector("#connectionState"),
  tabBadge: document.querySelector("#tabBadge"),
  auditBadge: document.querySelector("#auditBadge"),
  tabCount: document.querySelector("#tabCount"),
  capState: document.querySelector("#capState"),
  selfNode: document.querySelector("#selfNode"),
  peerNode: document.querySelector("#peerNode"),
  serverNode: document.querySelector("#serverNode"),
  selfLetter: document.querySelector("#selfLetter"),
  peerLetter: document.querySelector("#peerLetter"),
  selfStatus: document.querySelector("#selfStatus"),
  peerStatus: document.querySelector("#peerStatus"),
  selfId: document.querySelector("#selfId"),
  peerId: document.querySelector("#peerId"),
  capToken: document.querySelector("#capToken"),
  denyMark: document.querySelector("#denyMark"),
  ledgerList: document.querySelector("#ledgerList"),
  ledgerClock: document.querySelector("#ledgerClock"),
  connect: document.querySelector("#connect"),
  grant: document.querySelector("#grant"),
  allowed: document.querySelector("#allowed"),
  denied: document.querySelector("#denied"),
  disconnect: document.querySelector("#disconnect"),
};

let ws;
let tabId;
let echoCapId;
let ledger = [];
let tabsById = new Map();
let selfLabel = "tab";
let manualDisconnect = false;
let reconnectTimer;
let reconnectDelay = 250;
let lastSeq = Number(window.sessionStorage.getItem("lattice.resume.seq") || "0");
let clientId = window.sessionStorage.getItem("lattice.resume.client_id");

if (!clientId) {
  clientId =
    window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.sessionStorage.setItem("lattice.resume.client_id", clientId);
}

const eventGlyphs = {
  tab_connect: "in",
  tab_disconnect: "out",
  grant: "cap",
  call: "ok",
  cast: "cast",
  deny: "deny",
  bridge_intent: "aim",
  bridge_open: "link",
  bridge_result: "return",
  tab_render_result: "paint",
};

function shortId(id) {
  return id ? id.slice(0, 8) : "none";
}

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  manualDisconnect = false;
  window.clearTimeout(reconnectTimer);
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  ws = new WebSocket(url);
  els.connectionState.textContent = "connecting";
  setButtons(false);

  ws.addEventListener("open", async () => {
    reconnectDelay = 250;

    try {
      const jwt = await fetchResumeToken();
      send({ type: "resume", seq: lastSeq, jwt });
    } catch (_error) {
      lastSeq = 0;
    }

    send({
      type: "hello",
      client_id: clientId,
      identity: { surface: "browser-demo", color: "green", client_id: clientId },
    });
  });

  ws.addEventListener("message", (event) => {
    handleMessage(JSON.parse(event.data));
  });

  ws.addEventListener("close", () => {
    els.connectionState.textContent = "offline";
    tabId = undefined;
    echoCapId = undefined;
    selfLabel = "tab";
    setButtons(false);
    resetControlLabels();
    document.body.classList.remove("is-connected");

    if (!manualDisconnect) {
      scheduleReconnect();
    }
  });
}

async function fetchResumeToken() {
  const response = await fetch(`/api/session-token?client_id=${encodeURIComponent(clientId)}`);
  const body = await response.json();
  return body.token;
}

function scheduleReconnect() {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(Math.floor(reconnectDelay * 1.8), 3000);
}

function send(envelope) {
  ws.send(JSON.stringify(envelope));
}

function handleMessage(msg) {
  rememberSeq(msg);

  if (msg.type === "welcome") {
    tabId = msg.tab_id;
    clientId = msg.client_id || clientId;
    window.sessionStorage.setItem("lattice.resume.client_id", clientId);
    els.connectionState.textContent = "online";
    els.tabBadge.textContent = shortId(tabId);
    els.selfId.textContent = shortId(tabId);
    els.selfStatus.textContent = "this tab";
    document.body.classList.add("is-connected");
    setButtons(true);
    send({ type: "state_request" });
  }

  if (msg.type === "resume_ok") {
    els.connectionState.textContent = msg.replayed > 0 ? "resumed" : "online";
  }

  if (msg.type === "rehydrate") {
    lastSeq = 0;
    window.sessionStorage.setItem("lattice.resume.seq", "0");
  }

  if (msg.type === "snapshot") {
    renderPresence(msg.tabs || [], msg.audit_count || 0);
    renderLedger(msg.events || []);
  }

  if (msg.type === "presence") {
    renderPresence(msg.tabs || [], msg.audit_count || 0);
  }

  if (msg.type === "server_event") {
    renderEvent(msg.event, msg.audit_count || 0);
  }

  if (msg.type === "grant") {
    echoCapId = msg.cap.id;
    els.capState.textContent = "your Echo cap";
    setButtons(true);
    setControlLabels(selfLabel);
  }

  if (msg.type === "call_result") {
    els.capState.textContent = msg.ok ? "call allowed" : "call denied";
  }

  if (msg.type === "tab_call") {
    pulseRoute("bridge");

    window.setTimeout(() => {
      send({
        type: "tab_render_result",
        request_id: msg.request_id,
        result: {
          received_by: tabId,
          pulse: msg.payload && msg.payload.pulse,
          rendered: true,
        },
      });
    }, 520);
  }

  if (msg.type === "disconnect_result") {
    ws.close();
  }
}

function requestGrant() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  send({ type: "grant_request", target: "echo" });
}

function allowedCall() {
  if (!echoCapId) return;

  send({
    type: "call",
    cap_id: echoCapId,
    payload: { op: "echo", message: "visible capability" },
  });
}

function deniedCall() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  send({
    type: "call",
    cap_id: "not-a-real-cap",
    payload: { op: "forbidden", message: "raw reach" },
  });
}

function disconnect() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  manualDisconnect = true;
  send({ type: "disconnect" });
}

function rememberSeq(msg) {
  if (typeof msg.seq !== "number" || msg.seq <= lastSeq) return;
  lastSeq = msg.seq;
  window.sessionStorage.setItem("lattice.resume.seq", String(lastSeq));
}

function renderPresence(tabs, auditCount) {
  const self = tabs.find((tab) => tab.id === tabId);
  const peer = tabs.find((tab) => tab.id !== tabId);

  tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  els.auditBadge.textContent = `audit ${auditCount}`;
  els.tabCount.textContent = `${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}`;

  if (self) {
    selfLabel = self.label || "A";
    els.selfLetter.textContent = selfLabel;
    els.selfNode.style.setProperty("--realm-hue", self.hue || 152);
    els.selfStatus.textContent = `${selfLabel} · this tab`;
    setControlLabels(selfLabel);
  }

  if (peer) {
    els.peerLetter.textContent = peer.label || "B";
    els.peerId.textContent = shortId(peer.id);
    els.peerStatus.textContent = `${peer.label || "B"} · peer tab`;
    els.peerNode.style.setProperty("--realm-hue", peer.hue || 280);
    document.body.classList.add("has-peer");
  } else {
    els.peerId.textContent = "open another tab";
    els.peerStatus.textContent = "second tab";
    document.body.classList.remove("has-peer");
  }
}

function renderEvent(event, auditCount) {
  if (!event) return;
  els.auditBadge.textContent = `audit ${auditCount}`;
  els.capState.textContent = capStateText(event);
  ledger = [event, ...ledger].slice(0, 9);
  drawLedger();
  pulseEvent(event);
}

function renderLedger(events) {
  ledger = events.slice(-9).reverse();
  drawLedger();
}

function drawLedger() {
  els.ledgerClock.textContent = new Date().toLocaleTimeString();
  els.ledgerList.replaceChildren(
    ...ledger.map((event) => {
      const item = document.createElement("li");
      item.className = `ledger-item event-${event.kind}`;

      const glyph = document.createElement("span");
      glyph.className = "ledger-glyph";
      glyph.textContent = eventGlyphs[event.kind] || "evt";

      const body = document.createElement("span");
      body.className = "ledger-body";

      const title = document.createElement("strong");
      title.textContent = eventTitle(event);

      const detail = document.createElement("span");
      detail.textContent = eventDetail(event);

      const id = document.createElement("code");
      id.textContent = String(event.id).padStart(2, "0");

      body.append(title, detail);
      item.append(glyph, body, id);
      return item;
    }),
  );
}

function eventTitle(event) {
  const data = event.data || {};
  const actor = labelForId(data.tab_id || data.from_tab_id);
  const target = data.to_tab_id ? labelForId(data.to_tab_id) : targetName(data.target);

  return (
    {
      tab_connect: `${actor} connected`,
      tab_disconnect: `${actor} disconnected`,
      grant: `server granted EchoServer to ${actor}`,
      call: `${actor} called ${target || "EchoServer"}`,
      cast: `${actor} cast`,
      deny: `${actor} denied`,
      bridge_intent: `server opened mediated path`,
      bridge_open: `bridge cap granted: ${actor} to ${target}`,
      bridge_result: `${target} answered ${actor}`,
      tab_render_result: `${actor} rendered tab-side`,
    }[event.kind] || event.kind
  );
}

function eventDetail(event) {
  const data = event.data || {};
  const actor = labelForId(data.tab_id || data.from_tab_id);
  const target = data.to_tab_id ? labelForId(data.to_tab_id) : targetName(data.target);
  const cap = data.cap_id ? `cap ${shortId(data.cap_id)}` : "no cap";

  if (event.kind === "grant") return `only ${actor} can use ${cap} on ${target || "EchoServer"}`;
  if (event.kind === "call") return `${actor} used ${cap}; gateway allowed`;
  if (event.kind === "deny") return `${actor}; ${String(data.reason || "not authorized")}; gateway refused`;
  if (event.kind === "bridge_intent") return `${actor} may call ${target}; no direct tab network`;
  if (event.kind === "bridge_open") return `owner ${actor}; target ${target}; ${cap}`;
  if (event.kind === "bridge_result") return `request crossed the server gateway and returned`;
  if (event.kind === "tab_connect") return "zero authority until a cap is granted";
  if (event.kind === "tab_disconnect") return "owned caps revoked, workers cleaned";
  return `${actor}${target ? ` -> ${target}` : ""}`;
}

function labelForId(id) {
  if (!id) return "server";
  const tab = tabsById.get(id);
  if (!tab) return shortId(id);
  const suffix = id === tabId ? "this tab" : "peer tab";
  return `${tab.label || shortId(id)} ${suffix}`;
}

function targetName(target) {
  if (!target) return "";
  if (target === "echo") return "EchoServer";
  if (String(target).startsWith("tab:")) return labelForId(String(target).slice(4));
  return String(target).replace("Elixir.Lattice.Demo.", "");
}

function shortLabelForId(id) {
  if (!id) return "server";
  if (id === tabId) return "you";
  const tab = tabsById.get(id);
  return tab ? tab.label || "peer" : shortId(id);
}

function capStateText(event) {
  const data = event.data || {};
  const actor = shortLabelForId(data.tab_id || data.from_tab_id);
  const target = shortLabelForId(data.to_tab_id);

  if (event.kind === "grant") return actor === "you" ? "your Echo cap" : `${actor} Echo cap`;
  if (event.kind === "call") return `${actor} call ok`;
  if (event.kind === "deny") return actor === "you" ? "your call denied" : `${actor} denied`;
  if (event.kind === "bridge_open") return `${actor} to ${target}`;
  if (event.kind === "bridge_result") return `${actor} to ${target} ok`;
  if (event.kind === "tab_render_result") return `${actor} rendered`;
  if (event.kind === "tab_disconnect") return `${actor} offline`;
  return els.capState.textContent;
}

function pulseEvent(event) {
  const data = event.data || {};
  const actorId = data.tab_id || data.from_tab_id;

  if (event.kind === "deny") {
    pulseRoute(actorId === tabId ? "deny-self" : "deny-peer");
    return;
  }

  if (data.to_tab_id || event.kind.startsWith("bridge")) {
    pulseRoute("bridge");
    return;
  }

  if (event.kind === "grant") {
    pulseRoute(actorId === tabId ? "grant-self" : "grant-peer");
    return;
  }

  if (event.kind === "call" || event.kind === "cast") {
    pulseRoute(actorId === tabId ? "self" : "peer");
    return;
  }

  if (event.kind === "tab_render_result") {
    pulseRoute(actorId === tabId ? "self" : "peer");
    return;
  }

  pulseRoute("server");
}

function pulseRoute(route) {
  const className = `pulse-${route}`;

  document.body.classList.remove(
    "pulse-self",
    "pulse-peer",
    "pulse-grant-self",
    "pulse-grant-peer",
    "pulse-deny-self",
    "pulse-deny-peer",
    "pulse-bridge",
    "pulse-server",
  );

  window.requestAnimationFrame(() => {
    document.body.classList.add(className);
    window.setTimeout(() => document.body.classList.remove(className), 780);
  });
}

function setButtons(connected) {
  els.connect.disabled = connected;
  els.grant.disabled = !connected || Boolean(echoCapId);
  els.denied.disabled = !connected;
  els.disconnect.disabled = !connected;
  els.allowed.disabled = !connected || !echoCapId;
}

function setControlLabels(label) {
  els.grant.textContent = echoCapId ? `${label} holds Echo cap` : `grant ${label} -> Echo`;
  els.allowed.textContent = `call Echo as ${label}`;
  els.denied.textContent = `fake cap as ${label}`;
}

function resetControlLabels() {
  els.grant.textContent = "grant tab -> Echo";
  els.allowed.textContent = "call Echo";
  els.denied.textContent = "try fake cap";
}

els.connect.addEventListener("click", connect);
els.grant.addEventListener("click", requestGrant);
els.allowed.addEventListener("click", allowedCall);
els.denied.addEventListener("click", deniedCall);
els.disconnect.addEventListener("click", disconnect);

connect();
