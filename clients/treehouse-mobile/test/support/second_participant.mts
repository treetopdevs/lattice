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
//
// With `--revoke` in place of the text (M1b.5), run as `founder` (the admin), it revokes the neighbor's Thread
// post grant: lattice-client's memberCapability finds the grant and authorTreehouseGrantRevocation signs the
// revoke on the relay's current heads, which is then relayed like a post. The app, running as the neighbor,
// then shows the cannot-post bar.
//
//   node_modules/.bin/tsx --preserve-symlinks test/support/second_participant.mts <origin> --revoke founder
//
// With `--archive` in place of the text (M1b.6), run as `founder` (the moderator holder in the loopback demo),
// it signs archive_thread with lattice-client's authorTreehouseCommand, citing the founder's live grant for it
// (memberCapability), on the relay's current heads. Since M1b.6 `--show` also prints the judge's archived flag
// and every op the judge does not count with its reason, so a post made after the archive shows as
// application_archived_thread on this side, independently of the app.
//
//   node_modules/.bin/tsx --preserve-symlinks test/support/second_participant.mts <origin> --archive founder

const [origin = "", text = "", role = "neighbor"] = process.argv.slice(2);
const show = text === "--show";
const revoke = text === "--revoke";
const archive = text === "--archive";
if (revoke && role !== "founder") throw new Error("--revoke runs as founder, the admin");
if (archive && role !== "founder") throw new Error("--archive runs as founder, the moderator");
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("origin must be a loopback demo server, http://127.0.0.1:<port>");
if (!text) throw new Error("text (or --show) is required");
if (role !== "founder" && role !== "neighbor") throw new Error("role must be founder or neighbor");

const getJson = async (path: string): Promise<unknown> => {
  const res = await fetch(`${origin}${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
};

const manifest = (await getJson("/demo-endpoints.json")) as {
  participants: Record<"founder" | "neighbor", { realm: string; pubkey: string }>;
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
    console.log(`archived (judge's state): ${(observed.state as { archived?: unknown }).archived === true}`);
    for (const [id, reason] of observed.quarantineReasons) console.log(`not counted ${id.slice(0, 12)}: ${reason}`);
    process.exitCode = 0;
  } else if (revoke) {
    const { authorTreehouseGrantRevocation, memberCapability } = await import("@treetopdevs/lattice-client");
    const { heads } = await import("./group_fixture");
    const neighbor = manifest.participants.neighbor.pubkey;
    const cap = memberCapability(frames, neighbor, route.replica, { product: "Treehouse.Thread", command: "post" });
    if (!cap) throw new Error("the neighbor holds no live Thread post grant");
    const frame = await authorTreehouseGrantRevocation({ replica: route.replica, deps: heads(frames), signer: identity.signer, delegationId: cap.id });
    const report = await client.relay(frame);
    console.log(`revoked grant ${cap.id.slice(0, 12)} with ${frame.id} as founder; relay report: ${JSON.stringify(report)}`);
  } else if (archive) {
    const { authorTreehouseCommand, memberCapability } = await import("@treetopdevs/lattice-client");
    const { heads } = await import("./group_fixture");
    const cap = memberCapability(frames, identity.pubkey, route.replica, { product: "Treehouse.Thread", command: "archive_thread" });
    if (!cap) throw new Error("the founder holds no live archive_thread grant in this thread");
    const frame = await authorTreehouseCommand({
      product: "Treehouse.Thread",
      replica: route.replica,
      deps: heads(frames),
      signer: identity.signer,
      capId: cap.id,
      command: { command: "archive_thread" },
    });
    const report = await client.relay(frame);
    console.log(`archived the thread with ${frame.id} as founder; relay report: ${JSON.stringify(report)}`);
  } else {
    const frame = await identity.post(frames, text);
    const report = await client.relay(frame);
    console.log(`posted ${frame.id} as ${role}; relay report: ${JSON.stringify(report)}`);
  }
} finally {
  client.close();
}
