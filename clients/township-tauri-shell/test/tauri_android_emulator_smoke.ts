import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { carrierTranscriptBytes } from "@treetopdevs/lattice-client";

interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  stop(): Promise<void>;
}

interface TownshipCarrierVector {
  scenario: string;
  replica: string;
  client: { realm: string };
}

interface CdpClient {
  close(): void;
  send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

interface CdpTarget {
  webSocketDebuggerUrl?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");
const vector = JSON.parse(
  readFileSync(join(shellRoot, "..", "lattice-client", "test", "vectors", "township_carrier_w1.json"), "utf8"),
) as TownshipCarrierVector;

const appId = "dev.treetop.lattice.township";
const appActivity = `${appId}/.MainActivity`;
const keyId = "township-resident";
const defaultAvd = "Pixel_3a_API_34_extension_level_7_arm64-v8a";
const sdkRoot = androidSdkRoot();
const adb = join(sdkRoot, "platform-tools", "adb");
const emulator = join(sdkRoot, "emulator", "emulator");
const apkPath = resolve(
  process.env.TOWNSHIP_ANDROID_APK ??
    join(shellRoot, "src-tauri", "gen", "android", "app", "build", "outputs", "apk", "universal", "debug", "app-universal-debug.apk"),
);
const avdName = process.env.TOWNSHIP_ANDROID_AVD ?? defaultAvd;

console.log(`\n▸ ${vector.scenario} Android emulator native key smoke`);

assert.ok(existsSync(adb), `missing adb at ${adb}; set ANDROID_SDK_ROOT or ANDROID_HOME`);
assert.ok(existsSync(emulator), `missing emulator at ${emulator}; set ANDROID_SDK_ROOT or ANDROID_HOME`);
assert.ok(
  existsSync(apkPath),
  `missing debug APK at ${apkPath}; run npm run tauri:android:build:debug before this smoke`,
);

let spawnedEmulator: ManagedProcess | null = null;
let serial = await firstReadyDevice();

try {
  if (!serial) {
    spawnedEmulator = spawnManaged(
      emulator,
      ["-avd", avdName, "-no-snapshot", "-no-audio", "-no-window", "-gpu", "swiftshader_indirect", "-skin", "1080x2220"],
      shellRoot,
    );
    serial = await waitForDevice(180_000);
  }

  assert.ok(serial, "expected an Android emulator or device to become ready");
  await waitForBoot(serial, 180_000);
  await unlockDevice(serial);
  await runAdb(serial, ["install", "-r", apkPath], 120_000);
  await runAdb(serial, ["shell", "pm", "clear", appId], 30_000);

  const first = await launchAndProbe(serial);
  await runAdb(serial, ["shell", "am", "force-stop", appId], 30_000);
  const second = await launchAndProbe(serial);
  const publicKeyAfterRestart = second.publicKeyBase64;
  await runAdb(serial, ["shell", "pm", "clear", appId], 30_000);
  const third = await launchAndProbe(serial);
  const publicKeyAfterClear = third.publicKeyBase64;

  assert.equal(publicKeyAfterRestart, first.publicKeyBase64);
  assert.equal(second.signatureBase64, first.signatureBase64);
  assert.notEqual(publicKeyAfterClear, first.publicKeyBase64);
  assertAndroidCarrierSignature(first.publicKeyBase64, first.transcript, first.signatureBase64);
  assertAndroidCarrierSignature(publicKeyAfterRestart, second.transcript, second.signatureBase64);
  assertAndroidCarrierSignature(publicKeyAfterClear, third.transcript, third.signatureBase64);
} finally {
  if (serial) {
    await runAdb(serial, ["forward", "--remove-all"], 10_000).catch(() => undefined);
  }
  if (spawnedEmulator && serial) {
    await runAdb(serial, ["emu", "kill"], 10_000).catch(() => undefined);
  }
  await spawnedEmulator?.stop();
}

console.log("\x1b[32m✓ Township Android emulator native key smoke passed\x1b[0m");
process.exit(0);

async function launchAndProbe(serial: string): Promise<{
  publicKeyBase64: string;
  signatureBase64: string;
  transcript: Uint8Array;
}> {
  await runAdb(serial, ["shell", "am", "force-stop", appId], 30_000);
  await runAdb(serial, ["shell", "am", "start", "-n", appActivity], 30_000);

  const cdp = await connectToAppWebView(serial);
  try {
    await cdp.send("Runtime.enable");
    await waitForTauriInvoke(cdp);
    const publicKeyBase64 = await tauriInvoke<string>(cdp, "lattice_ensure_carrier_key", { keyId });
    const publicKey = Buffer.from(publicKeyBase64, "base64");
    assert.equal(publicKey.length, 32, "Android native carrier public key should be 32 bytes");

    const challenge = {
      type: "carrier_challenge",
      local_realm: vector.client.realm,
      replica: vector.replica,
      nonce: "android-emulator-native-key-smoke",
      server_nonce: Buffer.alloc(32, 13).toString("base64url"),
      wire_version: 1,
      session_version: 2,
    } as const;
    const transcript = carrierTranscriptBytes(challenge, vector.client.realm, publicKey);
    const signatureBase64 = await tauriInvoke<string>(cdp, "lattice_sign_carrier", {
      keyId,
      bytes: Buffer.from(transcript).toString("base64"),
    });

    assertAndroidCarrierSignature(publicKeyBase64, transcript, signatureBase64);
    return { publicKeyBase64, signatureBase64, transcript };
  } finally {
    cdp.close();
  }
}

async function connectToAppWebView(serial: string): Promise<CdpClient> {
  const pid = await waitForPid(serial, 60_000);
  const socketName = await webviewDevtoolsSocket(serial, pid);
  const port = await freePort();
  await runAdb(serial, ["forward", `tcp:${port}`, `localabstract:${socketName}`], 30_000);
  const target = await waitForCdpTarget(port, 30_000);
  assert.ok(target.webSocketDebuggerUrl, "expected WebView CDP websocket URL");
  return connectCdp(target.webSocketDebuggerUrl);
}

async function waitForTauriInvoke(cdp: CdpClient): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const hasInvoke = await evaluate<boolean>(
      cdp,
      'Boolean(globalThis.isTauri && window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === "function")',
    );
    if (hasInvoke) return;
    await delay(250);
  }
  throw new Error("Tauri WebView bridge did not expose window.__TAURI_INTERNALS__.invoke");
}

