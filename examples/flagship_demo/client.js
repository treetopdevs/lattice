const api = "/api/flagship";
const graphEl = document.querySelector("#graph");
const detailEl = document.querySelector("#detail");
const rawJsonEl = document.querySelector("#rawJson");
const controlsEl = document.querySelector("#controls");
let snapshot = null;
let selected = null;
let suppressRefreshUntil = 0;

document.querySelector("#refreshJson").addEventListener("click", () => {
  rawJsonEl.value = JSON.stringify(snapshot, null, 2);
});

await refresh();
setInterval(refresh, 900);

async function post(action) {
  setBusy(true);
  try {
    const response = await fetch(`${api}/${action}`, {
      method: "POST",
      credentials: "same-origin",
    });
    snapshot = await response.json();
    suppressRefreshUntil = Date.now() + 700;
    render();
  } finally {
    setBusy(false);
  }
}

async function refresh() {
  if (Date.now() < suppressRefreshUntil) return;

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
  renderPresenter();
  renderControls();
  renderStory();
  renderGraph();
  renderWallet();
  renderEdgeList();
  renderAudit();
  renderClaims();
  rawJsonEl.value = JSON.stringify(snapshot, null, 2);
}

function renderPresenter() {
  const presenter = snapshot.presenter || {};
  document.querySelector("#presenterTitle").textContent = presenter.headline || "Ready";
  document.querySelector("#presenterCopy").textContent = presenter.narration || "";
  document.querySelector("#scenarioInvariant").textContent = presenter.invariant || "";
  document.querySelector("#nextAction").textContent = presenter.next_action || "";
}

function renderControls() {
  controlsEl.replaceChildren(
    ...(snapshot.actions || []).map((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action.action;
      button.textContent = action.label;
      if (action.primary) button.className = "primary";
      button.addEventListener("click", () => post(action.action));
      return button;
    }),
  );
}

