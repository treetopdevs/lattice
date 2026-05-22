const els = {
  connectionState: document.querySelector("#connectionState"),
  roleBadge: document.querySelector("#roleBadge"),
  auditCount: document.querySelector("#auditCount"),
  denialCount: document.querySelector("#denialCount"),
  serverStatus: document.querySelector("#serverStatus"),
  onAirText: document.querySelector("#onAirText"),
  actorLayer: document.querySelector("#actorLayer"),
  capLayer: document.querySelector("#capLayer"),
  deviceLayer: document.querySelector("#deviceLayer"),
  ledgerClock: document.querySelector("#ledgerClock"),
  ledgerList: document.querySelector("#ledgerList"),
  previewOverlay: document.querySelector("#previewOverlay"),
  requestPublish: document.querySelector("#requestPublish"),
  publishOverlay: document.querySelector("#publishOverlay"),
  replayPublish: document.querySelector("#replayPublish"),
  renderGraphics: document.querySelector("#renderGraphics"),
  approvePublish: document.querySelector("#approvePublish"),
  approveExpired: document.querySelector("#approveExpired"),
  revokePublish: document.querySelector("#revokePublish"),
  monitorPreview: document.querySelector("#monitorPreview"),
  cameraFrame: document.querySelector("#cameraFrame"),
  tallyLight: document.querySelector("#tallyLight"),
  staleCamera: document.querySelector("#staleCamera"),
  observerPublish: document.querySelector("#observerPublish"),
  connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"),
};

const params = new URLSearchParams(location.search);
const role = params.get("role") || "observer";
const overlay = params.get("overlay") || "Lower third: Field Report";

let ws;
let tabId;
let manualDisconnect = false;
let liveops = emptyLiveOps();
let capsByAction = new Map();
let staleCapsByAction = new Map();
let lastPublishCapId;
let lastPublishApprovalId;
let lastCameraCapId;

document.body.dataset.role = role;
els.roleBadge.textContent = role.replace("_", " ");

function emptyLiveOps() {
  return {
    actors: [],
    caps: [],
    approvals: [],
    operations: [],
    events: [],
    counters: { audit: 0, denials: 0, actors: 0 },
  };
}

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  manualDisconnect = false;
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  ws = new WebSocket(url);
  els.connectionState.textContent = "connecting";
  renderControls();

  ws.addEventListener("open", () => {
    send({
      type: "hello",
      identity: {
        surface: "liveops-demo",
        role,
        client_id: clientId(),
      },
      client_id: clientId(),
    });
  });

  ws.addEventListener("message", (event) => {
    handleMessage(JSON.parse(event.data));
  });

  ws.addEventListener("close", () => {
    els.connectionState.textContent = "offline";
    tabId = undefined;
    capsByAction = new Map();
    document.body.classList.remove("is-connected");
    renderControls();
  });
}

function clientId() {
  const key = `lattice.liveops.${role}.client_id`;
  let value = window.sessionStorage.getItem(key);

  if (!value) {
    value =
      window.crypto && window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    window.sessionStorage.setItem(key, value);
  }

  return value;
}

function send(envelope) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(envelope));
}

function handleMessage(msg) {
  if (msg.type === "welcome") {
    tabId = msg.tab_id;
    els.connectionState.textContent = "online";
    document.body.classList.add("is-connected");
    send({ type: "state_request" });
  }

  if (msg.liveops) {
    liveops = msg.liveops;
    indexCaps();
    render();
  }

  if (msg.type === "snapshot" && msg.liveops) {
    liveops = msg.liveops;
    indexCaps();
    render();
  }

  if (msg.type === "liveops_result" && !msg.ok) {
    pulse("denied");
  }

  if (msg.type === "disconnect_result") {
    ws.close();
  }
}

function indexCaps() {
  capsByAction = new Map();
  const me = myActor();
  if (!me) return;

  for (const cap of me.caps || []) {
    capsByAction.set(cap.action, cap);
    if (cap.action === "publish") {
      lastPublishCapId = cap.id;
      lastPublishApprovalId = cap.approval_id;
    }
    if (cap.action === "camera_frame") lastCameraCapId = cap.id;
  }
}

function myActor() {
  return liveops.actors.find((actor) => actor.tab_id === tabId);
}

function firstPendingApproval() {
  return liveops.approvals.find((approval) => approval.status === "pending");
}

function latestPublishApproval() {
  return [...liveops.approvals].reverse().find((approval) => approval.publish_cap_id);
}

function sendAction(action, payload = {}, capAction = action, capIdOverride) {
  const cap = capIdOverride ? { id: capIdOverride } : capsByAction.get(capAction);
  send({
    type: "liveops_action",
    action,
    cap_id: cap ? cap.id : `missing-${action}`,
    payload,
  });
}

