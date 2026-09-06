import { Popcorn } from "@swmansion/popcorn";
import { createSession } from "./session.mjs";

let capId;
const events = [];
const show = frame => {
  events.push(frame);
  if (events.length > 100) events.shift();
  document.querySelector("#events").textContent = JSON.stringify(events, null, 2);
  if (frame.type === "grant") capId = frame.cap.id;
  if (frame.type === "welcome") document.querySelector("#grant").disabled = false;
  if (frame.type === "grant") document.querySelector("#invoke").disabled = false;
};
const session = createSession({
  createVM: opts => new Popcorn(opts),
  openSocket: () => new WebSocket(new URL("/ws", location.href.replace(/^http/, "ws"))),
  onEvent: show
});
// Only the fixed command facade is public. No VM, PID, eval, send, or target selector.
window.lattice = session;
for (const [id, action] of Object.entries({
  connect: async () => {
    document.querySelector("#connect").disabled = true;
    await session.connect();
    document.querySelector("#disconnect").disabled = false;
  },
  grant: () => session.requestCapability(),
  invoke: () => session.invoke(capId, "hello from OTP"),
  disconnect: () => session.disconnect()
})) document.getElementById(id).onclick = () => Promise.resolve().then(action).catch(e => show({ error: e.message }));
