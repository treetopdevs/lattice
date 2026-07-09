import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  stop(): Promise<void>;
}

export interface CdpClient {
  close(): void;
  send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

interface CdpTarget {
  webSocketDebuggerUrl?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
export const shellRoot = resolve(here, "../..");
export const appId = "dev.treetop.lattice.township";
export const appActivity = `${appId}/.MainActivity`;
export const defaultAvd = "Pixel_3a_API_34_extension_level_7_arm64-v8a";
export const sdkRoot = androidSdkRoot();
export const adb = join(sdkRoot, "platform-tools", "adb");
export const emulator = join(sdkRoot, "emulator", "emulator");

export function defaultDebugApkPath(): string {
  return resolve(
    process.env.TOWNSHIP_ANDROID_APK ??
      join(
        shellRoot,
        "src-tauri",
        "gen",
        "android",
        "app",
        "build",
        "outputs",
        "apk",
        "universal",
        "debug",
        "app-universal-debug.apk",
      ),
  );
}

export async function ensureAndroidDevice(): Promise<{
  serial: string;
  spawnedEmulator: ManagedProcess | null;
}> {
  assert.ok(existsSync(adb), `missing adb at ${adb}; set ANDROID_SDK_ROOT or ANDROID_HOME`);
  assert.ok(existsSync(emulator), `missing emulator at ${emulator}; set ANDROID_SDK_ROOT or ANDROID_HOME`);

  let spawnedEmulator: ManagedProcess | null = null;
  let serial = await firstReadyDevice();
  if (!serial) {
    spawnedEmulator = spawnManaged(
      emulator,
      [
        "-avd",
        process.env.TOWNSHIP_ANDROID_AVD ?? defaultAvd,
        "-no-snapshot",
        "-no-audio",
        "-no-window",
        "-gpu",
        "swiftshader_indirect",
        "-skin",
        "1080x2220",
      ],
      shellRoot,
    );
    serial = await waitForDevice(180_000);
  }

  assert.ok(serial, "expected an Android emulator or device to become ready");
  await waitForBoot(serial, 180_000);
  await unlockDevice(serial);
  return { serial, spawnedEmulator };
}

export async function installDebugApk(serial: string, apkPath = defaultDebugApkPath()): Promise<void> {
  assert.ok(
    existsSync(apkPath),
    `missing debug APK at ${apkPath}; run npm run tauri:android:build:debug before this smoke`,
  );
  await runAdb(serial, ["install", "-r", apkPath], 120_000);
}

export async function launchApp(serial: string): Promise<void> {
  await runAdb(serial, ["shell", "am", "start", "-n", appActivity], 30_000);
}

export async function forceStopApp(serial: string): Promise<void> {
  await runAdb(serial, ["shell", "am", "force-stop", appId], 30_000);
}

export async function clearAppData(serial: string): Promise<void> {
  await runAdb(serial, ["shell", "pm", "clear", appId], 30_000);
}

export async function connectToAppWebView(serial: string): Promise<CdpClient> {
  const pid = await waitForPid(serial, 60_000);
  const socketName = await webviewDevtoolsSocket(serial, pid);
  const port = await freePort();
  await runAdb(serial, ["forward", `tcp:${port}`, `localabstract:${socketName}`], 30_000);
  const target = await waitForCdpTarget(port, 30_000);
  assert.ok(target.webSocketDebuggerUrl, "expected WebView CDP websocket URL");
  return connectCdp(target.webSocketDebuggerUrl);
}

export async function waitForTauriInvoke(cdp: CdpClient): Promise<void> {
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

export async function tauriInvoke<T>(
  cdp: CdpClient,
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return evaluate<T>(
    cdp,
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
  );
}

export async function clickButtonByText(cdp: CdpClient, text: string): Promise<void> {
  const expected = JSON.stringify(text);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const clicked = await evaluate<boolean>(
      cdp,
      `(() => {
        const button = Array.from(document.querySelectorAll("button"))
          .find((candidate) => candidate.textContent?.trim() === ${expected});
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })()`,
    );
    if (clicked) return;
    await delay(250);
  }
  throw new Error(`timed out waiting to click button ${text}`);
}

export async function fillTextareaByLabel(cdp: CdpClient, label: string, value: string): Promise<void> {
  await fillControlByLabel(cdp, "textarea", label, value);
}

export async function fillInputByLabel(cdp: CdpClient, label: string, value: string): Promise<void> {
  await fillControlByLabel(cdp, "input", label, value);
}

async function fillControlByLabel(cdp: CdpClient, selector: "input" | "textarea", label: string, value: string): Promise<void> {
  const expectedLabel = JSON.stringify(label);
  const desiredValue = JSON.stringify(value);
  const selectorLiteral = JSON.stringify(selector);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const filled = await evaluate<boolean>(
      cdp,
      `(() => {
        const control = Array.from(document.querySelectorAll(${selectorLiteral}))
          .find((candidate) => candidate.getAttribute("aria-label") === ${expectedLabel});
        if (!control) return false;
        control.focus();
        control.value = ${desiredValue};
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`,
    );
    if (filled) return;
    await delay(250);
  }
  throw new Error(`timed out waiting to fill ${selector} ${label}`);
}

export async function waitForDocumentText(cdp: CdpClient, text: string, timeoutMs = 60_000): Promise<void> {
  const expected = JSON.stringify(text);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await evaluate<boolean>(cdp, `document.body?.innerText.includes(${expected}) ?? false`);
    if (found) return;
    await delay(250);
  }
  throw new Error(`timed out waiting for document text: ${text}\n\n${await documentText(cdp)}`);
}

export async function documentText(cdp: CdpClient): Promise<string> {
  return evaluate<string>(cdp, "document.body?.innerText ?? ''");
}

export async function evaluate<T>(cdp: CdpClient, expression: string): Promise<T> {
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

export async function cleanupAndroid(serial: string | null, spawnedEmulator: ManagedProcess | null): Promise<void> {
  if (serial) {
    await runAdb(serial, ["forward", "--remove-all"], 10_000).catch(() => undefined);
  }
  if (spawnedEmulator && serial) {
    await runAdb(serial, ["emu", "kill"], 10_000).catch(() => undefined);
  }
  await spawnedEmulator?.stop();
}

export async function runAdb(serial: string, args: string[], timeoutMs: number): Promise<string> {
  return run(adb, ["-s", serial, ...args], shellRoot, timeoutMs);
}

export function spawnManaged(
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

export function delay(ms: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
