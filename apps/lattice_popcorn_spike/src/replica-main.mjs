import { Popcorn } from "@swmansion/popcorn";
import { replicaStore } from "./replica-store.mjs";
import { createReplicaSession } from "./replica-session.mjs";
const name = new URL(location.href).searchParams.get("replica") || "alice";
const error = e => { document.querySelector("#error").textContent = e.message; };
document.querySelector("#name").textContent = name;
let release;
const show = view => {
  document.querySelector("#state").textContent = JSON.stringify(view, null, 2);
  document.querySelector("#notes").replaceChildren(...view.notes.map(text => {
    const li = document.createElement("li"); li.textContent = text; return li;
  }));
};
const session = createReplicaSession({
  createVM: opts => new Popcorn(opts),
  openSocket: () => new WebSocket(new URL("/ws", location.href.replace(/^http/, "ws"))),
  store: replicaStore(name), onChange: show
});
// Web Locks prevent two active tabs from overwriting one persisted identity/log.
void navigator.locks.request(`lattice-replica:${name}`, { ifAvailable: true }, async lock => {
  if (!lock) throw new Error("This replica is open in another tab. Choose the other replica or close that tab.");
  try {
    await session.start();
    window.replica = session;
    for (const id of ["connect", "sync", "offline", "save"]) document.getElementById(id).disabled = false;
    document.querySelector("#connection").textContent = "Restored locally · offline";
    await new Promise(resolve => { release = resolve; });
  } finally { session.close(); }
}).catch(error);
for (const id of ["connect", "sync", "offline"]) document.getElementById(id).onclick = async () => {
  try {
    document.querySelector("#error").textContent = "";
    await session[id]();
    const status = await session.status();
    document.querySelector("#connection").textContent = status.connected ? "Connected · synchronized" : "Offline · local changes persist";
  } catch (e) { error(e); }
};
document.querySelector("#post").onsubmit = async e => {
  e.preventDefault();
  try { await session.post(document.querySelector("#text").value); document.querySelector("#text").value = ""; }
  catch (e) { error(e); }
};
window.addEventListener("pagehide", () => { session.close(); release?.(); });
