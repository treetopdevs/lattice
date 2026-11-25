import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { connectCarrierWebSocket, verifyEd25519 } from "@treetopdevs/lattice-client";
import type { CarrierWebSocketClient } from "@treetopdevs/lattice-client";
import type { CarrierRoute } from "@treetopdevs/lattice-shell-kit";
import { freeTcpPort, makeGateRoot, runBeamSupport } from "@treetopdevs/lattice-shell-kit/testing/beam";
import { spawnPilotManifestServer, writePilotManifest } from "@treetopdevs/lattice-shell-kit/testing/relay";
import type { PilotRelay } from "@treetopdevs/lattice-shell-kit/testing/relay";
import type { Group, TestIdentity } from "./group_fixture";

// The local BEAM relay: `pilot_node.exs` on loopback with a hand-written manifest, one route per
// group replica, started as a separate OS process. Only the identities passed in `admit` are trusted
// peers and relay realms; any other key is refused at the hello. The admin then relays the group's
// frames over the real socket, so the relay logs start from exactly what the fixture authored.
//
// Needs the BEAM test build once: `MIX_ENV=test ~/.asdf/shims/mix compile` from the repo root.
// The empty path logs are written by the Tauri shell's fixture script (reused, not copied): an empty
// replica-named `Log.new/1` dump per route. The relay's transport seeds are random per run and are
// written 0600 by the kit; they are never printed.

const PILOT_SCRIPT = "apps/lattice_carrier_server/priv/pilot_node.exs";
const EMPTY_LOG_FIXTURE = "clients/treehouse-tauri-shell/test/support/treehouse_enrollment_fixture.exs";
const MANIFEST_NAME = "treehouse-mobile-manifest.json";

export interface LocalRelay {
  routes: CarrierRoute[];
  /** Stdin EOF path; test-only, no controlled-stop claim. */
  stop(): Promise<void>;
  /** SIGKILL, as a crashed host. */
  kill(): Promise<void>;
}

let started = 0;

export async function startLocalRelay(group: Group, admit: TestIdentity[]): Promise<LocalRelay> {
  if (!admit.some((identity) => identity.pubkey === group.admin.pubkey))
    throw new Error("the admin must be admitted to seed the relay");
  const root = makeGateRoot(`treehouse-mobile-relay-${++started}`);
  const logs = [
    { label: "space", replica: group.space.replica, frames: group.space.frames },
    { label: "thread", replica: group.thread.replica, frames: group.thread.frames },
  ];
  let relay: PilotRelay | null = null;
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    await runBeamSupport(EMPTY_LOG_FIXTURE, [root, ...logs.map((l) => `${l.label}=${l.replica}`)], "FIXTURE_READY");
    const ports: Record<string, number> = {};
    for (const log of logs) ports[log.label] = await freeTcpPort();
    const manifest = writePilotManifest({
      dir: root,
      manifestName: MANIFEST_NAME,
      trustedPeers: admit.map((identity) => ({ realm: identity.realm, pubkey: identity.pubkey })),
      instances: logs.map((log) => ({
        name: log.label,
        port: ports[log.label]!,
        seedHex: randomBytes(32).toString("hex"),
        logFile: join(root, `${log.label}.log`),
        relayRealms: admit.map((identity) => identity.realm),
      })),
    });
    relay = await spawnPilotManifestServer(manifest, PILOT_SCRIPT);
    const routes: CarrierRoute[] = logs.map((log) => {
      const instance = relay!.instances[log.label];
      if (!instance || instance.port !== ports[log.label]) throw new Error(`relay did not start ${log.label}`);
      return {
        replica: log.replica,
        url: `ws://127.0.0.1:${instance.port}/carrier`,
        expectedPeerRealm: `relay-${log.label}`,
        expectedPeerPubkey: instance.pubkey,
      };
    });
    for (const [i, log] of logs.entries()) {
      const client = await connectAs(group.admin, routes[i]!);
      try {
        for (const frame of log.frames) {
          const report = await client.relay(frame);
          if (report.accepted.length !== 1 || report.accepted[0] !== frame.id)
            throw new Error(`seeding ${log.label}: frame ${frame.id} not accepted (${JSON.stringify(report)})`);
        }
      } finally {
        client.close();
      }
    }
    const running = relay;
    return {
      routes,
      async stop() {
        try {
          await running.stop();
        } finally {
          cleanup();
        }
      },
      async kill() {
        try {
          await running.kill();
        } finally {
          cleanup();
        }
      },
    };
  } catch (error) {
    await relay?.kill().catch(() => undefined);
    cleanup();
    throw error;
  }
}

const fromBase64 = (value: string) => Uint8Array.from(Buffer.from(value, "base64"));

/** Open an authenticated carrier session to `route` as `identity`, pinning the relay's realm and key. */
export function connectAs(identity: TestIdentity, route: CarrierRoute): Promise<CarrierWebSocketClient> {
  return connectCarrierWebSocket({
    url: route.url,
    localRealm: identity.realm,
    replica: route.replica,
    signer: identity.signer,
    expectedPeerRealm: route.expectedPeerRealm,
    expectedPeerPubkey: fromBase64(route.expectedPeerPubkey),
    verifier: { verify: (pubkey, bytes, sig) => verifyEd25519(sig, bytes, pubkey) },
  });
}
