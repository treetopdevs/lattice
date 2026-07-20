import assert from "node:assert/strict";
import {
  execFile as execFileCallback,
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { developmentEntitlementErrors } from "./support/ios_entitlement_scope.mjs";

interface DeviceProcess {
  processIdentifier?: number;
}

interface DeviceProcessResult {
  result?: {
    runningProcesses?: DeviceProcess[];
  };
}

interface LaunchProbe {
  controlPublicKeyBase64Url: string;
  pid: string;
  primaryPublicKeyBase64Url: string;
  waitForExit(): Promise<void>;
}

interface ProbeLine {
  fields: Record<string, string>;
  line: string;
}

interface StreamingLaunch {
  child: Pick<ChildProcess, "exitCode" | "kill" | "signalCode">;
  exit: Promise<void>;
  processId?: string;
  probeOutput: Promise<string>;
}

const execFile = promisify(execFileCallback);
const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");
const appId = "dev.treetop.lattice.township";
const probePrefix = "township-ios-key-reuse-probe";
const EXIT_TIMEOUT_MS = 20_000;
const EXIT_KILL_GRACE_MS = 3_000;
const appPath = join(
  shellRoot,
  "src-tauri",
  "target",
  "township-ios-device-key-reuse.xcarchive",
  "Products",
  "Applications",
  "Township.app",
);
const deviceUdid = process.env.TOWNSHIP_IOS_DEVICE_UDID?.trim();

console.log("\nTownship iOS physical-device protected-key relaunch smoke");

assert.equal(
  process.platform,
  "darwin",
  "the iOS physical-device smoke requires macOS",
);
assert.match(
  deviceUdid ?? "",
  /^[0-9A-F]{8}-[0-9A-F]{16}$/i,
  "set TOWNSHIP_IOS_DEVICE_UDID to the attached physical iPhone UDID",
);
assert.ok(deviceUdid);
assert.ok(
  existsSync(appPath),
  `missing iOS device app; run npm run tauri:ios:build:device-key-reuse-probe first`,
);

const selectedDeviceDeveloperDir = runPreflight(
  "xcode-select",
  ["-p"],
  process.env,
);
const deviceDeveloperDir =
  process.env.TOWNSHIP_IOS_DEVICE_DEVELOPER_DIR?.trim() ||
  selectedDeviceDeveloperDir;
assert.ok(
  existsSync(deviceDeveloperDir),
  "selected iOS device developer directory does not exist",
);
const deviceToolEnv: NodeJS.ProcessEnv = {
  ...process.env,
  DEVELOPER_DIR: deviceDeveloperDir,
};
runPreflight("xcrun", ["devicectl", "--version"], deviceToolEnv);

const tempRoot = mkdtempSync(join(tmpdir(), "township-ios-device-probe-"));
const activeLaunches = new Set<StreamingLaunch>();
let jsonSequence = 0;

try {
  await assertSignedDeviceApp();
  await runDeviceJson(
    ["device", "install", "app", "--device", deviceUdid, appPath],
    "install",
  );

  const first = await launchAndProbe(deviceUdid);
  await assertProcessPresent(deviceUdid, first.pid);
  await terminateApp(deviceUdid, first.pid);
  await first.waitForExit();
  await assertProcessAbsent(deviceUdid, first.pid);
  const second = await launchAndProbe(deviceUdid);
  await assertProcessPresent(deviceUdid, second.pid);

  const publicKeyAfterRelaunch = second.primaryPublicKeyBase64Url;
  const controlPublicKeyAfterRelaunch = second.controlPublicKeyBase64Url;

  assert.notEqual(
    second.pid,
    first.pid,
    "iOS app process id did not change after terminate/relaunch",
  );
  assert.notEqual(
    first.primaryPublicKeyBase64Url,
    first.controlPublicKeyBase64Url,
    "independently named protected keys collapsed to one value",
  );
  assert.equal(
    publicKeyAfterRelaunch,
    first.primaryPublicKeyBase64Url,
    "primary protected key changed after process relaunch",
  );
  assert.equal(
    controlPublicKeyAfterRelaunch,
    first.controlPublicKeyBase64Url,
    "control protected key changed after process relaunch",
  );

  await terminateApp(deviceUdid, second.pid);
  await second.waitForExit();
  await assertProcessAbsent(deviceUdid, second.pid);
} finally {
  for (const launch of activeLaunches) {
    if (launch.processId) {
      await terminateApp(deviceUdid, launch.processId).catch(() => undefined);
    }
    stopConsoleLaunch(launch);
    await waitForConsoleExit(launch).catch(() => undefined);
  }
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log(
  "Township iOS physical-device protected keys survived process relaunch",
);

async function assertSignedDeviceApp(): Promise<void> {
  assert.ok(
    existsSync(join(appPath, "embedded.mobileprovision")),
    "device app lacks an embedded provisioning profile",
  );
  await run("codesign", ["--verify", "--deep", "--strict", appPath], 30_000);
  const signingDetails = await run(
    "codesign",
    ["--display", "--verbose=4", appPath],
    30_000,
  );
  assert.ok(
    signingDetails.includes("Authority=Apple Development:"),
    "device app was not signed by an Apple Development identity",
  );
  const entitlements = await run(
    "codesign",
    ["--display", "--entitlements", ":-", appPath],
    30_000,
  );
  assertDevelopmentEntitlementScope(entitlements);
}

async function launchAndProbe(target: string): Promise<LaunchProbe> {
  const launch = launchWithConsole(target);
  activeLaunches.add(launch);
  const consoleOutput = await launch.probeOutput;
  const probes = parseProbeLines(consoleOutput);
  const primary = probes.get("primary");
  const pid = primary?.fields.process_id ?? "";
  assert.match(pid, /^\d+$/, "physical iOS probe omitted its process id");
  launch.processId = pid;
  const primaryPublicKeyBase64Url = assertReadyKeyProbe(
    probes.get("primary"),
    "township-resident",
    pid,
  );
  const controlPublicKeyBase64Url = assertReadyKeyProbe(
    probes.get("control"),
    "township-ios-key-reuse-control",
    pid,
  );
  return {
    controlPublicKeyBase64Url,
    pid,
    primaryPublicKeyBase64Url,
    async waitForExit() {
      try {
        await waitForConsoleExit(launch);
      } finally {
        activeLaunches.delete(launch);
      }
    },
  };
}

function launchWithConsole(target: string): StreamingLaunch {
  const child = spawn(
    "xcrun",
    [
      "devicectl",
      "device",
      "process",
      "launch",
      "--device",
      target,
      "--terminate-existing",
      "--console",
      appId,
    ],
    { cwd: shellRoot, env: deviceToolEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let probeSettled = false;
  let exitSettled = false;
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  const probeOutput = new Promise<string>((resolveProbe, rejectProbe) => {
    const timeout = setTimeout(() => {
      if (probeSettled) return;
      probeSettled = true;
      const pid = parseProbeProcessId(output);
      if (pid) void terminateApp(target, pid).catch(() => undefined);
      child.kill("SIGINT");
      rejectProbe(
        new Error(
          redactCommandOutput(
            `timed out waiting for physical iOS probe: ${output}`,
            target,
          ),
        ),
      );
    }, 60_000);

    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (probeSettled || !hasBothProbeSlots(output)) return;
      probeSettled = true;
      clearTimeout(timeout);
      resolveProbe(output);
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (!probeSettled) {
        probeSettled = true;
        rejectProbe(
          new Error(
            redactCommandOutput(
              `unable to launch physical iOS probe: ${error.message}`,
              target,
            ),
          ),
        );
      }
      if (!exitSettled) {
        exitSettled = true;
        resolveExit();
      }
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (!probeSettled) {
        probeSettled = true;
        rejectProbe(
          new Error(
            redactCommandOutput(
              `physical iOS probe exited before evidence (${code ?? signal}): ${output}`,
              target,
            ),
          ),
        );
      }
      if (!exitSettled) {
        exitSettled = true;
        resolveExit();
      }
    });
  });

  return { child, exit, probeOutput };
}

function hasBothProbeSlots(output: string): boolean {
  const probes = parseProbeLines(output);
  return probes.has("primary") && probes.has("control");
}

function parseProbeProcessId(output: string): string | undefined {
  return [...parseProbeLines(output).values()]
    .map((probe) => probe.fields.process_id)
    .find((pid) => /^\d+$/.test(pid ?? ""));
}

function parseProbeLines(output: string): Map<string, ProbeLine> {
  return new Map(
    output
      .split(/\r?\n/)
      .filter((line) => line.includes(probePrefix))
      .map((line) => {
        const event = line.slice(line.indexOf(probePrefix));
        const fields = Object.fromEntries(
          event
            .trim()
            .split(/\s+/)
            .slice(1)
            .map((field) => {
              const separator = field.indexOf("=");
              return separator === -1
                ? [field, ""]
                : [field.slice(0, separator), field.slice(separator + 1)];
            }),
        );
        return [fields.slot ?? "", { fields, line: event }] as const;
      }),
  );
}

function assertReadyKeyProbe(
  probe: ProbeLine | undefined,
  expectedKeyId: string,
  pid: string,
): string {
  assert.ok(probe, `missing protected-key probe for ${expectedKeyId}`);
  const { fields } = probe;
  assert.equal(
    fields.outcome,
    "ready",
    "physical iOS protected-key probe did not become ready",
  );
  assert.equal(fields.store, "ios_protected_keychain");
  assert.equal(fields.key_id, expectedKeyId);
  assert.equal(fields.signature_bytes, "64");
  assert.equal(fields.process_id, pid);
  const publicKeyBase64Url = fields.public_key_base64url ?? "";
  const publicKey = Buffer.from(publicKeyBase64Url, "base64url");
  assert.equal(
    publicKey.byteLength,
    32,
    "physical iOS protected public key should be 32 bytes",
  );
  return publicKeyBase64Url;
}

function assertDevelopmentEntitlementScope(entitlements: string): void {
  assert.deepEqual(
    developmentEntitlementErrors(entitlements, appId),
    [],
    "device app lacks a valid development-signing keychain scope",
  );
}

async function waitForConsoleExit(launch: StreamingLaunch): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      launch.exit,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                "physical iOS console launch did not exit after app termination",
              ),
            ),
          EXIT_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    stopConsoleLaunch(launch);
    await Promise.race([
      launch.exit,
      new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, EXIT_KILL_GRACE_MS),
      ),
    ]);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function stopConsoleLaunch(launch: StreamingLaunch): void {
  if (launch.child.exitCode !== null || launch.child.signalCode !== null)
    return;
  launch.child.kill("SIGINT");
  const killTimer = setTimeout(() => {
    if (launch.child.exitCode === null && launch.child.signalCode === null) {
      launch.child.kill("SIGKILL");
    }
  }, EXIT_KILL_GRACE_MS);
  killTimer.unref();
}

