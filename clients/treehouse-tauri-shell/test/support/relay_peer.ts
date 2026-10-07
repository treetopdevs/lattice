import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Plan 181 slice 4 harness support: the manifest relay spawner and BEAM helpers. The BEAM helpers are
// copies of the small functions in the Township shell's beam_peer.ts (they are not imported across
// shells). The relay is the existing `pilot_node.exs` fixture entrypoint: loopback only, started as a
// separate OS process, with a hand-written manifest. It is not a staged, sealed or admitted route, its
// stop and kill paths are test-only, and on macOS it uses the directory-sync approximation, so no
// durable-ack claim is made here for macOS.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const PILOT_SCRIPT = "apps/lattice_carrier_server/priv/pilot_node.exs";

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

/**
 * Create a scratch root under the repo build tree (or `$RUNNER_TEMP`), never `os.tmpdir()`: the manifest
 * loader refuses any ancestor with a group or other write bit, and a world-writable `/tmp` has one.
 * The path is realpath-resolved because macOS temp dirs sit under the `/var` symlink, which is refused.
 */
export function makeGateRoot(prefix: string): string {
  const bases = [join(repoRoot, "_build/test/tmp"), ...(process.env.RUNNER_TEMP ? [process.env.RUNNER_TEMP] : [])];
  const failures: string[] = [];
  for (const base of bases) {
    try {
      mkdirSync(base, { recursive: true });
      const dir = join(realpathSync(base), `${prefix}-${process.pid}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const real = realpathSync(dir);
      assertPrivateChain(real);
      return real;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`no scratch root passes the manifest path-permission rule:\n${failures.join("\n")}`);
}

/** Every directory on the chain, root included, has no group or other write bit. */
export function assertPrivateChain(path: string): void {
  let current = path;
  for (;;) {
    const mode = statSync(current).mode;
    if ((mode & 0o022) !== 0)
      throw new Error(`manifest_path_permissions: ${current} is group or world writable (${(mode & 0o7777).toString(8)})`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export interface PilotManifestInput {
  dir: string;
  trustedPeers: { realm: string; pubkey: string }[];
  instances: PilotInstanceSpec[];
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
  const manifestPath = join(input.dir, "treehouse-manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ version: 1, health: { ip: "127.0.0.1", port: 0 }, instances }), { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  return manifestPath;
}

/** Boot `pilot_node.exs` against a manifest. Readiness can take several seconds (preload and log verification). */
export async function spawnPilotManifestServer(manifestPath: string): Promise<PilotRelay> {
  const child = spawn(elixirBin(), [...codePathArgs(), PILOT_SCRIPT, manifestPath], {
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

function awaitExit(child: ChildProcessWithoutNullStreams, ms: number): Promise<number | null> {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("pilot process did not exit in time")), ms);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
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
      server.close((error) => (error ? rejectPort(error) : resolvePort(address.port)));
    });
  });
}

/** Run a BEAM support script to completion; its output must carry `expectedMarker`. */
export async function runBeamSupport(script: string, args: string[], expectedMarker: string): Promise<string> {
  const child = spawn(elixirBin(), [...codePathArgs(), script, ...args], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PATH: pinnedBeamPath() },
  });
  const lines: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
  const code = await awaitExit(child, 120_000);
  const output = lines.join("");
  if (code !== 0) throw new Error(`${script} exited with ${code}:\n${output}`);
  if (!output.includes(expectedMarker)) throw new Error(`${script} exited without ${expectedMarker}:\n${output}`);
  return output;
}

function codePathArgs(): string[] {
  const libRoot = join(repoRoot, "_build/test/lib");
  if (!existsSync(libRoot)) throw new Error(`missing BEAM test build at ${libRoot}; run MIX_ENV=test mix compile first`);
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

function pinnedBeamPath(): string {
  const home = process.env.HOME ?? "";
  const beamPaths = [
    join(home, ".asdf/installs/erlang/28.3.1/bin"),
    join(home, ".asdf/installs/erlang/28.3.1/erts-16.2/bin"),
    join(home, ".asdf/installs/elixir/1.19.5-otp-28/bin"),
  ].filter(existsSync);
  return [...beamPaths, process.env.PATH ?? ""].join(":");
}
