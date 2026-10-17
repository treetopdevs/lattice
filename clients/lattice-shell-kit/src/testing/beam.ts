import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Plan 181 slice 4 harness support, moved here by plan 186 PR 1: the BEAM helpers. They began as copies of
// the small functions in the Township shell's beam_peer.ts, which stays a frozen copy; shells now import
// them from `@treetopdevs/lattice-shell-kit/testing/beam`. This module imports node built-ins only, so a
// plain `tsx` run (no `--preserve-symlinks`) can load it without resolving lattice-client.
// The enrollment gate and packaged harness scripts depend on that; keep it free of package imports.

// realpath first: under `--preserve-symlinks` this URL is the shell's node_modules symlink path, not the kit.
const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
export const repoRoot = resolve(here, "../../../..");

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

export function awaitExit(child: ChildProcessWithoutNullStreams, ms: number): Promise<number | null> {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("pilot process did not exit in time")), ms);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

export const fileSha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

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

export function codePathArgs(): string[] {
  const libRoot = join(repoRoot, "_build/test/lib");
  if (!existsSync(libRoot)) throw new Error(`missing BEAM test build at ${libRoot}; run MIX_ENV=test mix compile first`);
  return readdirSync(libRoot)
    .map((app) => join(libRoot, app, "ebin"))
    .filter(existsSync)
    .flatMap((path) => ["-pa", path]);
}

export function elixirBin(): string {
  const direct = join(process.env.HOME ?? "", ".asdf/installs/elixir/1.19.5-otp-28/bin/elixir");
  if (existsSync(direct)) return direct;
  const asdf = join(process.env.HOME ?? "", ".asdf/shims/elixir");
  if (existsSync(asdf)) return asdf;
  return "elixir";
}

export function pinnedBeamPath(): string {
  const home = process.env.HOME ?? "";
  const beamPaths = [
    join(home, ".asdf/installs/erlang/28.3.1/bin"),
    join(home, ".asdf/installs/erlang/28.3.1/erts-16.2/bin"),
    join(home, ".asdf/installs/elixir/1.19.5-otp-28/bin"),
  ].filter(existsSync);
  return [...beamPaths, process.env.PATH ?? ""].join(":");
}