async function terminateApp(target: string, pid: string): Promise<void> {
  await runDeviceJson(
    ["device", "process", "terminate", "--device", target, "--pid", pid],
    "terminate",
  );
}

async function assertProcessPresent(
  target: string,
  pid: string,
): Promise<void> {
  assert.equal(
    await processIsPresent(target, pid),
    true,
    "physical iOS app process was not observable after launch",
  );
}

async function assertProcessAbsent(target: string, pid: string): Promise<void> {
  assert.equal(
    await processIsPresent(target, pid),
    false,
    "physical iOS app process remained after termination",
  );
}

async function processIsPresent(target: string, pid: string): Promise<boolean> {
  const result = await runDeviceJson<DeviceProcessResult>(
    ["device", "info", "processes", "--device", target],
    "processes",
  );
  return (result.result?.runningProcesses ?? []).some(
    (process) => String(process.processIdentifier ?? "") === pid,
  );
}

async function runDeviceJson<T>(args: string[], label: string): Promise<T> {
  jsonSequence += 1;
  const outputPath = join(tempRoot, `${jsonSequence}-${label}.json`);
  await run(
    "xcrun",
    ["devicectl", ...args, "--json-output", outputPath],
    60_000,
  );
  return JSON.parse(readFileSync(outputPath, "utf8")) as T;
}

