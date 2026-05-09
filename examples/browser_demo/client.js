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
let autoRan = false;
let ledger = [];

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

  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  ws = new WebSocket(url);
  els.connectionState.textContent = "connecting";
  setButtons(false);

  ws.addEventListener("open", () => {
    send({ type: "hello", identity: { surface: "browser-demo", color: "green" } });
  });

  ws.addEventListener("message", (event) => {
    handleMessage(JSON.parse(event.data));
  });

  ws.addEventListener("close", () => {
    els.connectionState.textContent = "offline";
    tabId = undefined;
    echoCapId = undefined;
    autoRan = false;
    setButtons(false);
    document.body.classList.remove("is-connected");
  });
}

function send(envelope) {
  ws.send(JSON.stringify(envelope));
}

function handleMessage(msg) {
  if (msg.type === "welcome") {
    tabId = msg.tab_id;
    els.connectionState.textContent = "online";
    els.tabBadge.textContent = shortId(tabId);
    els.selfId.textContent = shortId(tabId);
    els.selfStatus.textContent = "this tab";
    document.body.classList.add("is-connected");
    setButtons(true);
    send({ type: "state_request" });

    if (!autoRan) {
      autoRan = true;
      window.setTimeout(requestGrant, 550);
    }
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
    els.capState.textContent = "cap open";
    els.allowed.disabled = false;
    pulse("grant");
    window.setTimeout(allowedCall, 750);
    window.setTimeout(deniedCall, 1350);
  }

  if (msg.type === "call_result") {
    pulse(msg.ok ? "call" : "deny");
  }

  if (msg.type === "tab_call") {
    pulse("incoming");

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
  send({ type: "disconnect" });
}

function renderPresence(tabs, auditCount) {
  const self = tabs.find((tab) => tab.id === tabId);
  const peer = tabs.find((tab) => tab.id !== tabId);

  els.auditBadge.textContent = `audit ${auditCount}`;
  els.tabCount.textContent = `${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}`;

  if (self) {
    els.selfLetter.textContent = self.label || "A";
    els.selfNode.style.setProperty("--realm-hue", self.hue || 152);
  }

  if (peer) {
    els.peerLetter.textContent = peer.label || "B";
    els.peerId.textContent = shortId(peer.id);
    els.peerStatus.textContent = "peer tab";
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
  ledger = [event, ...ledger].slice(0, 9);
  drawLedger();
  pulse(event.kind);
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

      const route = document.createElement("span");
      route.className = "ledger-route";
      route.textContent = routeText(event);

      const id = document.createElement("code");
      id.textContent = String(event.id).padStart(2, "0");

      item.append(glyph, route, id);
      return item;
    }),
  );
}

function routeText(event) {
  const data = event.data || {};
  const from = shortId(data.from_tab_id || data.tab_id);
  const to = data.to_tab_id ? ` -> ${shortId(data.to_tab_id)}` : "";
  return `${from}${to}`;
}

function pulse(kind) {
  const className =
    {
      grant: "pulse-grant",
      call: "pulse-call",
      deny: "pulse-deny",
      bridge_intent: "pulse-bridge",
      bridge_open: "pulse-bridge",
      bridge_result: "pulse-return",
      incoming: "pulse-incoming",
      tab_render_result: "pulse-return",
    }[kind] || "pulse-server";

  document.body.classList.remove(
    "pulse-grant",
    "pulse-call",
    "pulse-deny",
    "pulse-bridge",
    "pulse-return",
    "pulse-incoming",
    "pulse-server",
  );

  window.requestAnimationFrame(() => {
    document.body.classList.add(className);
    window.setTimeout(() => document.body.classList.remove(className), 780);
  });
}

function setButtons(connected) {
  els.connect.disabled = connected;
  els.grant.disabled = !connected;
  els.denied.disabled = !connected;
  els.disconnect.disabled = !connected;
  els.allowed.disabled = !connected || !echoCapId;
}

els.connect.addEventListener("click", connect);
els.grant.addEventListener("click", requestGrant);
els.allowed.addEventListener("click", allowedCall);
els.denied.addEventListener("click", deniedCall);
els.disconnect.addEventListener("click", disconnect);

connect();
