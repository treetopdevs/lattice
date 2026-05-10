const api = "/api/flagship";
const graphEl = document.querySelector("#graph");
const detailEl = document.querySelector("#detail");
const rawJsonEl = document.querySelector("#rawJson");
let snapshot = null;
let selected = null;

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    await post(button.dataset.action);
  });
});

document.querySelector("#runAll").addEventListener("click", () => post("run_all"));
document.querySelector("#refreshJson").addEventListener("click", () => {
  rawJsonEl.value = JSON.stringify(snapshot, null, 2);
});

await refresh();
setInterval(refresh, 900);

async function post(action) {
  setBusy(true);
  try {
    const response = await fetch(`${api}/${action}`, { method: "POST" });
    snapshot = await response.json();
    render();
  } finally {
    setBusy(false);
  }
}

async function refresh() {
  try {
    const response = await fetch(`${api}/snapshot`);
    snapshot = await response.json();
    document.querySelector("#connectionStatus").textContent = "live polling";
    render();
  } catch (_error) {
    document.querySelector("#connectionStatus").textContent = "offline";
  }
}

function setBusy(busy) {
  document.body.toggleAttribute("aria-busy", busy);
}

function render() {
  if (!snapshot) return;
  document.querySelector("#policyStatus").textContent = `${snapshot.graph.policy.status} graph policy`;
  document.querySelector("#auditCount").textContent = `${snapshot.audit_events.length} audit events`;
  renderStory();
  renderGraph();
  renderWallet();
  renderAudit();
  renderClaims();
  rawJsonEl.value = JSON.stringify(snapshot, null, 2);
}

function renderStory() {
  const list = document.querySelector("#storySteps");
  list.replaceChildren(
    ...snapshot.story.map((step) => {
      const item = document.createElement("li");
      item.className = `step ${step.status}`;
      item.innerHTML = `<strong>${escapeHtml(step.label)}</strong><span>${escapeHtml(step.detail)}</span>`;
      return item;
    }),
  );
}

function renderWallet() {
  const ledger = document.querySelector("#walletLedger");
  const entries = snapshot.wallet.ledger;
  if (!entries.length) {
    ledger.textContent = "No wallet deliveries yet.";
    return;
  }

  ledger.replaceChildren(
    ...entries.map((entry) => {
      const row = document.createElement("div");
      row.className = "ledger-row";
      row.textContent = `$${entry.amount} ${entry.vendor} ${entry.item || ""}`;
      return row;
    }),
  );
}

function renderAudit() {
  const list = document.querySelector("#auditTrail");
  list.replaceChildren(
    ...snapshot.audit_events.slice(-14).reverse().map((event) => {
      const item = document.createElement("li");
      item.className = `audit ${event.type}`;
      item.textContent = `${event.id}. ${event.type} ${summarize(event.metadata)}`;
      item.addEventListener("click", () => showDetail("audit", event));
      return item;
    }),
  );
}

function renderClaims() {
  const table = document.querySelector("#claimsTable");
  table.replaceChildren(
    ...snapshot.claims.map((claim) => {
      const row = document.createElement("tr");
      row.innerHTML = `<td>${escapeHtml(claim.claim)}</td><td><span class="claim ${claim.status}">${escapeHtml(
        claim.status,
      )}</span></td><td>${escapeHtml(claim.evidence)}</td>`;
      return row;
    }),
  );
}

function renderGraph() {
  const graph = snapshot.graph;
  const nodes = visibleNodes(graph.nodes);
  const edges = graph.edges.filter((edge) => includeEdge(edge, nodes));
  const positions = layout(nodes);
  graphEl.setAttribute("viewBox", "0 0 1120 620");
  graphEl.replaceChildren(markerDefs(), ...edges.map((edge) => edgeSvg(edge, positions)), ...nodes.map((node) => nodeSvg(node, positions)));
}

function visibleNodes(nodes) {
  const ranked = nodes.filter((node) => {
    const kind = node.kind || node["kind"];
    return ["realm", "tab", "gateway", "cap_store", "audit", "server_process", "capability", "bridge", "supervisor"].includes(kind);
  });
  return ranked.slice(0, 30);
}

function includeEdge(edge, nodes) {
  const ids = new Set(nodes.map((node) => node.id || node["id"]));
  return ids.has(edge.from || edge["from"]) && ids.has(edge.to || edge["to"]);
}

function layout(nodes) {
  const columns = [
    ["realm", "tab"],
    ["gateway", "cap_store", "audit", "supervisor"],
    ["capability", "bridge"],
    ["server_process"],
  ];
  const byId = new Map();
  columns.forEach((kinds, col) => {
    const columnNodes = nodes.filter((node) => kinds.includes(node.kind || node["kind"]));
    columnNodes.forEach((node, row) => {
      byId.set(node.id || node["id"], {
        x: 110 + col * 300,
        y: 90 + row * Math.min(96, Math.max(52, 420 / Math.max(columnNodes.length, 1))),
      });
    });
  });
  return byId;
}

function edgeSvg(edge, positions) {
  const from = positions.get(edge.from || edge["from"]);
  const to = positions.get(edge.to || edge["to"]);
  const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const dx = Math.max((to.x - from.x) * 0.45, 48);
  line.setAttribute("d", `M ${from.x + 72} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x - 72} ${to.y}`);
  line.setAttribute("class", `edge ${edgeClass(edge)}`);
  line.setAttribute("marker-end", "url(#arrow)");
  line.addEventListener("click", () => showDetail("edge", edge));
  const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
  title.textContent = `${edge.kind || edge["kind"]} ${edge.reason || ""}`;
  line.appendChild(title);
  return line;
}

function nodeSvg(node, positions) {
  const id = node.id || node["id"];
  const pos = positions.get(id);
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("class", `node ${node.kind || node["kind"]} ${node.status || node.lifecycle_state || ""}`);
  group.setAttribute("transform", `translate(${pos.x}, ${pos.y})`);
  group.addEventListener("click", () => showDetail("node", node));

  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", "-76");
  rect.setAttribute("y", "-26");
  rect.setAttribute("width", "152");
  rect.setAttribute("height", "52");
  rect.setAttribute("rx", "8");

  const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
  title.setAttribute("text-anchor", "middle");
  title.setAttribute("y", "-3");
  title.textContent = shortLabel(node.label || node["label"] || id);

  const sub = document.createElementNS("http://www.w3.org/2000/svg", "text");
  sub.setAttribute("text-anchor", "middle");
  sub.setAttribute("y", "16");
  sub.setAttribute("class", "node-kind");
  sub.textContent = node.kind || node["kind"];

  group.append(rect, title, sub);
  return group;
}

function markerDefs() {
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>`;
  return defs;
}

function edgeClass(edge) {
  const status = edge.status || edge["status"];
  const kind = edge.kind || edge["kind"];
  if (kind === "denied_attempt" || status === "denied") return "denied";
  if (kind === "revoked" || status === "revoked") return "revoked";
  if (status === "expired") return "expired";
  return "allowed";
}

function showDetail(type, value) {
  selected = { type, value };
  detailEl.innerHTML = `<strong>${type}</strong><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function summarize(metadata) {
  const reason = metadata.reason ? `reason=${metadata.reason}` : "";
  const cap = metadata.cap_id ? `cap=${String(metadata.cap_id).slice(0, 8)}` : "";
  const tab = metadata.tab_id ? `tab=${String(metadata.tab_id).slice(0, 8)}` : "";
  return [reason, cap, tab].filter(Boolean).join(" ");
}

function shortLabel(label) {
  const text = String(label);
  if (text.length <= 24) return text;
  return `${text.slice(0, 21)}...`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
