import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kill as killProcess } from "node:process";
import type { Page } from "@playwright/test";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import { TOWNSHIP_STORAGE_NAMESPACE } from "../../src/native_workflow";

const DEFAULT_LAUNCH_SERVICES_REGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export interface NativeIdentity {
  publicKey: Uint8Array;
  publicKeyBase64: string;
  privateSeedBase64: string;
  privateSeedBytesJson: string;
  privateSeedHex: string;
}

export interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  stop(): Promise<void>;
}

export interface PackagedActionHandoffHarnessOptions {
  shellRoot: string;
  appBundlePath: string;
  appIdentifier: string;
  tracePath: string;
  kvPath: string;
  diagnostics?: () => string | Promise<string>;
  toolPath?: string;
  launchServicesRegister?: string;
}

export interface PackagedActionHandoffHarness {
  assertAppBundleRegistersTownshipScheme(): void;
  registerLaunchServicesHandler(): Promise<void>;
  assertLaunchServicesRoutesTownshipSchemeToBundle(): Promise<void>;
  deliverDeepLink(url: string): Promise<void>;
  spawnManaged(command: string, args: string[], cwd?: string, env?: Record<string, string>): ManagedProcess;
  run(command: string, args: string[], cwd?: string, env?: Record<string, string>): Promise<void>;
  runCapture(command: string, args: string[], cwd?: string): Promise<string>;
  quitTownshipApp(): Promise<void>;
  readKvValues(): Map<string, string>;
  writeNativeKv(values: ReadonlyMap<string, string>): void;
  storedFrames(values: ReadonlyMap<string, string>, key: string): CarrierOpFrame[];
  storedIds(values: ReadonlyMap<string, string>, key: string): string[];
  waitForStoredIds(key: string, expected: string[], timeoutMs: number): Promise<void>;
  readTrace(): string;
  traceLines(): string[];
  traceLineCount(line: string): number;
  waitForTraceLine(line: string, timeoutMs: number): Promise<void>;
  waitForAttribute(page: Page, selector: string, name: string, expected: string, timeoutMs: number): Promise<void>;
  waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs: number): Promise<void>;
}

