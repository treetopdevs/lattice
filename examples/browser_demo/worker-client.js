let ws;
let tabId;
let workerName = "worker";
let clientId;

const pendingCommands = [];

self.addEventListener("message", (event) => {
  const command = event.data || {};

  if (command.type === "connect") {
    workerName = command.name || workerName;
    clientId = command.client_id || makeClientId(workerName);
    connect();
    return;
  }

  if (command.type === "disconnect") {
    send({ type: "disconnect" });
    return;
  }

  if (command.type === "grant_request") {
    send({ type: "grant_request", target: command.target });
    return;
  }

  if (command.type === "call") {
    send({
      type: "call",
      cap_id: command.cap_id,
      payload: command.payload || {},
      target: command.target,
    });
  }
});

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const url = `${self.location.protocol === "https:" ? "wss" : "ws"}://${self.location.host}/ws`;
  ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    self.postMessage({ type: "worker_open", worker: workerName });
    send({
      type: "hello",
      client_id: clientId,
      identity: {
        surface: "browser-worker-demo",
        worker: workerName,
        client_id: clientId,
      },
    });
    flushPendingCommands();
  });

  ws.addEventListener("message", (event) => {
    handleEnvelope(JSON.parse(event.data));
  });

  ws.addEventListener("close", () => {
    self.postMessage({ type: "worker_closed", worker: workerName, tab_id: tabId });
    tabId = undefined;
  });

  ws.addEventListener("error", () => {
    self.postMessage({ type: "worker_error", worker: workerName });
  });
}

function send(envelope) {
  if (!ws || ws.readyState === WebSocket.CONNECTING) {
    pendingCommands.push(envelope);
    return;
  }

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(envelope));
  }
}

function flushPendingCommands() {
  while (pendingCommands.length > 0 && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(pendingCommands.shift()));
  }
}

function handleEnvelope(message) {
  if (message.type === "welcome") {
    tabId = message.tab_id;
  }

  if (message.type === "tab_call") {
    const result = renderWorkerResult(message);
    self.postMessage({ type: "tab_call", worker: workerName, tab_id: tabId, payload: message.payload, result });

    send({
      type: "tab_render_result",
      request_id: message.request_id,
      result,
    });

    return;
  }

  self.postMessage({ ...message, worker: workerName, tab_id: tabId });
}

function renderWorkerResult(message) {
  const payload = message.payload || {};

  return {
    realm: "browser_worker",
    worker: workerName,
    received_by: tabId,
    from_tab_id: message.from_tab_id,
    op: payload.op,
    worker_b_received: payload.body || payload.pulse,
  };
}

function makeClientId(name) {
  const suffix =
    self.crypto && self.crypto.randomUUID
      ? self.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return `worker-${name}-${suffix}`;
}
