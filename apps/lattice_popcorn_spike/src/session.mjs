const INGRESS = "Elixir.LatticeBrowser.Bridge";
const MAX_PENDING = 32;
const boundedString = (value, limit) => typeof value === "string" && value.length <= limit && new TextEncoder().encode(value).length <= limit;

// The VM and its generic process API stay in this closure, never on window.
export function createSession({ createVM, openSocket, onEvent = () => {}, heartbeatMs = 1000 }) {
  let vm, socket, heartbeat, closed = false, started = false, pending = 0;
  let tail = Promise.resolve();
  let healthPending = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    socket?.close();
    vm?.deinit();
  };
  const enqueue = (work) => {
    if (closed) return Promise.reject(new Error("session_closed"));
    if (pending >= MAX_PENDING) {
      stop();
      return Promise.reject(new Error("bridge_overloaded"));
    }
    pending++;
    const result = tail.then(() => {
      if (closed) throw new Error("session_closed");
      return work();
    }).catch(error => { stop(); throw error; }).finally(() => pending--);
    tail = result.catch(() => {});
    return result;
  };
  const call = async (command) => {
    const result = await vm.genserver.call(INGRESS, command, { timeoutMs: 2000 });
    if (!result.ok) throw new Error(result.error?.t || "bridge_failed");
    if (!result.data?.ok) throw new Error("invalid_command");
    return result.data;
  };
  const send = async (command) => {
    const result = await call(command);
    if (closed || socket?.readyState !== 1) throw new Error("socket_unavailable");
    const text = JSON.stringify(result.envelope);
    if (!boundedString(text, 65536) || socket.bufferedAmount > 65536) throw new Error("socket_overloaded");
    socket.send(text);
    return result;
  };
  return Object.freeze({
    async connect() {
      if (started || closed) throw new Error("session_already_started");
      started = true;
      try {
        vm = createVM({ onError: stop });
        const boot = await vm.boot();
        if (!boot.ok || closed) throw new Error("vm_boot_failed");
        socket = openSocket();
        socket.addEventListener("close", stop);
        socket.addEventListener("error", stop);
        socket.addEventListener("message", event => {
          if (!boundedString(event.data, 65536)) return stop();
          let frame;
          try { frame = JSON.parse(event.data); } catch { return stop(); }
          void enqueue(async () => {
            await call({ command: "receive_server_event", event: frame });
            onEvent(frame);
          }).catch(() => {});
        });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { stop(); reject(new Error("socket_timeout")); }, 5000);
          socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
          socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("socket_closed")); }, { once: true });
          socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("socket_error")); }, { once: true });
        });
        await enqueue(() => send({ command: "connect" }));
        heartbeat = setInterval(() => {
          if (healthPending || closed) return;
          healthPending = true;
          void enqueue(() => call({ command: "status" })).catch(() => {}).finally(() => { healthPending = false; });
        }, heartbeatMs);
      } catch (error) { stop(); throw error; }
    },
    requestCapability: () => enqueue(() => send({ command: "request_capability" })),
    invoke: (capId, message) => {
      if (!(capId === null || boundedString(capId, 256)) || !boundedString(message, 1024)) {
        return Promise.reject(new Error("invalid_command"));
      }
      return enqueue(() => send({ command: "invoke", cap_id: capId, message }));
    },
    status: () => enqueue(() => call({ command: "status" })),
    disconnect: async () => {
      if (closed) return;
      try { await enqueue(() => send({ command: "disconnect" })); } finally { stop(); }
    }
  });
}
