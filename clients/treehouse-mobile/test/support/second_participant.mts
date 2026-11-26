import { decodeCarrierOpFrame } from "@treetopdevs/lattice-client";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import { identityFromSeed } from "./group_fixture";
import { connectAs } from "./local_relay";
import type { CarrierRoute } from "@treetopdevs/lattice-shell-kit";

// The second participant for the M1b simulator scenarios: posts one message to the loopback demo relay as a
// demo role (default `neighbor`) while the app runs as the other. It fetches the role's demo seed from the
// loopback demo server exactly as the app does, keeps it in memory, and never prints it or the response; it
// prints only the new frame id and the relay's answer. Refuses any origin that is not loopback, so it can
// never write to the public demo relay. Usage, from clients/treehouse-mobile:
//
//   node_modules/.bin/tsx --preserve-symlinks test/support/second_participant.mts <origin> "<text>" [role]
//
// With `--show` in place of the text (M1b.3) it signs nothing: it pulls the thread and prints lattice-client's
// observeTreehouse posts directly (not the app's ThreadTimeline projection), one line per live post with its
// author's key check and winning text, so the other side's view does not repeat the app's own projection.

const [origin = "", text = "", role = "neighbor"] = process.argv.slice(2);
const show = text === "--show";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("origin must be a loopback demo server, http://127.0.0.1:<port>");
if (!text) throw new Error("text (or --show) is required");
if (role !== "founder" && role !== "neighbor") throw new Error("role must be founder or neighbor");

const getJson = async (path: string): Promise<unknown> => {
  const res = await fetch(`${origin}${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
};

const manifest = (await getJson("/demo-endpoints.json")) as {
  endpoints: { product: string; replica: string }[];
  treehouse_routes: CarrierRoute[];
};
const threadReplica = manifest.endpoints.find((ep) => ep.product === "Treehouse.Thread")?.replica;
const route = manifest.treehouse_routes.find((r) => r.replica === threadReplica);
if (!route) throw new Error("the loopback manifest has no thread route");

let identity;
{
  // Scoped so the seed text goes out of reach once the signer holds it.
  const seed = (await getJson(`/demo-seed/${role}`)) as { realm: string; seedHex: string };
  identity = identityFromSeed(seed.realm, Uint8Array.from(Buffer.from(seed.seedHex, "hex")));
}

const client = await connectAs(identity, route);
try {
  const frames: CarrierOpFrame[] = (await client.pull([])).map(decodeCarrierOpFrame);
  if (show) {
    // lattice-client's own observation (the reference library the Core suite checks against Sim vectors),
    // never the app's projectThreadTimeline, so a wrong edit or tombstone projection in the app cannot repeat
    // here. It lists the live posts with their winning text; a deleted or removed post is absent.
    const { carrierOpsToSemanticOps, observeTreehouse, treehouseCommandDecoders } = await import("@treetopdevs/lattice-client");
    const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Thread"));
    const observed = observeTreehouse("Treehouse.Thread", ops);
    console.log(`thread as seen by ${role} (lattice-client observation): ${observed.posts.length} live post(s), ${frames.length} op(s)`);
    for (const p of observed.posts) {
      const who = p.author === identity.pubkey ? "you" : `key ${String(p.author).slice(0, 8)}`;
      console.log(`- ${p.id.slice(0, 12)} ${who}: ${JSON.stringify(p.text)}`);
    }
    process.exitCode = 0;
  } else {
    const frame = await identity.post(frames, text);
    const report = await client.relay(frame);
    console.log(`posted ${frame.id} as ${role}; relay report: ${JSON.stringify(report)}`);
  }
} finally {
  client.close();
}