async function tauriInvoke<T>(cdp: CdpClient, command: string, args: Record<string, unknown>): Promise<T> {
  return evaluate<T>(
    cdp,
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
  );
}

async function evaluate<T>(cdp: CdpClient, expression: string): Promise<T> {
  const response = await cdp.send<{
    exceptionDetails?: { text?: string; exception?: { description?: string } };
    result: { value?: T; description?: string };
  }>("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "CDP evaluation failed");
  }

  return response.result.value as T;
}

function assertAndroidCarrierSignature(publicKeyBase64: string, transcript: Uint8Array, signatureBase64: string): void {
  const publicKey = Buffer.from(publicKeyBase64, "base64");
  const signature = Buffer.from(signatureBase64, "base64");
  assert.equal(signature.length, 64, "Android native carrier signature should be 64 bytes");
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey]),
    format: "der",
    type: "spki",
  });
  assert.equal(edVerify(null, Buffer.from(transcript), key, signature), true);
}

async function waitForCdpTarget(port: number, timeoutMs: number): Promise<CdpTarget> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const targets = (await response.json()) as CdpTarget[];
        const target = targets.find((candidate) => candidate.webSocketDebuggerUrl);
        if (target) return target;
      }
    } catch {
      // keep polling while the WebView exposes its devtools target
    }
    await delay(250);
  }
  throw new Error(`timed out waiting for WebView CDP target on localhost:${port}`);
}

function connectCdp(url: string): Promise<CdpClient> {
  assert.equal(typeof WebSocket, "function", "Node.js WebSocket global is required for Android CDP smoke");

  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
    if (message.id === undefined) return;
    const callbacks = pending.get(message.id);
    if (!callbacks) return;
    pending.delete(message.id);
    if (message.error) callbacks.reject(new Error(message.error.message ?? "CDP command failed"));
    else callbacks.resolve(message.result);
  });

  socket.addEventListener("close", () => {
    for (const callbacks of pending.values()) {
      callbacks.reject(new Error("CDP websocket closed"));
    }
    pending.clear();
  });

  return new Promise((resolveClient, rejectClient) => {
    socket.addEventListener("open", () => {
      resolveClient({
        close() {
          socket.close();
        },
        send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise<T>((resolveSend, rejectSend) => {
            pending.set(id, {
              resolve(value) {
                resolveSend(value as T);
              },
              reject: rejectSend,
            });
          });
        },
      });
    });
    socket.addEventListener("error", () => rejectClient(new Error(`failed to connect to CDP websocket ${url}`)));
  });
}

