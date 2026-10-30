import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// Shared simulator helpers for the Plan 077 iOS protected-key smokes. They read only the public
// probe evidence (key id, public key, signature byte count, outcome, store, slot) from the
// simulator log; no seed or private-key material is ever logged or parsed.

export interface SimulatorDevice {
  deviceTypeIdentifier?: string;
  isAvailable: boolean;
  name: string;
  runtime: string;
  state: string;
  udid: string;
}

interface SimctlDeviceJson {
  devices: Record<string, Array<Omit<SimulatorDevice, "runtime">>>;
}

export interface KeyProbeResult {
  controlPublicKeyBase64Url: string;
  pid: string;
  primaryPublicKeyBase64Url: string;
}

const execFile = promisify(execFileCallback);
const here = dirname(fileURLToPath(import.meta.url));
export const shellRoot = resolve(here, "..", "..");
export const appId = "dev.treetop.lattice.township";
export const probePrefix = "township-ios-key-reuse-probe";
export const primaryKeyId = "township-resident";
export const controlKeyId = "township-ios-key-reuse-control";
export const appPath = resolve(
  process.env.TOWNSHIP_IOS_APP ??
    join(
      shellRoot,
      "src-tauri",
      "gen",
      "apple",
      "build",
      "township-tauri-shell_iOS.xcarchive",
      "Products",
      "Applications",
      "Township.app",
    ),
);

export async function assertSimulatorAppReady(bundlePath: string = appPath): Promise<void> {
  assert.equal(process.platform, "darwin", "the iOS simulator smoke requires macOS");
  assert.ok(
    existsSync(bundlePath),
    `missing iOS simulator app at ${bundlePath}; run npm run tauri:ios:build:key-reuse-probe first`,
  );
  const executable = join(bundlePath, "Township");
  const loadCommands = await run("otool", ["-l", executable], 30_000);
  assert.match(
    loadCommands,
    /sectname __entitlements/,
    "simulator app lacks embedded entitlements; rebuild with ENTITLEMENTS_ALLOWED=YES and APPLE_DEVELOPMENT_TEAM",
  );
}

export async function listSimulators(): Promise<SimulatorDevice[]> {
  const listed = JSON.parse(
    await run("xcrun", ["simctl", "list", "devices", "available", "-j"], 30_000),
  ) as SimctlDeviceJson;
  return Object.entries(listed.devices).flatMap(([runtime, runtimeDevices]) =>
    runtimeDevices.map((device) => ({ ...device, runtime })),
  );
}

export async function selectSimulator(): Promise<SimulatorDevice> {
  const devices = await listSimulators();
  const requestedUdid = process.env.TOWNSHIP_IOS_SIMULATOR_UDID?.trim();
  if (requestedUdid) {
    const requested = devices.find((device) => device.udid === requestedUdid && device.isAvailable);
    assert.ok(requested, `TOWNSHIP_IOS_SIMULATOR_UDID ${requestedUdid} is not available`);
    return requested;
  }

  const iPhones = devices.filter((device) => device.isAvailable && device.name.startsWith("iPhone"));
  const selected =
    iPhones.find((device) => device.state === "Booted") ??
    iPhones.find((device) => device.runtime.endsWith("iOS-18-6") && device.name === "iPhone 16 Pro") ??
    iPhones[0];
  assert.ok(selected, "no available iPhone simulator found; set TOWNSHIP_IOS_SIMULATOR_UDID");
  return selected;
}

export async function bootSimulator(udid: string, bootTimeoutMs = 180_000): Promise<void> {
  // A first boot after create or erase can hold `simctl boot` itself for minutes; killing it
  // part-way leaves the simulator shut down, so it gets the same budget as the boot wait.
  await run("xcrun", ["simctl", "boot", udid], bootTimeoutMs);
  await waitForBoot(udid, bootTimeoutMs);
}

export async function waitForBoot(udid: string, timeoutMs = 180_000): Promise<void> {
  await run("xcrun", ["simctl", "bootstatus", udid, "-b"], timeoutMs);
}

export async function shutdownSimulator(udid: string): Promise<void> {
  await run("xcrun", ["simctl", "shutdown", udid], 60_000);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const device = (await listSimulators()).find((candidate) => candidate.udid === udid);
    if (device?.state === "Shutdown") return;
    await delay(500);
  }
  throw new Error(`simulator ${udid} did not reach Shutdown`);
}

export async function installApp(udid: string, bundlePath: string = appPath): Promise<void> {
  await run("xcrun", ["simctl", "install", udid, bundlePath], 120_000);
}

export async function terminateApp(udid: string): Promise<void> {
  await run("xcrun", ["simctl", "terminate", udid, appId], 30_000);
}

