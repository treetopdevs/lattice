import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface TownshipPeerProcess {
  port: number;
  publicKeyBase64: string;
  awaitExit(): Promise<void>;
  kill(): void;
}

export interface SpawnTownshipPeerOptions {
  peerRealm: string;
  trustedPeerRealm: string;
  trustedPeerPubkey: string;
  scenario?: string;
  identitySeed?: string;
  bootstrapAudiencePubkey?: string;
  replica?: string;
}

export interface StableCarrierServerProcess {
  port: number;
  realm: string;
  publicKeyBase64: string;
  stop(): Promise<void>;
  kill(): Promise<void>;
}

export interface TownshipActionLiveProjectionProcess {
  port: number;
  output: string[];
  stop(): Promise<void>;
}

export interface SpawnTownshipActionLiveProjectionOptions {
  webPort: number;
  carrierPort: number;
  serverRealm: string;
  serverPubkey: string;
  observerRealm: string;
  observerSeed: string;
  replica: string;
}

export interface SpawnStableCarrierServerOptions {
  port: number;
  serverRealm: string;
  identitySeed: string;
  trustedPeerRealm: string;
  trustedPeerPubkey: string;
  sourcePath: string;
  relayRealm?: string;
  relayPubkey?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "../..");
const repoRoot = resolve(shellRoot, "../..");

export async function spawnTownshipPeer(options: SpawnTownshipPeerOptions): Promise<TownshipPeerProcess> {
  const args = [
    ...codePathArgs(),
    "apps/lattice_node_spike/priv/peer_node.exs",
    options.peerRealm,
    options.trustedPeerRealm,
    options.trustedPeerPubkey,
    options.scenario ?? "LatticeNodeSpike.TownshipScenario",
  ];
  if (options.identitySeed) args.push(options.identitySeed);
  if (options.bootstrapAudiencePubkey) args.push("--bootstrap-audience", options.bootstrapAudiencePubkey);
  if (options.replica) args.push("--replica", options.replica);

  const child = spawn(elixirBin(), args, {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: pinnedBeamPath(),
    },
  });

  const lines: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
  const ready = await awaitReady(child, lines);

  return {
    port: ready.port,
    publicKeyBase64: ready.publicKeyBase64,
    awaitExit: () => awaitExit(child, lines),
    kill: () => {
      if (!child.killed && child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

export function peerUrl(port: number, host = "127.0.0.1"): string {
  return `ws://${host}:${port}/carrier`;
}

export function stableCarrierUrl(port: number, host = "127.0.0.1"): string {
  return `ws://${host}:${port}/carrier`;
}

export async function freeTcpPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("failed to reserve a TCP port"));
        return;
      }
      server.close((error) => {
        if (error) rejectPort(error);
        else resolvePort(address.port);
      });
    });
  });
}

export async function runBeamSupport(
  script: string,
  args: string[],
  expectedMarker: string,
): Promise<string> {
  const child = spawn(elixirBin(), [...codePathArgs(), script, ...args], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PATH: pinnedBeamPath() },
  });
  const lines: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
  const code = await awaitProcessExit(child, 60_000);
  const output = lines.join("");
  if (code !== 0) throw new Error(`${script} exited with ${code}:\n${output}`);
  if (!output.includes(expectedMarker)) {
    throw new Error(`${script} exited without ${expectedMarker}:\n${output}`);
  }
  return output;
}

export async function spawnStableCarrierServer(
  options: SpawnStableCarrierServerOptions,
): Promise<StableCarrierServerProcess> {
  if ((options.relayRealm === undefined) !== (options.relayPubkey === undefined)) {
    throw new Error("stable carrier relay realm and public key must be configured together");
  }

  const args = [
    ...codePathArgs(),
    "apps/lattice_carrier_server/priv/server_node.exs",
    String(options.port),
    options.serverRealm,
    options.identitySeed,
    options.trustedPeerRealm,
    options.trustedPeerPubkey,
    options.sourcePath,
  ];
  if (options.relayRealm && options.relayPubkey) args.push(options.relayRealm, options.relayPubkey);

  const child = spawn(elixirBin(), args, {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PATH: pinnedBeamPath() },
  });
  const lines: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
  const ready = await awaitStableCarrierReady(child, lines);

  return {
    port: ready.port,
    realm: options.serverRealm,
    publicKeyBase64: ready.publicKeyBase64,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.write("stop\n");
      const code = await awaitProcessExit(child, 10_000);
      if (code !== 0) throw new Error(`stable carrier server exited with ${code}:\n${lines.join("")}`);
    },
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGKILL");
      await awaitProcessExit(child, 10_000);
    },
  };
}

