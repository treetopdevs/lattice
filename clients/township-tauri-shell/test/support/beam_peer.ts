import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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

  const child = spawn(elixirBin(), args, {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${join(process.env.HOME ?? "", ".asdf/shims")}:${process.env.PATH ?? ""}`,
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

interface TownshipPeerReady {
  port: number;
  publicKeyBase64: string;
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
  const asdf = join(process.env.HOME ?? "", ".asdf/shims/elixir");
  if (existsSync(asdf)) return asdf;
  return "elixir";
}