export function createPackagedActionHandoffHarness(
  options: PackagedActionHandoffHarnessOptions,
): PackagedActionHandoffHarness {
  const toolPath = options.toolPath ?? pinnedToolPath(options.shellRoot);
  const launchServicesRegister = options.launchServicesRegister ?? DEFAULT_LAUNCH_SERVICES_REGISTER;
  const diagnostics = options.diagnostics ?? (() => `trace:\n${readTrace(options.tracePath) || "<empty>"}`);

  const spawnHarnessProcess = (
    command: string,
    args: string[],
    cwd = options.shellRoot,
    env: Record<string, string> = {},
  ): ManagedProcess => spawnManaged(command, args, cwd, env, toolPath);

  const runHarnessProcess = async (
    command: string,
    args: string[],
    cwd = options.shellRoot,
    env: Record<string, string> = {},
  ): Promise<void> => {
    const process = spawnHarnessProcess(command, args, cwd, env);
    const code = await waitForExit(process.child);
    if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${process.lines.join("")}`);
  };

  const runHarnessCapture = async (command: string, args: string[], cwd = options.shellRoot): Promise<string> => {
    const process = spawnHarnessProcess(command, args, cwd);
    const code = await waitForExit(process.child);
    if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${process.lines.join("")}`);
    return process.lines.join("");
  };

  const waitForHarness = (
    predicate: () => boolean | Promise<boolean>,
    label: string,
    timeoutMs: number,
  ): Promise<void> => waitFor(label, timeoutMs, predicate, diagnostics);

  const runningAppBundleProcessIds = async (): Promise<number[]> =>
    appBundleProcessIds(
      await runHarnessCapture("ps", ["-axww", "-o", "pid=,command="]),
      options.appBundlePath,
    );

  const waitForAppBundleExit = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await runningAppBundleProcessIds()).length === 0) return true;
      await delay(50);
    }
    return (await runningAppBundleProcessIds()).length === 0;
  };

  const signalAppBundleProcesses = async (signal: NodeJS.Signals): Promise<void> => {
    for (const pid of await runningAppBundleProcessIds()) {
      try {
        killProcess(pid, signal);
      } catch (error) {
        if (!isNoSuchProcess(error)) throw error;
      }
    }
  };

  return {
    assertAppBundleRegistersTownshipScheme(): void {
      const infoPlist = join(options.appBundlePath, "Contents", "Info.plist");
      if (!existsSync(infoPlist)) throw new Error(`expected Info.plist at ${infoPlist}`);
      const plist = readFileSync(infoPlist, "utf8");
      if (!plist.includes("CFBundleIdentifier")) throw new Error("Info.plist lacks CFBundleIdentifier");
      if (!new RegExp(options.appIdentifier.replaceAll(".", "\\.")).test(plist)) {
        throw new Error(`Info.plist lacks bundle id ${options.appIdentifier}`);
      }
      if (!plist.includes("CFBundleURLSchemes") || !plist.includes("township")) {
        throw new Error("Info.plist lacks township URL scheme");
      }
    },

    async registerLaunchServicesHandler(): Promise<void> {
      if (!existsSync(launchServicesRegister)) throw new Error(`expected lsregister at ${launchServicesRegister}`);
      await runHarnessProcess(launchServicesRegister, ["-f", options.appBundlePath]);
    },

    async assertLaunchServicesRoutesTownshipSchemeToBundle(): Promise<void> {
      const script = [
        "import AppKit",
        'if let url = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "township://action")!) {',
        "  print(url.path)",
        "}",
      ].join("\n");
      const resolvedPath = (await runHarnessCapture("swift", ["-e", script])).trim().replace(/\/+$/, "");
      if (resolvedPath !== options.appBundlePath.replace(/\/+$/, "")) {
        throw new Error(`township URL routes to ${resolvedPath}, expected ${options.appBundlePath}`);
      }
    },

    deliverDeepLink(url: string): Promise<void> {
      return runHarnessProcess("open", [url]);
    },

    spawnManaged: spawnHarnessProcess,
    run: runHarnessProcess,
    runCapture: runHarnessCapture,

    async quitTownshipApp(): Promise<void> {
      const quitProcess = spawnHarnessProcess("osascript", [
        "-e",
        `quit app id "${options.appIdentifier}"`,
      ]);
      if (!(await exitsWithin(quitProcess.child, 2_000))) quitProcess.child.kill("SIGKILL");
      if (await waitForAppBundleExit(2_000)) return;

      await signalAppBundleProcesses("SIGTERM");
      if (await waitForAppBundleExit(2_000)) return;

      await signalAppBundleProcesses("SIGKILL");
      if (await waitForAppBundleExit(2_000)) return;

      throw new Error(
        `Township app processes did not exit: ${(await runningAppBundleProcessIds()).join(", ")}`,
      );
    },

    readKvValues(): Map<string, string> {
      if (!existsSync(options.kvPath)) throw new Error(`expected isolated native KV file at ${options.kvPath}`);
      return readKvValues(options.kvPath);
    },

    writeNativeKv(values: ReadonlyMap<string, string>): void {
      writeNativeKv(options.kvPath, values);
    },

    storedFrames(values: ReadonlyMap<string, string>, key: string): CarrierOpFrame[] {
      return storedFrames(values, key);
    },

    storedIds(values: ReadonlyMap<string, string>, key: string): string[] {
      return storedIds(values, key);
    },

    waitForStoredIds(key: string, expected: string[], timeoutMs: number): Promise<void> {
      const sortedExpected = [...expected].sort();
      return waitForHarness(() => {
        try {
          return JSON.stringify(storedIds(readKvValues(options.kvPath), key)) === JSON.stringify(sortedExpected);
        } catch {
          return false;
        }
      }, `${key} ids`, timeoutMs);
    },

    readTrace(): string {
      return readTrace(options.tracePath);
    },

    traceLines(): string[] {
      return traceLines(options.tracePath);
    },

    traceLineCount(line: string): number {
      return traceLineCount(options.tracePath, line);
    },

    waitForTraceLine(line: string, timeoutMs: number): Promise<void> {
      return waitForHarness(() => traceLines(options.tracePath).includes(line), `trace ${line}`, timeoutMs);
    },

    waitForAttribute(page: Page, selector: string, name: string, expected: string, timeoutMs: number): Promise<void> {
      return waitForHarness(
        async () => (await page.locator(selector).getAttribute(name)) === expected,
        `${selector} ${name}`,
        timeoutMs,
      );
    },

    waitFor: waitForHarness,
  };
}

