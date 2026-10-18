import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { assertPrivateChain, awaitExit, codePathArgs, elixirBin, pinnedBeamPath, repoRoot } from "./beam";
import { connectCarrierWebSocket, decodeCarrierOpFrame, verifyCarrierOp } from "@treetopdevs/lattice-client";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";

// Plan 181 slice 4 harness support: the manifest relay spawner, moved into the shell kit by plan 186 PR 3.
// The BEAM helpers it uses live in `./beam` (plan 186 PR 1). The relay is the existing
// `pilot_node.exs` fixture entrypoint: loopback only, started as a separate OS process, with a
// hand-written manifest. It is not a staged, sealed or admitted route, its
// stop and kill paths are test-only, and on macOS it uses the directory-sync approximation, so no
// durable-ack claim is made here for macOS.

const fromBase64 = (value: string): Uint8Array => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

export interface PilotInstanceSpec {
  name: string;
  port: number;
  /** 32-byte transport identity seed, hex. Written 0600 and never printed. */
  seedHex: string;
  logFile: string;
  relayRealms: string[];
}

export interface PilotRelay {
  pid: number;
  instances: Record<string, { port: number; pubkey: string }>;
  output: string[];
  /** Stdin EOF path: ends in `System.halt(0)`, with no stop seal and no controlled-stop semantics. */
  stop(): Promise<void>;
  /** SIGKILL, as a crashed host. */
  kill(): Promise<void>;
}

export interface PilotManifestInput {
  dir: string;
  trustedPeers: { realm: string; pubkey: string }[];
  instances: PilotInstanceSpec[];
  /** File name written under `dir`. */
  manifestName: string;
}

/** Write identity files (0600) and the manifest (0600). Returns the manifest path. */
export function writePilotManifest(input: PilotManifestInput): string {
  assertPrivateChain(input.dir);
  const instances = input.instances.map((spec) => {
    const identityFile = join(input.dir, `${spec.name}.identity`);
    writeFileSync(identityFile, `${spec.seedHex}\n`, { mode: 0o600 });
    chmodSync(identityFile, 0o600);
    return {
      name: spec.name,
      realm: `relay-${spec.name}`,
      identity_file: identityFile,
      log_file: spec.logFile,
      listener: { ip: "127.0.0.1", port: spec.port },
      trusted_peers: input.trustedPeers.map((peer) => ({ realm: peer.realm, pubkey: peer.pubkey })),
      relay_realms: spec.relayRealms,
    };
  });
  const manifestPath = join(input.dir, input.manifestName);
  writeFileSync(manifestPath, JSON.stringify({ version: 1, health: { ip: "127.0.0.1", port: 0 }, instances }), { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  return manifestPath;
}

/** Boot `pilot_node.exs` against a manifest. Readiness can take several seconds (preload and log verification). */
export async function spawnPilotManifestServer(manifestPath: string, pilotScript: string): Promise<PilotRelay> {
  const child = spawn(elixirBin(), [...codePathArgs(), pilotScript, manifestPath], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PATH: pinnedBeamPath() },
  });
  const output: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  const instances = await awaitPilotReady(child, output);
  return {
    pid: child.pid!,
    instances,
    output,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.write("stop\n");
      const code = await awaitExit(child, 15_000);
      if (code !== 0) throw new Error(`pilot exited with ${code}:\n${output.join("")}`);
    },
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGKILL");
      await awaitExit(child, 15_000);
    },
  };
}

function awaitPilotReady(
  child: ChildProcessWithoutNullStreams,
  output: string[],
): Promise<Record<string, { port: number; pubkey: string }>> {
  return new Promise((resolveReady, rejectReady) => {
    const instances: Record<string, { port: number; pubkey: string }> = {};
    const timeout = setTimeout(() => rejectReady(new Error(`pilot never became ready:\n${output.join("")}`)), 60_000);
    let buffered = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        output.push(`${line}\n`);
        if (line.startsWith("INSTANCE ")) {
          const [name, port, pubkey] = line.slice("INSTANCE ".length).trim().split(" ");
          instances[name!] = { port: Number.parseInt(port!, 10), pubkey: pubkey! };
        }
        if (line.startsWith("PILOT_READY ")) {
          clearTimeout(timeout);
          resolveReady(instances);
        }
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(new Error(`pilot exited (${code}) before READY:\n${output.join("")}`));
    });
  });
}

export interface ObservedRoute {
  url: string;
  replica: string;
  expectedPeerRealm: string;
  expectedPeerPubkey: string;
}

export interface RelayObserver {
  /** Sorted op ids the relay advertises for the route. */
  ids(label: string): Promise<string[]>;
  /** Every frame the relay serves, each one verified (strict Ed25519). */
  frames(label: string): Promise<CarrierOpFrame[]>;
}

/**
 * A read-only observer client over the same real sockets the apps use: its own seeded transport identity
 * (pre-seeded in the manifest like the apps'), advertise and pull only, never a relay submission. The
 * packaged harness uses it as the oracle's view of the relay frontier, so it never reads app storage to
 * decide what the relay holds.
 */
export function createRelayObserver(seed: Uint8Array, routes: Record<string, ObservedRoute>): RelayObserver {
  const verifier = {
    verify: (pubkey: Uint8Array, bytes: Uint8Array, sig: Uint8Array) => ed25519.verify(sig, bytes, pubkey, { zip215: false }),
  };
  const frameVerifier = {
    verify: async (pub: string, bytes: Uint8Array, sig: Uint8Array) => ed25519.verify(sig, bytes, fromBase64(pub), { zip215: false }),
  };
  async function observe<T>(label: string, use: (client: Awaited<ReturnType<typeof connectCarrierWebSocket>>) => Promise<T>) {
    const route = routes[label];
    if (!route) throw new Error(`observer has no route for ${label}`);
    const client = await connectCarrierWebSocket({
      url: route.url,
      localRealm: "observer",
      replica: route.replica,
      signer: { publicKey: ed25519.getPublicKey(seed), sign: (bytes) => ed25519.sign(bytes, seed) },
      expectedPeerRealm: route.expectedPeerRealm,
      expectedPeerPubkey: fromBase64(route.expectedPeerPubkey),
      verifier,
    });
    try {
      return await use(client);
    } finally {
      client.close();
    }
  }
  return {
    ids: (label) => observe(label, async (client) => [...(await client.advertise())].sort()),
    frames: (label) =>
      observe(label, async (client) => {
        const frames = (await client.pull([])).map(decodeCarrierOpFrame);
        for (const frame of frames) {
          if (!(await verifyCarrierOp(frame, frameVerifier)).valid) throw new Error("observer pull failed verification");
        }
        return frames;
      }),
  };
}