export async function spawnTownshipActionLiveProjection(
  options: SpawnTownshipActionLiveProjectionOptions,
): Promise<TownshipActionLiveProjectionProcess> {
  const child = spawn(
    mixBin(),
    [
      "run",
      "--no-start",
      "scripts/township_action_handoff_live.exs",
      String(options.carrierPort),
      options.serverRealm,
      options.serverPubkey,
      options.observerRealm,
      options.observerSeed,
      options.replica,
    ],
    {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        MIX_ENV: "test",
        PHX_SERVER: "true",
        PORT: String(options.webPort),
        PATH: pinnedBeamPath(),
      },
    },
  );
  const output: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  await awaitOutputMarker(child, output, "TOWNSHIP_ACTION_HANDOFF_READY", 60_000);

  return {
    port: options.webPort,
    output,
    async stop() {
      await terminateProcess(child);
    },
  };
}

interface TownshipPeerReady {
  port: number;
  publicKeyBase64: string;
}

function awaitStableCarrierReady(
  child: ChildProcessWithoutNullStreams,
  lines: string[],
): Promise<TownshipPeerReady> {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error(`stable carrier server never became ready:\n${lines.join("")}`)),
      60_000,
    );
    let publicKeyBase64: string | null = null;
    let buffered = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const complete = buffered.split(/\r?\n/);
      buffered = complete.pop() ?? "";
      for (const line of complete) {
        if (!line) continue;
        lines.push(`${line}\n`);
        if (line.startsWith("SERVER_PUBKEY ")) publicKeyBase64 = line.slice("SERVER_PUBKEY ".length).trim();
        if (line.startsWith("SERVER_READY ")) {
          clearTimeout(timeout);
          if (!publicKeyBase64) {
            rejectReady(new Error(`stable carrier server became ready without SERVER_PUBKEY:\n${lines.join("")}`));
            return;
          }
          resolveReady({
            port: Number.parseInt(line.slice("SERVER_READY ".length), 10),
            publicKeyBase64,
          });
        }
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(new Error(`stable carrier server exited (${code}) before READY:\n${lines.join("")}`));
    });
  });
}

function awaitProcessExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error("BEAM support process did not exit")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
}

async function awaitOutputMarker(
  child: ChildProcessWithoutNullStreams,
  output: string[],
  marker: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (output.join("").includes(marker)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`process exited before ${marker}:\n${output.join("")}`);
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${marker}:\n${output.join("")}`);
}

async function terminateProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (!(await exitsWithin(child, 3_000)) && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exitsWithin(child, 3_000);
  }
}

async function exitsWithin(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function awaitReady(child: ChildProcessWithoutNullStreams, lines: string[]): Promise<TownshipPeerReady> {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`peer OS process never became ready:\n${lines.join("")}`)), 60_000);
    let publicKeyBase64: string | null = null;
    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line) continue;
        lines.push(`${line}\n`);
        if (line.startsWith("PEER_PUBKEY ")) {
          publicKeyBase64 = line.slice("PEER_PUBKEY ".length).trim();
        }
        if (line.startsWith("PEER_READY ")) {
          clearTimeout(timeout);
          if (!publicKeyBase64) {
            rejectReady(new Error(`peer OS process became ready without PEER_PUBKEY:\n${lines.join("")}`));
            return;
          }
          resolveReady({
            port: Number.parseInt(line.slice("PEER_READY ".length), 10),
            publicKeyBase64,
          });
        }
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(new Error(`peer OS process exited (${code}) before READY:\n${lines.join("")}`));
    });
  });
}

function awaitExit(child: ChildProcessWithoutNullStreams, lines: string[]): Promise<void> {
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error(`peer OS process did not exit:\n${lines.join("")}`)), 10_000);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else rejectExit(new Error(`peer OS process exited with ${code}:\n${lines.join("")}`));
    });
  });
}

function codePathArgs(): string[] {
  const libRoot = join(repoRoot, "_build/test/lib");
  if (!existsSync(libRoot)) throw new Error(`missing BEAM test build at ${libRoot}; run mix test first`);

  return readdirSync(libRoot)
    .map((app) => join(libRoot, app, "ebin"))
    .filter(existsSync)
    .flatMap((path) => ["-pa", path]);
}

function elixirBin(): string {
  const direct = join(process.env.HOME ?? "", ".asdf/installs/elixir/1.19.5-otp-28/bin/elixir");
  if (existsSync(direct)) return direct;
  const asdf = join(process.env.HOME ?? "", ".asdf/shims/elixir");
  if (existsSync(asdf)) return asdf;
  return "elixir";
}

function mixBin(): string {
  const asdf = join(process.env.HOME ?? "", ".asdf/shims/mix");
  return existsSync(asdf) ? asdf : "mix";
}

function pinnedBeamPath(): string {
  const home = process.env.HOME ?? "";
  const beamPaths = [
    join(home, ".asdf/installs/erlang/28.3.1/bin"),
    join(home, ".asdf/installs/erlang/28.3.1/erts-16.2/bin"),
    join(home, ".asdf/installs/elixir/1.19.5-otp-28/bin"),
  ].filter(existsSync);

  return [...beamPaths, process.env.PATH ?? ""].join(":");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
