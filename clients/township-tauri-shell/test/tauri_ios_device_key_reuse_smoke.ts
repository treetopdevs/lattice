import assert from "node:assert/strict";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { developmentEntitlementErrors } from "./support/ios_entitlement_scope.mjs";
import { developmentProfileErrors } from "./support/ios_development_profile.mjs";
import {
  duplicateProfileEntitlementKeys,
  profileDateTimeMs,
  type NormalizedIosDevelopmentProfile,
} from "./support/ios_development_profile.mjs";
import {
  type IosDeviceProbeEvidence,
  type IosDeviceProbeRecord,
  createIosProbeCopyDestination,
  iosDeviceLaunchProcessId,
  iosDeviceProbeProgress,
  redactIosDeviceCommandOutput,
  secureIosProbeCopy,
} from "./support/ios_device_probe_output.mjs";

interface DeviceProcess {
  processIdentifier?: number;
}

interface DeviceProcessResult {
  result?: {
    runningProcesses?: DeviceProcess[];
  };
}

interface ListedDevice {
  deviceProperties?: { name?: string };
  hardwareProperties?: { udid?: string };
}

interface DeviceListResult {
  result?: { devices?: ListedDevice[] };
}

interface LaunchProbe {
  controlPublicKeyBase64Url: string;
  nonce: string;
  pid: string;
  primaryPublicKeyBase64Url: string;
}

const execFile = promisify(execFileCallback);
const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");
const appId = "dev.treetop.lattice.township";
const probePrefix = "township-ios-key-reuse-probe";
const probeArtifactDirectory = "Library/Caches";
const probeArtifactPrefix = "township-ios-key-reuse-probe-";
const ARTIFACT_TIMEOUT_MS = 60_000;
const ARTIFACT_POLL_INTERVAL_MS = 1_000;
const PROCESS_ABSENCE_TIMEOUT_MS = 20_000;
const PROCESS_POLL_INTERVAL_MS = 250;
const MINIMUM_PROFILE_REMAINING_MS = 24 * 60 * 60_000;
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
const expectedDevelopmentTeam =
  process.env.APPLE_DEVELOPMENT_TEAM?.trim() ?? "";
let physicalDeviceName = "";

function reportFatalError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(redactCommandOutput(message, deviceUdid ?? ""));
  process.exit(1);
}

process.on("uncaughtException", reportFatalError);
process.on("unhandledRejection", reportFatalError);

console.log("\nTownship iOS physical-device protected-key relaunch smoke");

assert.equal(
  process.platform,
  "darwin",
  "the iOS physical-device smoke requires macOS",
);
assert.match(
  deviceUdid ?? "",
  /^[0-9A-F]{8}-[0-9A-F]{16}$/i,
  "set TOWNSHIP_IOS_DEVICE_UDID to the attached physical iOS device UDID",
);
assert.ok(deviceUdid);
assert.equal(
  /^[A-Z0-9]{10}$/.test(expectedDevelopmentTeam),
  true,
  "set APPLE_DEVELOPMENT_TEAM to the selected Apple development team",
);
assert.ok(
  existsSync(appPath),
  "missing iOS device app; run npm run tauri:ios:build:device-key-reuse-probe first",
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
assert.equal(
  statSync(tempRoot).mode & 0o777,
  0o700,
  "physical iOS probe directory is not private",
);
const activeProcessIds = new Set<string>();
let jsonSequence = 0;
let launchSequence = 0;
let copySequence = 0;
process.on("exit", cleanupPhysicalProbeResources);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => terminateForSignal(signal));
}