function render() {
  els.auditCount.textContent = `audit ${liveops.counters.audit || 0}`;
  els.denialCount.textContent = `denials ${liveops.counters.denials || 0}`;
  els.serverStatus.textContent = `${liveops.counters.actors || 0} actors`;

  const latestPublish = [...(liveops.operations || [])]
    .reverse()
    .find((operation) => operation.action === "publish");
  els.onAirText.textContent = latestPublish ? "on air: lower third" : "preview idle";

  renderActors();
  renderCaps();
  renderDevices();
  renderLedger();
  renderControls();
}

function renderActors() {
  els.actorLayer.replaceChildren(
    ...liveops.actors.map((actor) => {
      const node = document.createElement("article");
      node.className = "actor-node";
      node.dataset.testid = `actor-${actor.role}`;
      node.dataset.role = actor.role;
      node.style.setProperty("--actor-color", actor.color);

      const title = document.createElement("strong");
      title.textContent = actor.label;

      const roleLabel = document.createElement("span");
      roleLabel.className = "role-label";
      roleLabel.textContent = actor.role.replace("_", " ");

      const id = document.createElement("code");
      id.textContent = shortId(actor.tab_id);

      node.append(title, roleLabel, id);
      return node;
    }),
  );
}

function renderCaps() {
  els.capLayer.replaceChildren(
    ...liveops.caps.map((cap) => {
      const edge = document.createElement("div");
      edge.className = "cap-edge";
      edge.dataset.testid = `cap-${cap.action}`;
      edge.dataset.action = cap.action;
      edge.dataset.status = cap.status;
      edge.dataset.owner = cap.owner_tab_id;
      if (cap.expires_in_ms !== null && cap.expires_in_ms !== undefined) {
        edge.dataset.expiresIn = String(cap.expires_in_ms);
      }

      const action = document.createElement("strong");
      action.textContent = cap.action.replace("_", " ");

      const detail = document.createElement("span");
      detail.textContent = `${shortId(cap.owner_tab_id)} -> ${cap.target}`;

      const status = document.createElement("code");
      status.textContent =
        cap.expires_in_ms === null || cap.expires_in_ms === undefined
          ? cap.status
          : `${cap.status} ${Math.ceil(cap.expires_in_ms / 1000)}s`;

      edge.append(action, detail, status);
      return edge;
    }),
  );
}

function renderDevices() {
  const devices = liveops.actors.flatMap((actor) => actor.devices || []);

  els.deviceLayer.replaceChildren(
    ...devices.map((device) => {
      const node = document.createElement("div");
      node.className = "device-node";
      node.dataset.testid = `device-${device.kind}`;
      node.dataset.kind = device.kind;

      const title = document.createElement("strong");
      title.textContent = device.kind.replace("_", " ");

      const id = document.createElement("code");
      id.textContent = shortId(device.id);

      node.append(title, id);
      return node;
    }),
  );
}

function renderLedger() {
  els.ledgerClock.textContent = new Date().toLocaleTimeString();
  const events = [...(liveops.events || [])].reverse().slice(0, 12);

  els.ledgerList.replaceChildren(
    ...events.map((event) => {
      const item = document.createElement("li");
      item.className = `ledger-item event-${event.kind}`;
      item.dataset.testid = `event-${event.kind}`;

      const title = document.createElement("strong");
      title.textContent = eventTitle(event);

      const detail = document.createElement("span");
      detail.textContent = eventDetail(event);

      const id = document.createElement("code");
      id.textContent = String(event.id).padStart(2, "0");

      item.append(title, detail, id);
      return item;
    }),
  );
}

function renderControls() {
  const connected = Boolean(tabId && ws && ws.readyState === WebSocket.OPEN);
  const pending = firstPendingApproval();
  const publishCap = capsByAction.get("publish");

  setEnabled(els.connect, !connected);
  setEnabled(els.disconnect, connected);
  setEnabled(els.previewOverlay, connected && capsByAction.has("preview_overlay"));
  setEnabled(els.requestPublish, connected && capsByAction.has("request_publish"));
  setEnabled(
    els.publishOverlay,
    connected && (Boolean(publishCap && publishCap.status === "active") || capsByAction.has("request_publish")),
  );
  setEnabled(els.replayPublish, connected && Boolean(lastPublishCapId));
  setEnabled(els.renderGraphics, connected && capsByAction.has("render_graphics"));
  setEnabled(els.approvePublish, connected && capsByAction.has("approve_publish") && Boolean(pending));
  setEnabled(els.approveExpired, connected && capsByAction.has("approve_publish") && Boolean(pending));
  setEnabled(els.revokePublish, connected && capsByAction.has("revoke_publish") && Boolean(latestPublishApproval()));
  setEnabled(els.monitorPreview, connected && capsByAction.has("monitor_preview"));
  setEnabled(els.cameraFrame, connected && capsByAction.has("camera_frame"));
  setEnabled(els.tallyLight, connected && capsByAction.has("set_tally"));
  setEnabled(els.staleCamera, connected && Boolean(lastCameraCapId || staleCapsByAction.has("camera_frame")));
  setEnabled(els.observerPublish, connected && capsByAction.has("observe"));
}