function renderStory() {
  const list = document.querySelector("#storySteps");
  list.replaceChildren(
    ...snapshot.story.map((step) => {
      const item = document.createElement("li");
      item.className = `step ${step.status} ${step.active ? "active" : ""}`;
      item.innerHTML = `<small>Step ${escapeHtml(step.step_number)}</small><strong>${escapeHtml(
        step.label,
      )}</strong><span>${escapeHtml(step.detail)}</span>`;
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

function renderEdgeList() {
  const list = document.querySelector("#edgeList");
  const decisionEdgeKinds = new Set(graphUi().decision_edge_kinds);
  const decisionEdges = snapshot.graph.edges
    .filter((edge) => decisionEdgeKinds.has(edge.kind))
    .slice(-12)
    .reverse();

  if (!decisionEdges.length) {
    list.textContent = "No decision edges yet.";
    return;
  }

  list.replaceChildren(
    ...decisionEdges.map((edge) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = `edge-choice ${edgeClass(edge)}`;
      button.textContent = edgeChoiceLabel(edge);
      button.addEventListener("click", () => showDetail("edge", edge));
      item.append(button);
      return item;
    }),
  );
}

function renderClaims() {
  const table = document.querySelector("#claimsTable");
  document.querySelector("#claimsSource").textContent = `${snapshot.claims.length} code-owned claims`;
  table.replaceChildren(
    ...snapshot.claims.map((claim) => {
      const row = document.createElement("tr");
      row.innerHTML = `<td>${escapeHtml(claim.claim)}</td><td><span class="claim ${claim.status}">${escapeHtml(
        claim.status,
      )}</span></td><td>${escapeHtml(claim.evidence)}<small>${escapeHtml(
        (claim.evidence_refs || []).join(" | "),
      )}</small></td>`;
      return row;
    }),
  );
}

function renderGraph() {
  const graph = snapshot.graph;
  const nodes = visibleNodes(graph.nodes, graph.ui);
  const edges = graph.edges.filter((edge) => includeEdge(edge, nodes)).sort((a, b) => edgeRank(a) - edgeRank(b));
  const positions = layout(nodes, graph.ui);
  graphEl.setAttribute("viewBox", "0 0 1120 620");
  graphEl.replaceChildren(
    markerDefs(),
    ...edges.map((edge, index) => edgeSvg(edge, positions, index)),
    ...nodes.map((node) => nodeSvg(node, positions)),
  );
}

function visibleNodes(nodes, ui) {
  const visibleKinds = new Set(ui.visible_node_kinds);
  const ranked = nodes.filter((node) => {
    const kind = node.kind;
    return visibleKinds.has(kind);
  });
  return ranked.slice(0, 30);
}

function includeEdge(edge, nodes) {
  const ids = new Set(nodes.map((node) => node.id));
  return ids.has(edge.from) && ids.has(edge.to);
}

function layout(nodes, ui) {
  const byId = new Map();
  ui.node_columns.forEach((column, col) => {
    const kinds = new Set(column.kinds);
    const columnNodes = nodes.filter((node) => kinds.has(node.kind));
    columnNodes.forEach((node, row) => {
      byId.set(node.id, {
        x: 110 + col * 300,
        y: 90 + row * Math.min(96, Math.max(52, 420 / Math.max(columnNodes.length, 1))),
      });
    });
  });
  return byId;
}

function edgeSvg(edge, positions, index) {
  const from = positions.get(edge.from);
  const to = positions.get(edge.to);
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const dx = Math.max((to.x - from.x) * 0.45, 48);
  const path = `M ${from.x + 72} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x - 72} ${to.y}`;
  const lane = (index % 7) - 3;
  const labelX = (from.x + to.x) / 2 + lane * 18;
  const labelY = (from.y + to.y) / 2 - 9 + lane * 13;
  group.setAttribute("class", `edge ${edgeClass(edge)}`);
  if (selectedKey() === edgeKey(edge)) group.classList.add("selected");

  const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
  hit.setAttribute("d", path);
  hit.setAttribute("class", "edge-hit");

  line.setAttribute("d", path);
  line.setAttribute("class", "edge-line");
  line.setAttribute("marker-end", "url(#arrow)");
  group.addEventListener("click", () => showDetail("edge", edge));

  const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
  title.textContent = `${edge.kind} ${edge.reason || ""}`;

  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("class", "edge-label");
  label.setAttribute("x", labelX);
  label.setAttribute("y", labelY);
  label.textContent = shortEdgeLabel(edge);

  group.append(title, hit, line, label);
  return group;
}

function nodeSvg(node, positions) {
  const id = node.id;
  const pos = positions.get(id);
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("class", `node ${node.kind} ${node.status || node.lifecycle_state || ""}`);
  if (selectedKey() === nodeKey(node)) group.classList.add("selected");
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
  title.textContent = shortLabel(node.label || id);

  const sub = document.createElementNS("http://www.w3.org/2000/svg", "text");
  sub.setAttribute("text-anchor", "middle");
  sub.setAttribute("y", "16");
  sub.setAttribute("class", "node-kind");
  sub.textContent = node.kind;

  group.append(rect, title, sub);
  return group;
}

function markerDefs() {
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>`;
  return defs;
}

function edgeClass(edge) {
  const match = graphUi().edge_classes.find((rule) => {
    return (rule.kinds || []).includes(edge.kind) || (rule.statuses || []).includes(edge.status);
  });

  return match?.class || "allowed";
}

function edgeRank(edge) {
  const className = edgeClass(edge);
  if (className === "allowed") return 0;
  if (className === "revoked" || className === "expired") return 1;
  return 2;
}

function showDetail(type, value) {
  selected = { type, value, key: type === "edge" ? edgeKey(value) : nodeKey(value) };
  suppressRefreshUntil = Date.now() + 3_000;
  detailEl.innerHTML = detailHtml(type, value);
  renderGraph();
}

function detailHtml(type, value) {
  if (type === "edge") return edgeDetail(value);
  if (value.kind === "capability") return capabilityDetail(value);
  return genericDetail(type, value);
}

function capabilityDetail(node) {
  const caveats = node.caveats || [];
  return `<strong>capability node</strong>${detailList({
    status: node.status || node.lifecycle_state,
    owner: node.owner_tab_id,
    target: node.target,
    operations: (node.ops || []).join(", "),
    provenance: summarizeMap(node.provenance),
    "audit events": (node.audit_event_ids || []).join(", ") || "none",
  })}<h4>Caveats</h4><ul class="detail-list">${caveats
    .map((caveat) => `<li>${escapeHtml(summarizeMap(caveat))}</li>`)
    .join("")}</ul><pre>${escapeHtml(JSON.stringify(node, null, 2))}</pre>`;
}

function edgeDetail(edge) {
  const denial = edge.reason ? `Denial reason: ${edge.reason}` : "No denial reason on this edge.";
  return `<strong>${escapeHtml(edge.kind)} edge</strong>${detailList({
    status: edge.status || "live",
    from: edge.from,
    to: edge.to,
    cap: edge.cap_id || "none",
    "audit event": edge.audit_event_id || (edge.audit_event_ids || []).join(", ") || "none",
    reason: edge.reason || "none",
  })}<p class="decision-note">${escapeHtml(denial)}</p><pre>${escapeHtml(JSON.stringify(edge, null, 2))}</pre>`;
}

function genericDetail(type, value) {
  return `<strong>${escapeHtml(type)}</strong>${detailList({
    kind: value.kind || value.type,
    status: value.status || value.lifecycle_state || "n/a",
    realm: value.realm || "n/a",
    "audit events": (value.audit_event_ids || []).join(", ") || "none",
  })}<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function detailList(entries) {
  return `<dl class="detail-grid">${Object.entries(entries)
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("")}</dl>`;
}

function summarizeMap(value) {
  if (!value) return "none";
  if (typeof value !== "object") return String(value);
  return Object.entries(value)
    .map(([key, item]) => `${key}=${Array.isArray(item) ? item.join(",") : item}`)
    .join(" ");
}

function nodeKey(node) {
  return `node:${node.id}`;
}

function edgeKey(edge) {
  return `edge:${edge.from}:${edge.to}:${edge.kind}:${edge.audit_event_id || edge.reason || ""}`;
}

function selectedKey() {
  return selected?.key;
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

function shortEdgeLabel(edge) {
  if (edge.kind === "denied_attempt") return edge.reason ? `denied: ${String(edge.reason).replaceAll(":", "")}` : "denied";
  return graphUi().edge_labels[edge.kind] || edge.kind;
}

function edgeChoiceLabel(edge) {
  const kind = edge.kind;
  const status = edge.status || "live";
  const reason = edge.reason ? `, ${edge.reason}` : "";
  const audit = edge.audit_event_id ? `, audit ${edge.audit_event_id}` : "";
  return `${kind}, ${status}${reason}${audit}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function graphUi() {
  return snapshot.graph.ui;
}