try {
  physicalDeviceName = await selectedPhysicalDeviceName(deviceUdid);
  await assertSignedDeviceApp();
  await runDeviceJson(
    ["device", "install", "app", "--device", deviceUdid],
    "install",
    [appPath],
  );

  const first = await launchAndReadArtifact(deviceUdid);
  await assertProcessPresent(deviceUdid, first.pid);
  await terminateApp(deviceUdid, first.pid);
  await assertProcessAbsentEventually(deviceUdid, first.pid);
  activeProcessIds.delete(first.pid);

  const second = await launchAndReadArtifact(deviceUdid);
  await assertProcessPresent(deviceUdid, second.pid);

  const publicKeyAfterRelaunch = second.primaryPublicKeyBase64Url;
  const controlPublicKeyAfterRelaunch = second.controlPublicKeyBase64Url;

  assert.notEqual(
    second.nonce,
    first.nonce,
    "iOS probe launch nonce was reused",
  );
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
  await assertProcessAbsentEventually(deviceUdid, second.pid);
  activeProcessIds.delete(second.pid);
} finally {
  for (const pid of activeProcessIds) {
    await terminateApp(deviceUdid, pid).catch(() => undefined);
  }
  cleanupPhysicalProbeResources();
}

console.log(
  "Township iOS physical-device protected keys survived process relaunch",
);

async function assertSignedDeviceApp(): Promise<void> {
  const targetDeviceUdid = deviceUdid;
  assert.ok(targetDeviceUdid);
  const archivedBundleIdentifier = await readPlistRaw(
    join(appPath, "Info.plist"),
    "CFBundleIdentifier",
  );
  assert.equal(
    archivedBundleIdentifier,
    appId,
    "archived iOS app bundle identifier is not the Township app",
  );

  assert.ok(
    existsSync(join(appPath, "embedded.mobileprovision")),
    "device app lacks an embedded provisioning profile",
  );
  const embeddedProfilePath = join(appPath, "embedded.mobileprovision");
  const decodedProfilePath = join(tempRoot, "embedded-development-profile.plist");
  await run(
    "/usr/bin/security",
    ["cms", "-D", "-i", embeddedProfilePath, "-o", decodedProfilePath],
    30_000,
  );
  secureIosProbeCopy(decodedProfilePath);
  try {
    await run("/usr/bin/plutil", ["-lint", decodedProfilePath], 30_000);
  } catch {
    assert.fail("embedded iOS development profile is not a valid plist");
  }

  const profileEntitlementsValue = await readOptionalPlistJson(
    decodedProfilePath,
    "Entitlements",
  );
  const profileEntitlements = normalizeProfileEntitlements(
    profileEntitlementsValue,
  );
  const profile: NormalizedIosDevelopmentProfile = {
    teamIdentifiers: await readOptionalPlistJson(
      decodedProfilePath,
      "TeamIdentifier",
    ),
    applicationIdentifierPrefixes: await readOptionalPlistJson(
      decodedProfilePath,
      "ApplicationIdentifierPrefix",
    ),
    duplicateEntitlementKeys: duplicateProfileEntitlementKeys(
      readFileSync(decodedProfilePath, "utf8"),
    ),
    entitlements: profileEntitlements,
    provisionedDevices: await readOptionalPlistJson(
      decodedProfilePath,
      "ProvisionedDevices",
    ),
    provisionsAllDevices: await readOptionalPlistJson(
      decodedProfilePath,
      "ProvisionsAllDevices",
    ),
    creationTimeMs: profileDateTimeMs(
      await readOptionalPlistRaw(decodedProfilePath, "CreationDate"),
    ),
    expirationTimeMs: profileDateTimeMs(
      await readOptionalPlistRaw(decodedProfilePath, "ExpirationDate"),
    ),
  };
  const profileErrors = developmentProfileErrors(profile, {
    bundleIdentifier: archivedBundleIdentifier,
    deviceUdid: targetDeviceUdid,
    expectedTeamIdentifier: expectedDevelopmentTeam,
    minimumRemainingMs: MINIMUM_PROFILE_REMAINING_MS,
    nowMs: Date.now(),
  });
  assert.deepEqual(
    profileErrors,
    [],
    `embedded iOS development profile is invalid: ${profileErrors.join(", ")}`,
  );
  if (
    typeof profileEntitlements.applicationIdentifier !== "string" ||
    typeof profileEntitlements.teamIdentifier !== "string"
  ) {
    assert.fail("validated signing scope is not string-valued");
  }

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
  const entitlements = await runStdout(
    "codesign",
    ["--display", "--entitlements", ":-", appPath],
    30_000,
  );
  assertDevelopmentEntitlementScope(entitlements, {
    bundleIdentifier: archivedBundleIdentifier,
    expectedApplicationIdentifier: profileEntitlements.applicationIdentifier,
    expectedTeamIdentifier: profileEntitlements.teamIdentifier,
  });
}