function setEnabled(button, enabled) {
  button.disabled = !enabled;
}

function eventTitle(event) {
  const data = event.data || {};
  const kind = String(event.kind || "").replace("liveops_", "").replaceAll("_", " ");

  if (event.kind === "liveops_actor_joined") return `${data.role} joined`;
  if (event.kind === "liveops_cap_granted") return `${data.action} cap granted`;
  if (event.kind === "liveops_approval_requested") return "publish approval requested";
  if (event.kind === "liveops_approval_granted") return "publish approval granted";
  if (event.kind === "liveops_operation_pulse")
    return `${String(data.action || "").replaceAll("_", " ")} operation`;
  if (event.kind === "liveops_denied") return `${data.action} denied`;
  if (event.kind === "liveops_cleanup") return "tab cleanup";
  if (event.kind === "liveops_device_operation") return `${data.device_id} operation`;
  return kind;
}

function eventDetail(event) {
  const data = event.data || {};
  if (event.kind === "liveops_denied") return `${shortId(data.tab_id)} ${data.reason}`;
  if (data.cap_id) return `${shortId(data.tab_id)} cap ${shortId(data.cap_id)}`;
  if (data.approval_id) return data.approval_id;
  if (data.device_id) return data.device_id;
  return shortId(data.tab_id || data.operator_tab_id || data.producer_tab_id);
}

function shortId(value) {
  return value ? String(value).slice(0, 8) : "server";
}

function pulse(kind) {
  document.body.classList.remove("pulse-denied", "pulse-ok");
  window.requestAnimationFrame(() => {
    document.body.classList.add(kind === "denied" ? "pulse-denied" : "pulse-ok");
    window.setTimeout(() => document.body.classList.remove("pulse-denied", "pulse-ok"), 700);
  });
}

els.previewOverlay.addEventListener("click", () => {
  sendAction("preview_overlay", { overlay });
});

els.requestPublish.addEventListener("click", () => {
  sendAction("request_publish", { overlay });
});

els.publishOverlay.addEventListener("click", () => {
  const cap = capsByAction.get("publish");
  const approvalId = cap && cap.approval_id;
  sendAction("publish", { overlay, request_id: approvalId }, "publish");
});

els.replayPublish.addEventListener("click", () => {
  const approvalId = lastPublishApprovalId || latestPublishApproval()?.id;
  sendAction("publish", { overlay, request_id: approvalId }, "publish", lastPublishCapId);
});

els.renderGraphics.addEventListener("click", () => {
  sendAction("render_graphics", { overlay }, "render_graphics");
});

els.approvePublish.addEventListener("click", () => {
  const approval = firstPendingApproval();
  if (approval) sendAction("approve_publish", { request_id: approval.id, ttl_ms: 30000 });
});

els.approveExpired.addEventListener("click", () => {
  const approval = firstPendingApproval();
  if (approval) sendAction("approve_publish", { request_id: approval.id, ttl_ms: -1 });
});

els.revokePublish.addEventListener("click", () => {
  const approval = latestPublishApproval();
  if (approval) sendAction("revoke_publish", { request_id: approval.id });
});

els.monitorPreview.addEventListener("click", () => {
  sendAction("monitor_preview", { overlay }, "monitor_preview");
});

els.cameraFrame.addEventListener("click", () => {
  sendAction("camera_frame", { frame: `frame-${Date.now()}` }, "camera_frame");
});

els.tallyLight.addEventListener("click", () => {
  sendAction("set_tally", { state: "on-air" }, "set_tally");
});

els.staleCamera.addEventListener("click", () => {
  const stale = staleCapsByAction.get("camera_frame");
  sendAction("camera_frame", { frame: "stale-replay" }, "camera_frame", stale?.id || lastCameraCapId);
});

els.observerPublish.addEventListener("click", () => {
  const approval = latestPublishApproval() || firstPendingApproval();
  sendAction("publish", { request_id: approval?.id || "wrong-role" }, "observe");
});

els.connect.addEventListener("click", connect);
els.disconnect.addEventListener("click", () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  manualDisconnect = true;
  for (const [action, cap] of capsByAction) staleCapsByAction.set(action, cap);
  send({ type: "disconnect" });
});

window.__liveopsTest = {
  state: () => liveops,
  cap: (action) => capsByAction.get(action),
};

connect();
