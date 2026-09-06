const INGRESS = "Elixir.LatticeBrowser.Bridge";
const bytes = text => new TextEncoder().encode(text).length;

// Fixed command facade. Generic VM calls and persisted seeds never escape it.
export function createReplicaSession({ createVM, openSocket, store, onChange = () => {} }) {
  let vm, socket, cap, waiting, view, heartbeat, healthPending = false, closed = false, started = false, pending = 0;
  let tail = Promise.resolve();
  const offline = () => {
    const old = socket; socket = null; cap = null;
    waiting?.reject(new Error("socket_closed")); waiting = null;
    old?.close();
  };
  const close = () => { clearInterval(heartbeat); closed = true; offline(); vm?.deinit(); };
  const queue = work => {
    if (closed) return Promise.reject(new Error("replica_closed"));
    if (pending >= 16) return Promise.reject(new Error("replica_busy"));
    pending++;
    const task = tail.then(() => {
      if (closed) throw new Error("replica_closed");
      return work();
    }).finally(() => pending--);
    tail = task.catch(() => {});
    return task;
  };
  const call = async command => {
    if (bytes(JSON.stringify(command)) > 65536) throw new Error("frame_too_large");
    let result;
    try { result = await vm.genserver.call(INGRESS, command, { timeoutMs: 10000 }); }
    catch (error) { close(); throw error; }
    if (!result.ok) { close(); throw new Error("vm_call_failed"); }
    if (!result.data?.ok) throw new Error(result.data?.error || "invalid_command");
    return result.data;
  };
  const persist = async result => {
    // A successful write means the IDB transaction committed, not merely queued.
    try { await store.save(result.capsule); }
    catch (error) { close(); throw error; }
    view = result.view;
    onChange(view);
    return { ...view, ...(result.op_id ? { op_id: result.op_id } : {}) };
  };
  const exchange = (frame, type) => new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== 1 || waiting) return reject(new Error("socket_unavailable"));
    const text = JSON.stringify(frame);
    if (bytes(text) > 65536 || socket.bufferedAmount > 65536) return reject(new Error("frame_too_large"));
    const timer = setTimeout(() => { offline(); reject(new Error("response_timeout")); }, 10000);
    waiting = {
      type,
      resolve: frame => { clearTimeout(timer); waiting = null; resolve(frame); },
      reject: error => { clearTimeout(timer); waiting = null; reject(error); }
    };
    try { socket.send(text); } catch (error) { offline(); reject(error); }
  });
  const gateway = async payload => {
    const response = await exchange({ type: "call", cap_id: cap, payload }, "call_result");
    if (!response.ok) throw new Error(response.error || "gateway_denied");
    return response.result;
  };
  const merge = async log => persist(await call({ command: "replica_receive", log }));
  const sync = async () => {
    const { ops } = await call({ command: "replica_upload" });
    const result = await gateway({ action: "sync", ops });
    await merge(result.log);
    return { ...view, accepted: result.accepted };
  };
  return Object.freeze({
    start: () => queue(async () => {
      if (started) throw new Error("already_started");
      started = true;
      try {
        const capsule = await store.load();
        vm = createVM({ onError: close });
        const boot = await vm.boot();
        if (!boot.ok || closed) throw new Error("vm_boot_failed");
        const restored = await persist(await call({ command: "replica_restore", capsule }));
        heartbeat = setInterval(() => {
          if (healthPending || closed || pending >= 16) return;
          healthPending = true;
          void queue(() => call({ command: "status" })).catch(close).finally(() => { healthPending = false; });
        }, 1000);
        return restored;
      } catch (error) { close(); throw error; }
    }),
    connect: () => queue(async () => {
      if (!view) throw new Error("not_started");
      offline();
      const current = openSocket(); socket = current;
      current.addEventListener("message", event => {
        if (socket !== current) return;
        try {
          if (typeof event.data !== "string" || bytes(event.data) > 65536) throw new Error("invalid_frame");
          const frame = JSON.parse(event.data);
          if (frame.type === "error") waiting?.reject(new Error(frame.message || "protocol_error"));
          else if (frame.type === waiting?.type) waiting.resolve(frame);
        } catch { close(); }
      });
      current.addEventListener("close", () => { if (socket === current) offline(); });
      current.addEventListener("error", () => { if (socket === current) offline(); });
      try {
        await new Promise((resolve, reject) => {
          const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
          const timer = setTimeout(() => finish(new Error("socket_timeout")), 5000);
          current.addEventListener("open", () => finish(), { once: true });
          current.addEventListener("close", () => finish(new Error("socket_closed")), { once: true });
          current.addEventListener("error", () => finish(new Error("socket_error")), { once: true });
        });
        await exchange({ type: "hello", identity: { runtime: "popcorn-durable" } }, "welcome");
        const grant = await exchange({ type: "grant_request", target: "replica_demo" }, "grant");
        cap = grant.cap.id;
        const result = await gateway({ action: "enroll", public_key: view.public_key });
        await merge(result.log);
        return await sync();
      } catch (error) { offline(); throw error; }
    }),
    post: text => queue(async () => persist(await call({ command: "replica_post", text }))),
    sync: () => queue(sync),
    offline: () => queue(async () => { offline(); return view; }),
    status: () => queue(async () => ({ ...view, connected: Boolean(socket && cap) })),
    close
  });
}