function assertDevelopmentEntitlementScope(
  entitlements: string,
  options: {
    bundleIdentifier: string;
    expectedApplicationIdentifier: string;
    expectedTeamIdentifier: string;
  },
): void {
  const entitlementErrors = developmentEntitlementErrors(
    entitlements,
    options,
  );
  assert.deepEqual(
    entitlementErrors,
    [],
    `device app lacks a valid development-signing keychain scope: ${entitlementErrors.join(", ")}`,
  );
}

function normalizeProfileEntitlements(
  value: unknown,
): NormalizedIosDevelopmentProfile["entitlements"] {
  const entitlements =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    applicationIdentifier: entitlements["application-identifier"],
    teamIdentifier: entitlements["com.apple.developer.team-identifier"],
    getTaskAllow: entitlements["get-task-allow"],
    keychainAccessGroups: entitlements["keychain-access-groups"],
  };
}

async function readPlistJson(path: string, key: string): Promise<unknown> {
  return JSON.parse(
    await runStdout(
      "/usr/bin/plutil",
      ["-extract", key, "json", "-o", "-", path],
      30_000,
    ),
  ) as unknown;
}

async function readOptionalPlistJson(
  path: string,
  key: string,
): Promise<unknown> {
  try {
    return await readPlistJson(path, key);
  } catch {
    return undefined;
  }
}

async function readPlistRaw(path: string, key: string): Promise<string> {
  return (
    await runStdout(
      "/usr/bin/plutil",
      ["-extract", key, "raw", "-o", "-", path],
      30_000,
    )
  ).trim();
}

async function readOptionalPlistRaw(
  path: string,
  key: string,
): Promise<string | undefined> {
  try {
    return await readPlistRaw(path, key);
  } catch {
    return undefined;
  }
}

async function launchAndReadArtifact(target: string): Promise<LaunchProbe> {
  launchSequence += 1;
  const launch = launchSequence;
  const nonce = randomBytes(16).toString("hex");
  const launchResult = await runDeviceJson<unknown>(
    [
      "device",
      "process",
      "launch",
      "--device",
      target,
      "--terminate-existing",
      "--environment-variables",
      JSON.stringify({ TOWNSHIP_IOS_PROBE_LAUNCH_NONCE: nonce }),
    ],
    `launch-${launch}`,
    [appId],
  );
  const pid = iosDeviceLaunchProcessId(launchResult);
  activeProcessIds.add(pid);
  const evidence = await waitForProbeArtifact(target, launch, nonce, pid);
  assert.equal(evidence.processId, pid);
  assert.equal(evidence.launchNonce, nonce);
  const primaryPublicKeyBase64Url = assertReadyKeyProbe(
    evidence.primary,
    "township-resident",
    pid,
  );
  const controlPublicKeyBase64Url = assertReadyKeyProbe(
    evidence.control,
    "township-ios-key-reuse-control",
    pid,
  );
  return {
    controlPublicKeyBase64Url,
    nonce,
    pid,
    primaryPublicKeyBase64Url,
  };
}

async function waitForProbeArtifact(
  target: string,
  launch: number,
  nonce: string,
  pid: string,
): Promise<IosDeviceProbeEvidence> {
  const deadline = Date.now() + ARTIFACT_TIMEOUT_MS;
  const source = `${probeArtifactDirectory}/${probeArtifactPrefix}${nonce}.log`;
  let artifactAppeared = false;
  let lastCopyError: string | undefined;

  while (Date.now() < deadline) {
    copySequence += 1;
    const destination = createIosProbeCopyDestination(
      tempRoot,
      launch,
      copySequence,
    );
    const copy = await copyProbeArtifactOnce(target, source, destination);
    if (copy.error) lastCopyError = copy.error;
    const copiedPath = copy.path;
    if (copiedPath) {
      artifactAppeared = true;
      secureIosProbeCopy(copiedPath);
      const progress = iosDeviceProbeProgress(
        readFileSync(copiedPath, "utf8"),
        probePrefix,
        nonce,
        pid,
      );
      if (progress.evidence) return progress.evidence;
    }
    await sleep(ARTIFACT_POLL_INTERVAL_MS);
  }

  throw new Error(
    artifactAppeared
      ? "physical iOS probe artifact remained incomplete"
      : `physical iOS probe artifact never appeared on device: ${lastCopyError ?? "no copy attempt error"}`,
  );
}