export function writeNativeKv(path: string, values: ReadonlyMap<string, string>): void {
  writeFileSync(path, JSON.stringify(Object.fromEntries(sortedEntries(values)), null, 2), "utf8");
}

export function readKvValues(path: string): Map<string, string> {
  const values = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  return new Map(Object.entries(values));
}

export function storedFrames(values: ReadonlyMap<string, string>, key: string): CarrierOpFrame[] {
  return JSON.parse(requiredValue(values, storageKey(key))) as CarrierOpFrame[];
}

export function storedIds(values: ReadonlyMap<string, string>, key: string): string[] {
  const parsed = JSON.parse(requiredValue(values, storageKey(key))) as { id: string }[];
  return parsed.map((entry) => entry.id).sort();
}

export function requiredValue(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) throw new Error(`missing native KV value ${key}`);
  return value;
}

export function storageKey(key: string): string {
  return `${TOWNSHIP_STORAGE_NAMESPACE}:${key}`;
}

export function sortedEntries(values: ReadonlyMap<string, string>): [string, string][] {
  return [...values.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export function traceLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
}

export function readTrace(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").trim();
}

export function traceLineCount(path: string, line: string): number {
  return traceLines(path).filter((candidate) => candidate === line).length;
}

export async function waitFor(
  description: string,
  timeoutMs: number,
  check: () => boolean | Promise<boolean>,
  diagnostics: () => string | Promise<string> = () => "condition remained false",
  retryDelayMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(retryDelayMs);
  }

  throw new Error(`timed out waiting for ${description}: ${await diagnostics()}`);
}

export function seededEd25519Identity(seed: string): NativeIdentity {
  const privateSeed = createHash("sha256").update(seed).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), privateSeed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey.export({ format: "pem", type: "pkcs8" }))
    .export({ format: "der", type: "spki" })
    .subarray(-32);

  return {
    publicKey: new Uint8Array(publicKey),
    publicKeyBase64: Buffer.from(publicKey).toString("base64"),
    privateSeedBase64: privateSeed.toString("base64"),
    privateSeedBytesJson: JSON.stringify([...privateSeed]),
    privateSeedHex: privateSeed.toString("hex"),
  };
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function appBundleProcessIds(processList: string, appBundlePath: string): number[] {
  const executablePrefix = `${appBundlePath.replace(/\/+$/, "")}/Contents/MacOS/`;
  const processIds: number[] = [];

  for (const line of processList.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match?.[2].startsWith(executablePrefix)) processIds.push(Number(match[1]));
  }

  return processIds;
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function mixBin(): string {
  const asdf = join(process.env.HOME ?? "", ".asdf", "shims", "mix");
  return existsSync(asdf) ? asdf : "mix";
}

export function pinnedToolPath(shellRoot: string): string {
  const home = process.env.HOME ?? "";
  return [
    join(home, ".asdf", "installs", "erlang", "28.3.1", "bin"),
    join(home, ".asdf", "installs", "erlang", "28.3.1", "erts-16.2", "bin"),
    join(home, ".asdf", "installs", "elixir", "1.19.5-otp-28", "bin"),
    "/opt/homebrew/opt/rustup/bin",
    join(shellRoot, "node_modules", ".bin"),
    process.env.PATH ?? "",
  ]
    .filter((path) => path.length > 0 && (path === process.env.PATH || existsSync(path)))
    .join(":");
}

function spawnManaged(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  toolPath: string,
): ManagedProcess {
  const child = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PATH: toolPath, ...env },
  });
  const lines: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => lines.push(chunk.toString()));

  return {
    child,
    lines,
    async stop(): Promise<void> {
      await stopProcess(child);
    },
  };
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (!(await exitsWithin(child, 2_000)) && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exitsWithin(child, 2_000);
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
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