async function run(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  try {
    const { stdout, stderr } = await execFile(file, args, {
      cwd: shellRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      env: file === "xcrun" ? deviceToolEnv : process.env,
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      redactCommandOutput(
        failed.stderr ?? failed.stdout ?? failed.message,
        deviceUdid ?? "",
      ),
    );
  }
}

function redactCommandOutput(value: string, deviceUdid: string): string {
  if (!deviceUdid) return redactGenericCommandOutput(value);
  return redactGenericCommandOutput(
    value.replaceAll(deviceUdid, "<physical-device>"),
  );
}

function redactGenericCommandOutput(value: string): string {
  let redacted = value;
  if (process.env.HOME) redacted = redacted.replaceAll(process.env.HOME, "~");
  return redacted
    .replace(/Apple Development:[^\r\n"]+/g, "Apple Development: <redacted>")
    .replace(/\b[0-9A-F]{8}-[0-9A-F]{16}\b/gi, "<physical-device>")
    .replace(/\b[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\b/gi, "<uuid>")
    .replace(/\b[0-9A-F]{40}\b/gi, "<certificate>")
    .replace(
      /\b[A-Z0-9]{10}(?=\.dev\.treetop\.lattice\.township\b)/g,
      "<apple-team>",
    );
}

function runPreflight(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): string {
  try {
    return execFileSync(file, args, {
      cwd: shellRoot,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(
      `unable to run iOS device-tool preflight: ${file} ${args.join(" ")}`,
    );
  }
}