async function copyProbeArtifactOnce(
  target: string,
  source: string,
  destination: string,
): Promise<{ error?: string; path?: string }> {
  try {
    await runDeviceJson(
      [
        "device",
        "copy",
        "from",
        "--device",
        target,
        "--domain-type",
        "appDataContainer",
        "--domain-identifier",
        appId,
        "--source",
        source,
        "--destination",
        destination,
      ],
      "copy",
    );
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (existsSync(destination) && statSync(destination).isFile()) {
    return { path: destination };
  }
  const nested = join(destination, basename(source));
  if (existsSync(nested) && statSync(nested).isFile()) {
    return { path: nested };
  }
  throw new Error("physical iOS probe copy command omitted its destination");
}

function assertReadyKeyProbe(
  probe: IosDeviceProbeRecord | undefined,
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

async function selectedPhysicalDeviceName(target: string): Promise<string> {
  let result: DeviceListResult;
  try {
    result = await runDeviceJson<DeviceListResult>(
      ["list", "devices"],
      "devices",
    );
  } catch {
    throw new Error("unable to resolve selected physical iOS device");
  }
  const matches = (result.result?.devices ?? []).filter(
    (device) => device.hardwareProperties?.udid === target,
  );
  assert.equal(
    matches.length,
    1,
    "selected physical iOS device was not unique",
  );
  const name = matches[0]?.deviceProperties?.name?.trim() ?? "";
  assert.notEqual(name, "", "selected physical iOS device omitted its name");
  return name;
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

async function assertProcessAbsentEventually(
  target: string,
  pid: string,
): Promise<void> {
  const deadline = Date.now() + PROCESS_ABSENCE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await processIsPresent(target, pid))) return;
    await sleep(PROCESS_POLL_INTERVAL_MS);
  }
  assert.fail("physical iOS app process remained after termination");
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

async function runDeviceJson<T>(
  args: string[],
  label: string,
  positional: string[] = [],
): Promise<T> {
  jsonSequence += 1;
  const outputPath = join(tempRoot, `${jsonSequence}-${label}.json`);
  await run(
    "xcrun",
    ["devicectl", ...args, "--json-output", outputPath, ...positional],
    60_000,
  );
  return JSON.parse(readFileSync(outputPath, "utf8")) as T;
}

async function run(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  const { stdout, stderr } = await runCommand(file, args, timeoutMs);
  return `${stdout}${stderr}`;
}

async function runStdout(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return (await runCommand(file, args, timeoutMs)).stdout;
}

async function runCommand(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stderr: string; stdout: string }> {
  try {
    const { stdout, stderr } = await execFile(file, args, {
      cwd: shellRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      env: file === "xcrun" ? deviceToolEnv : process.env,
    });
    return { stderr, stdout };
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    const detail =
      [failed.stderr, failed.stdout, failed.message]
        .map((part) => (part ?? "").trim())
        .find(Boolean) ?? "unknown iOS device-tool failure";
    throw new Error(redactCommandOutput(detail, deviceUdid ?? ""));
  }
}

function redactCommandOutput(value: string, deviceUdid: string): string {
  return redactIosDeviceCommandOutput(
    value,
    deviceUdid,
    process.env.HOME ?? "",
    physicalDeviceName,
  );
}

function cleanupPhysicalProbeResources(): void {
  rmSync(tempRoot, { recursive: true, force: true });
}

function terminateForSignal(signal: NodeJS.Signals): never {
  cleanupPhysicalProbeResources();
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
  throw new Error("physical iOS probe signal termination failed");
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, durationMs),
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