export async function launchAndProbe(udid: string, probeTimeoutMs = 60_000): Promise<KeyProbeResult> {
  // Only records logged after this launch count: a PID can be reused after a reboot, and the
  // earlier launch's probe lines would otherwise match and pass with stale keys.
  const launchedAt = Date.now();
  const output = await run("xcrun", ["simctl", "launch", udid, appId], 60_000);
  const pid = output.match(/:\s+(\d+)\s*$/m)?.[1];
  assert.ok(pid, `simctl launch did not return a process id: ${output.trim()}`);

  const lines = await waitForProbeLines(udid, pid, launchedAt, probeTimeoutMs);
  const probes = new Map(
    lines.map((line) => {
      const fields = parseProbeFields(line);
      return [fields.slot, { fields, line }] as const;
    }),
  );
  const primaryPublicKeyBase64Url = assertReadyKeyProbe(probes.get("primary"), primaryKeyId);
  const controlPublicKeyBase64Url = assertReadyKeyProbe(probes.get("control"), controlKeyId);
  assert.notEqual(
    primaryPublicKeyBase64Url,
    controlPublicKeyBase64Url,
    "independently named iOS protected keys should not collapse to one constant key",
  );
  return { controlPublicKeyBase64Url, pid, primaryPublicKeyBase64Url };
}

async function waitForProbeLines(
  udid: string,
  pid: string,
  launchedAt: number,
  timeoutMs: number,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  const predicate = `processIdentifier == ${pid} AND eventMessage CONTAINS "${probePrefix}"`;

  let lastError: unknown;

  while (Date.now() < deadline) {
    // On a freshly erased simulator's first boot the log store is still settling, so `log show`
    // can fail or run long. Treat that as "not yet" and retry within the overall deadline.
    const logs = await run(
      "xcrun",
      [
        "simctl",
        "spawn",
        udid,
        "log",
        "show",
        "--start",
        logStartTime(launchedAt),
        "--style",
        "compact",
        "--predicate",
        predicate,
      ],
      Math.max(5_000, Math.min(60_000, deadline - Date.now())),
    ).catch((error: unknown) => {
      lastError = error;
      return "";
    });
    const lines = logs
      .split(/\r?\n/)
      .filter((candidate) => candidate.includes(`LATTICE_PROBE: ${probePrefix} `))
      // `--start` is whole seconds; drop records from earlier in that same second.
      .filter((candidate) => (logRecordTime(candidate) ?? -Infinity) >= launchedAt)
      .map((line) => line.slice(line.indexOf(probePrefix)));
    const slots = new Set(lines.map((line) => parseProbeFields(line).slot));
    if (slots.has("primary") && slots.has("control")) return lines;
    await delay(250);
  }

  const reason = lastError === undefined ? "" : `; last log read failed: ${String(lastError)}`;
  throw new Error(`timed out waiting for ${probePrefix} from Township pid ${pid}${reason}`);
}

// The simulator shares the host clock and `log show` reads and prints local time.
function logStartTime(ms: number): string {
  const at = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

function logRecordTime(line: string): number | undefined {
  const stamp = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})/);
  return stamp ? new Date(`${stamp[1]}T${stamp[2]}`).getTime() : undefined;
}

function assertReadyKeyProbe(
  probe: { fields: Record<string, string>; line: string } | undefined,
  expectedKeyId: string,
): string {
  assert.ok(probe, `missing iOS protected-key probe for ${expectedKeyId}`);
  const { fields, line } = probe;
  assert.equal(fields.outcome, "ready", `iOS protected-key probe failed: ${line}`);
  assert.equal(fields.store, "ios_protected_keychain");
  assert.equal(fields.key_id, expectedKeyId);
  assert.equal(fields.signature_bytes, "64");
  assert.ok(fields.public_key_base64url, `probe omitted public key: ${line}`);

  const publicKey = Buffer.from(fields.public_key_base64url, "base64url");
  assert.equal(publicKey.byteLength, 32, "iOS protected carrier public key should be 32 bytes");
  return fields.public_key_base64url;
}

function parseProbeFields(line: string): Record<string, string> {
  return Object.fromEntries(
    line
      .trim()
      .split(/\s+/)
      .slice(1)
      .map((field) => {
        const separator = field.indexOf("=");
        return separator === -1 ? [field, ""] : [field.slice(0, separator), field.slice(separator + 1)];
      }),
  );
}

export async function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout, stderr } = await execFile(file, args, {
      cwd: shellRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    const detail = [failed.stderr, failed.stdout].find((text) => text?.trim()) ?? failed.message;
    throw new Error(`${file} ${args.join(" ")} failed: ${detail}`);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