async function webviewDevtoolsSocket(serial: string, pid: string): Promise<string> {
  const sockets = await runAdb(serial, ["shell", "cat", "/proc/net/unix"], 30_000);
  const names = sockets
    .split(/\r?\n/)
    .map((line) => line.match(/@?(webview_devtools_remote_\d+)/)?.[1])
    .filter((value): value is string => Boolean(value));
  return names.find((name) => name === `webview_devtools_remote_${pid}`) ?? names[0] ?? `webview_devtools_remote_${pid}`;
}

async function waitForPid(serial: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = (await runAdb(serial, ["shell", "pidof", appId], 10_000).catch(() => "")).trim().split(/\s+/)[0];
    if (pid) return pid;
    await delay(250);
  }
  throw new Error(`timed out waiting for ${appId} process`);
}

async function unlockDevice(serial: string): Promise<void> {
  await runAdb(serial, ["shell", "input", "keyevent", "KEYCODE_WAKEUP"], 10_000).catch(() => undefined);
  await runAdb(serial, ["shell", "wm", "dismiss-keyguard"], 10_000).catch(() => undefined);
}

async function waitForBoot(serial: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const booted = (await runAdb(serial, ["shell", "getprop", "sys.boot_completed"], 10_000).catch(() => "")).trim();
    if (booted === "1") return;
    await delay(1_000);
  }
  throw new Error(`timed out waiting for ${serial} to boot`);
}

async function waitForDevice(timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const serial = await firstReadyDevice();
    if (serial) return serial;
    await delay(1_000);
  }
  return null;
}

async function firstReadyDevice(): Promise<string | null> {
  const devices = await run(adb, ["devices"], shellRoot, 30_000);
  return (
    devices
      .split(/\r?\n/)
      .map((line) => line.match(/^(\S+)\s+device$/)?.[1])
      .find((candidate) => candidate === process.env.ANDROID_SERIAL) ??
    devices
      .split(/\r?\n/)
      .map((line) => line.match(/^(\S+)\s+device$/)?.[1])
      .find((candidate): candidate is string => Boolean(candidate)) ??
    null
  );
}

async function runAdb(serial: string, args: string[], timeoutMs: number): Promise<string> {
  return run(adb, ["-s", serial, ...args], shellRoot, timeoutMs);
}

function spawnManaged(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): ManagedProcess {
  const child = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ANDROID_HOME: sdkRoot,
      ANDROID_SDK_ROOT: sdkRoot,
      ...env,
    },
  });
  const lines: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => lines.push(chunk.toString()));

  return {
    child,
    lines,
    async stop() {
      await stopProcess(child);
    },
  };
}

async function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  const proc = spawnManaged(command, args, cwd);
  const code = await Promise.race([waitForExit(proc.child), delay(timeoutMs).then(() => "timeout" as const)]);
  if (code === "timeout") {
    await proc.stop();
    throw new Error(`${command} ${args.join(" ")} timed out:\n${proc.lines.join("")}`);
  }
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${code}):\n${proc.lines.join("")}`);
  return proc.lines.join("");
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.killed || child.exitCode !== null) return;
  child.kill("SIGINT");
  const code = await Promise.race([waitForExit(child), delay(2_000).then(() => "timeout" as const)]);
  if (code === "timeout" && !child.killed && child.exitCode === null) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolveExit) => child.on("exit", (code) => resolveExit(code)));
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolvePort(address.port);
        else rejectPort(new Error("failed to allocate free localhost port"));
      });
    });
    server.on("error", rejectPort);
  });
}

function androidSdkRoot(): string {
  return process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? join(homedir(), "Library", "Android", "sdk");
}

function delay(ms: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
