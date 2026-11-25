import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildGroup, identityFromSeed } from "./group_fixture";
import { connectAs, startLocalRelay } from "./local_relay";

// The loopback demo server (M1a.7): the local BEAM relay fixture plus the two HTTP routes the app's demo code
// fetches from the public demo relay, `/demo-endpoints.json` and `/demo-seed/<role>`, served on 127.0.0.1
// only. A dev build pointed here (EXPO_PUBLIC_TREEHOUSE_DEMO_ORIGIN) posts to this relay and never to the
// public one. The two demo seeds are random per process and are served only to the app, as the public demo
// relay serves its own; they are never printed or logged. `/relay-ids/<space|thread>` lists the relay's own
// advertised ids (through a separate carrier session), the reference for "on relay".

export interface LoopbackDemo {
  origin: string;
  relayIds(label: "space" | "thread"): Promise<string[]>;
  stop(): Promise<void>;
}

export async function startLoopbackDemo(opts: { port?: number } = {}): Promise<LoopbackDemo> {
  const seeds = { founder: randomBytes(32), neighbor: randomBytes(32) };
  const founder = identityFromSeed("demo-founder", seeds.founder);
  const neighbor = identityFromSeed("demo-neighbor", seeds.neighbor);
  const group = await buildGroup({ identities: { admin: founder, members: [neighbor] } });
  const relay = await startLocalRelay(group, [founder, neighbor]);
  const routeOf = (label: "space" | "thread") =>
    relay.routes.find((r) => r.replica === (label === "space" ? group.space : group.thread).replica)!;

  const endpoint = (label: "space" | "thread") => {
    const route = routeOf(label);
    return {
      name: `treehouse-${label}`,
      product: label === "space" ? "Treehouse.Space" : "Treehouse.Thread",
      replica: route.replica,
      ws_url: route.url,
      peer_realm: route.expectedPeerRealm,
      peer_pubkey: route.expectedPeerPubkey,
      relay_realms: [founder.realm, neighbor.realm],
      initial_ops: (label === "space" ? group.space : group.thread).frames.length,
    };
  };
  const manifest = {
    mode: "loopback",
    notice: "Loopback demo relay for simulator runs. Demo keys are public to this machine.",
    manifest_path: "",
    health: { livez: "", readyz: "" },
    participants: {
      founder: { realm: founder.realm, pubkey: founder.pubkey, seed_file: "" },
      neighbor: { realm: neighbor.realm, pubkey: neighbor.pubkey, seed_file: "" },
    },
    endpoints: [endpoint("space"), endpoint("thread")],
    treehouse_routes: relay.routes,
  };

  const relayIds = async (label: "space" | "thread") => {
    const client = await connectAs(founder, routeOf(label));
    try {
      return [...(await client.advertise())].sort();
    } finally {
      client.close();
    }
  };

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "GET") return send(405, { error: "method" });
    if (path === "/demo-endpoints.json") return send(200, manifest);
    const seed = /^\/demo-seed\/(founder|neighbor)$/.exec(path ?? "");
    if (seed) {
      const role = seed[1] as "founder" | "neighbor";
      return send(200, { realm: role === "founder" ? founder.realm : neighbor.realm, seedHex: seeds[role].toString("hex") });
    }
    const ids = /^\/relay-ids\/(space|thread)$/.exec(path ?? "");
    if (ids)
      return void relayIds(ids[1] as "space" | "thread").then(
        (list) => send(200, { ids: list }),
        () => send(502, { error: "relay" }),
      );
    send(404, { error: "not_found" });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    relayIds,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await relay.kill();
    },
  };
}
