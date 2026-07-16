import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

interface SimulatorDevice {
  isAvailable: boolean;
  name: string;
  runtime: string;
  state: string;
  udid: string;
}

interface SimctlDeviceJson {
  devices: Record<string, Array<Omit<SimulatorDevice, "runtime">>>;
}

const execFile = promisify(execFileCallback);
const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");
const appId = "dev.treetop.lattice.township";
const probePrefix = "township-ios-key-reuse-probe";
const appPath = resolve(
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

console.log("\n▸ Township iOS simulator protected-key relaunch smoke");

assert.equal(process.platform, "darwin", "the iOS simulator smoke requires macOS");
assert.ok(
  existsSync(appPath),
  `missing iOS simulator app at ${appPath}; run npm run tauri:ios:build:key-reuse-probe first`,
);
await assertSimulatorEntitlementsEmbedded(appPath);

const simulator = await selectSimulator();
const bootedBySmoke = simulator.state !== "Booted";

try {
  if (bootedBySmoke) {
    await run("xcrun", ["simctl", "boot", simulator.udid], 30_000);
  }
  await run("xcrun", ["simctl", "bootstatus", simulator.udid, "-b"], 120_000);
  await terminateApp(simulator.udid).catch(() => undefined);
  await run("xcrun", ["simctl", "install", simulator.udid, appPath], 60_000);

  const first = await launchAndProbe(simulator.udid);
  await terminateApp(simulator.udid);
  const second = await launchAndProbe(simulator.udid);
  const publicKeyAfterRelaunch = second.primaryPublicKeyBase64Url;
  const controlPublicKeyAfterRelaunch = second.controlPublicKeyBase64Url;

  assert.notEqual(second.pid, first.pid, "iOS app process id did not change after terminate/relaunch");
  assert.notEqual(
    first.primaryPublicKeyBase64Url,
    first.controlPublicKeyBase64Url,
    "independently named iOS protected keys should not collapse to one constant key",
  );
  assert.equal(
    publicKeyAfterRelaunch,
    first.primaryPublicKeyBase64Url,
    "primary iOS protected key changed after process relaunch",
  );
  assert.equal(
    controlPublicKeyAfterRelaunch,
    first.controlPublicKeyBase64Url,
    "control iOS protected key changed after process relaunch",
  );
} finally {
  await terminateApp(simulator.udid).catch(() => undefined);
  if (bootedBySmoke) {
    await run("xcrun", ["simctl", "shutdown", simulator.udid], 30_000).catch(() => undefined);
  }
}

console.log("\x1b[32m✓ Township iOS simulator protected keys survived process relaunch\x1b[0m");

async function launchAndProbe(
  udid: string,
): Promise<{ controlPublicKeyBase64Url: string; pid: string; primaryPublicKeyBase64Url: string }> {
  const output = await run("xcrun", ["simctl", "launch", udid, appId], 30_000);
  const pid = output.match(/:\s+(\d+)\s*$/m)?.[1];
  assert.ok(pid, `simctl launch did not return a process id: ${output.trim()}`);

  const lines = await waitForProbeLines(udid, pid, 30_000);
  const probes = new Map(
    lines.map((line) => {
      const fields = parseProbeFields(line);
      return [fields.slot, { fields, line }] as const;
    }),
  );
  const primaryPublicKeyBase64Url = assertReadyKeyProbe(probes.get("primary"), "township-resident");
  const controlPublicKeyBase64Url = assertReadyKeyProbe(
    probes.get("control"),
    "township-ios-key-reuse-control",
  );
  assert.notEqual(primaryPublicKeyBase64Url, controlPublicKeyBase64Url);
  return { controlPublicKeyBase64Url, pid, primaryPublicKeyBase64Url };
}

async function waitForProbeLines(udid: string, pid: string, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  const predicate = `processIdentifier == ${pid} AND eventMessage CONTAINS "${probePrefix}"`;

  while (Date.now() < deadline) {
    const logs = await run(
      "xcrun",
      ["simctl", "spawn", udid, "log", "show", "--last", "2m", "--style", "compact", "--predicate", predicate],
      30_000,
    );
    const lines = logs
      .split(/\r?\n/)
      .filter((candidate) => candidate.includes(`LATTICE_PROBE: ${probePrefix} `))
      .map((line) => line.slice(line.indexOf(probePrefix)));
    const slots = new Set(lines.map((line) => parseProbeFields(line).slot));
    if (slots.has("primary") && slots.has("control")) return lines;
    await delay(250);
  }

  throw new Error(`timed out waiting for ${probePrefix} from Township pid ${pid}`);
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

async function assertSimulatorEntitlementsEmbedded(bundlePath: string): Promise<void> {
  const executable = join(bundlePath, "Township");
  const loadCommands = await run("otool", ["-l", executable], 30_000);
  assert.match(
    loadCommands,
    /sectname __entitlements/,
    "simulator app lacks embedded entitlements; rebuild with ENTITLEMENTS_ALLOWED=YES and APPLE_DEVELOPMENT_TEAM",
  );
}

async function selectSimulator(): Promise<SimulatorDevice> {
  const listed = JSON.parse(await run("xcrun", ["simctl", "list", "devices", "available", "-j"], 30_000)) as SimctlDeviceJson;
  const devices = Object.entries(listed.devices).flatMap(([runtime, runtimeDevices]) =>
    runtimeDevices.map((device) => ({ ...device, runtime })),
  );
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

async function terminateApp(udid: string): Promise<void> {
  await run("xcrun", ["simctl", "terminate", udid, appId], 30_000);
}

async function run(file: string, args: string[], timeoutMs: number): Promise<string> {
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
    throw new Error(`${file} ${args.join(" ")} failed: ${failed.stderr ?? failed.stdout ?? failed.message}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
