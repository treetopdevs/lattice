import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDeveloperToolchainReferences } from "./ios_toolchain_evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..", "..");
const appleRoot = join(shellRoot, "src-tauri", "gen", "apple");
const appleBuildRoot = join(appleRoot, "build");
const sourceArchive = join(
  appleBuildRoot,
  "township-tauri-shell_iOS.xcarchive",
);
const deviceArchive = join(
  shellRoot,
  "src-tauri",
  "target",
  "township-ios-device-key-reuse.xcarchive",
);
const generatedSourcePaths = [
  join(appleRoot, "township-tauri-shell.xcodeproj", "project.pbxproj"),
  join(appleRoot, "township-tauri-shell_iOS", "Info.plist"),
  join(
    appleRoot,
    "township-tauri-shell_iOS",
    "township-tauri-shell_iOS.entitlements",
  ),
];
const developmentTeam = process.env.APPLE_DEVELOPMENT_TEAM?.trim() ?? "";
const deviceUdid = process.env.TOWNSHIP_IOS_DEVICE_UDID?.trim() ?? "";
const BUILD_TIMEOUT_MS = 30 * 60_000;
const BUILD_KILL_GRACE_MS = 5_000;
const BUILD_EXIT_CONFIRMATION_MS = 3_000;
const FAILED_LOG_RETENTION_MS = 7 * 24 * 60 * 60_000;
const FAILED_LOG_PREFIX = "township-ios-device-build-";
const APPLE_TOOLCHAIN_SHIM_PREFIX = "township-ios-apple-toolchain-";

try {
  await buildDeviceArchive();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(redactBuildOutput(message));
  if (process.exitCode === undefined) process.exitCode = 1;
}

async function buildDeviceArchive(): Promise<void> {
  rmSync(deviceArchive, { recursive: true, force: true });
  assert.match(
    developmentTeam,
    /^[A-Z0-9]{10}$/,
    "set APPLE_DEVELOPMENT_TEAM to the 10-character team ID used for this local device build",
  );
  assert.match(
    deviceUdid,
    /^[0-9A-F]{8}-[0-9A-F]{16}$/i,
    "set TOWNSHIP_IOS_DEVICE_UDID to the attached physical iPhone UDID",
  );

  const selectedDeveloperDir = runPreflight(
    "xcode-select",
    ["-p"],
    process.env,
  );
  const developerDir = resolve(
    process.env.TOWNSHIP_IOS_BUILD_DEVELOPER_DIR?.trim() ||
      selectedDeveloperDir,
  );
  assert.ok(
    existsSync(developerDir),
    "selected iOS build developer directory does not exist",
  );

  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
    APPLE_DEVELOPMENT_TEAM: developmentTeam,
    DEVELOPER_DIR: developerDir,
    ENTITLEMENTS_ALLOWED: "YES",
    PATH: `/opt/homebrew/opt/rustup/bin:${process.env.PATH ?? ""}`,
    VITE_TOWNSHIP_IOS_KEY_REUSE_PROBE: "1",
  };
  const xcodeVersion = runPreflight("xcodebuild", ["-version"], buildEnv);
  const iphoneOsSdkVersion = runPreflight(
    "xcrun",
    ["--sdk", "iphoneos", "--show-sdk-version"],
    buildEnv,
  );
  const sdkMajor = Number.parseInt(iphoneOsSdkVersion.split(".")[0] ?? "", 10);
  const xcodeBuildVersion =
    xcodeVersion.match(/^Build version\s+(\S+)$/m)?.[1] ?? "";

  assert.match(
    xcodeVersion,
    /^Xcode\s+\S+/m,
    "selected developer directory did not report an Xcode version",
  );
  assert.match(
    xcodeBuildVersion,
    /^\S+$/,
    "selected developer directory did not report an Xcode build version",
  );
  assert.ok(
    Number.isInteger(sdkMajor),
    "selected developer directory did not report an iPhoneOS SDK version",
  );
  assert.ok(
    sdkMajor < 27,
    "Tauri 2.11.5 cannot compile its Swift bridge with the iPhoneOS 27 beta SDK; set TOWNSHIP_IOS_BUILD_DEVELOPER_DIR to a compatible stable Xcode",
  );

  const cargoTargetDir = join(
    shellRoot,
    "src-tauri",
    "target",
    `ios-device-sdk-${iphoneOsSdkVersion.replace(/[^0-9A-Za-z.-]/g, "-")}`,
  );
  buildEnv.CARGO_TARGET_DIR = cargoTargetDir;

  const generatedSourceSnapshots = new Map(
    generatedSourcePaths.map((path) => [path, readFileSync(path)] as const),
  );
  reapExpiredBuildLogs();
  reapExpiredAppleToolchainShims();
  const logRoot = mkdtempSync(join(tmpdir(), FAILED_LOG_PREFIX));
  const logPath = join(logRoot, "archive.log");
  const toolchainTracePath = join(logRoot, "toolchain.trace");
  const logFd = openSync(logPath, "wx", 0o600);
  const hadGeneratedBuild = existsSync(appleBuildRoot);
  const generatedBuildBackupRoot = hadGeneratedBuild
    ? mkdtempSync(join(tmpdir(), "township-ios-generated-build-backup-"))
    : undefined;
  const generatedBuildBackup = generatedBuildBackupRoot
    ? join(generatedBuildBackupRoot, "build")
    : undefined;
  const cleanupErrors: string[] = [];
  let operationError: unknown;
  let appleToolchainShimRoot: string | undefined;
  let generatedBuildBackedUp = false;
  let generatedBuildRestored = false;
  let buildSucceeded = false;

  try {
    writeFileSync(toolchainTracePath, "", { encoding: "utf8", mode: 0o600 });
    appleToolchainShimRoot = createAppleToolchainShim(developerDir);
    buildEnv.TOWNSHIP_IOS_BUILD_DEVELOPER_DIR = developerDir;
    buildEnv.TOWNSHIP_IOS_TOOLCHAIN_TRACE = toolchainTracePath;
    buildEnv.SWIFT_RS_CLANG = join(
      developerDir,
      "Toolchains",
      "XcodeDefault.xctoolchain",
      "usr",
      "bin",
      "clang",
    );
    assert.ok(
      existsSync(buildEnv.SWIFT_RS_CLANG ?? ""),
      "selected Apple toolchain does not provide clang for swift-rs",
    );
    buildEnv.PATH = `${appleToolchainShimRoot}:/opt/homebrew/opt/rustup/bin:${process.env.PATH ?? ""}`;
    assert.equal(runPreflight("xcode-select", ["-p"], buildEnv), developerDir);
    assert.equal(
      runPreflight(
        "xcrun",
        ["--sdk", "iphoneos", "--show-sdk-version"],
        buildEnv,
      ),
      iphoneOsSdkVersion,
    );
    assert.equal(
      runPreflight("xcodebuild", ["-version"], buildEnv),
      xcodeVersion,
    );
    const swiftVersion = runPreflight(
      join(
        developerDir,
        "Toolchains",
        "XcodeDefault.xctoolchain",
        "usr",
        "bin",
        "swift",
      ),
      ["--version"],
      buildEnv,
    );
    assert.equal(runPreflight("swift", ["--version"], buildEnv), swiftVersion);
    assert.ok(
      runPreflight("xcrun", ["--find", "swift"], buildEnv).startsWith(
        `${developerDir}/`,
      ),
      "private Apple toolchain shim did not select the requested Swift compiler",
    );
    assert.ok(
      runPreflight("xcrun", ["--find", "swiftc"], buildEnv).startsWith(
        `${developerDir}/`,
      ),
      "private Apple toolchain shim did not select the requested Swift compiler driver",
    );
    if (selectedDeveloperDir !== developerDir) {
      const poisonedBuildEnv = {
        ...buildEnv,
        DEVELOPER_DIR: selectedDeveloperDir,
      };
      assert.equal(
        runPreflight("xcode-select", ["-p"], poisonedBuildEnv),
        developerDir,
      );
      assert.equal(
        runPreflight(
          "xcrun",
          ["--sdk", "iphoneos", "--show-sdk-version"],
          poisonedBuildEnv,
        ),
        iphoneOsSdkVersion,
      );
      assert.equal(
        runPreflight("xcodebuild", ["-version"], poisonedBuildEnv),
        xcodeVersion,
      );
      assert.equal(
        runPreflight("swift", ["--version"], poisonedBuildEnv),
        swiftVersion,
      );
      assert.equal(
        runPreflight("swiftc", ["--version"], poisonedBuildEnv),
        swiftVersion,
      );
    }
    writeFileSync(toolchainTracePath, "", { encoding: "utf8", mode: 0o600 });
    if (hadGeneratedBuild && generatedBuildBackup) {
      cpSync(appleBuildRoot, generatedBuildBackup, { recursive: true });
      generatedBuildBackedUp = true;
    }
    rmSync(appleBuildRoot, { recursive: true, force: true });
    rmSync(cargoTargetDir, { recursive: true, force: true });
    const buildStartedAt = Date.now();
    const exitStatus = await runArchiveBuild(logFd, buildEnv);
    const toolchainMarkers = readToolchainMarkers(toolchainTracePath);

    if (exitStatus !== 0) {
      const buildOutput = readFileSync(logPath, "utf8");
      const classification = classifyBuildFailure(buildOutput);
      const tail = redactedBuildTail(buildOutput);
      throw new Error(
        [
          `Tauri iOS device archive failed (${classification}).`,
          `Private full build log (mode 0600): ${logPath}`,
          `Deep toolchain markers: ${toolchainMarkerSummary(toolchainMarkers)}`,
          tail
            ? `Redacted diagnostic tail:\n${tail}`
            : "Redacted diagnostic tail was empty.",
        ].join("\n"),
      );
    }

    assertToolchainMarkers(toolchainMarkers);
    assertFreshSwiftToolchainReferences(
      cargoTargetDir,
      developerDir,
      buildStartedAt,
    );
    assert.ok(
      existsSync(sourceArchive),
      "Tauri iOS device build did not produce its archive",
    );
    const archiveToolchain = readArchiveToolchainMetadata(buildEnv);
    assert.equal(archiveToolchain.sdkName, `iphoneos${iphoneOsSdkVersion}`);
    assert.equal(archiveToolchain.xcodeBuild, xcodeBuildVersion);
    mkdirSync(dirname(deviceArchive), { recursive: true });
    cpSync(sourceArchive, deviceArchive, { recursive: true });
    buildSucceeded = true;
  } catch (error) {
    operationError = error;
  } finally {
    try {
      closeSync(logFd);
    } catch {
      cleanupErrors.push("failed to close the private iOS archive log");
    }
    if (generatedBuildBackedUp || !hadGeneratedBuild) {
      try {
        rmSync(appleBuildRoot, { recursive: true, force: true });
      } catch {
        cleanupErrors.push(
          "failed to remove the generated iOS build root before restoration",
        );
      }
    }
    if (generatedBuildBackedUp && generatedBuildBackup) {
      try {
        mkdirSync(dirname(appleBuildRoot), { recursive: true });
        cpSync(generatedBuildBackup, appleBuildRoot, { recursive: true });
        generatedBuildRestored = true;
      } catch {
        cleanupErrors.push(
          `failed to restore the prior generated iOS build root; preserved backup: ${generatedBuildBackup}`,
        );
      }
    }
    if (
      generatedBuildBackupRoot &&
      (!generatedBuildBackedUp || generatedBuildRestored)
    ) {
      try {
        rmSync(generatedBuildBackupRoot, { recursive: true, force: true });
      } catch {
        cleanupErrors.push(
          "failed to remove the restored generated iOS build backup",
        );
      }
    }
    if (appleToolchainShimRoot) {
      try {
        rmSync(appleToolchainShimRoot, { recursive: true, force: true });
      } catch {
        cleanupErrors.push("failed to remove the private Apple toolchain shim");
      }
    }
    for (const [path, contents] of generatedSourceSnapshots) {
      try {
        writeFileSync(path, contents);
      } catch {
        cleanupErrors.push(
          `failed to restore generated Apple source ${path.split("/").at(-1) ?? "file"}`,
        );
      }
    }
    if (!buildSucceeded) {
      try {
        rmSync(deviceArchive, { recursive: true, force: true });
      } catch {
        cleanupErrors.push("failed to remove an incomplete iOS device archive");
      }
    }
    if (buildSucceeded) {
      try {
        rmSync(logRoot, { recursive: true, force: true });
      } catch {
        cleanupErrors.push("failed to remove the successful iOS build log");
      }
    }
  }

  const failureMessages = [
    operationError === undefined ? undefined : errorMessage(operationError),
    ...cleanupErrors,
  ].filter((message): message is string => Boolean(message));
  if (failureMessages.length > 0) throw new Error(failureMessages.join("\n"));
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
      `unable to run iOS build preflight: ${file} ${args.join(" ")}`,
    );
  }
}

function createAppleToolchainShim(developerDir: string): string {
  const root = mkdtempSync(join(tmpdir(), APPLE_TOOLCHAIN_SHIM_PREFIX));
  const developerDirLine = `developer_dir=${shellSingleQuote(developerDir)}`;
  try {
    writeExecutableShim(join(root, "xcode-select"), [
      "#!/bin/sh",
      developerDirLine,
      'if [ -n "${TOWNSHIP_IOS_TOOLCHAIN_TRACE:-}" ]; then',
      "  printf '%s\\n' 'xcode-select' >> \"$TOWNSHIP_IOS_TOOLCHAIN_TRACE\"",
      "fi",
      'if [ "$#" -eq 1 ] && { [ "$1" = "-p" ] || [ "$1" = "--print-path" ]; }; then',
      "  printf '%s\\n' \"$developer_dir\"",
      "  exit 0",
      "fi",
      'exec /usr/bin/xcode-select "$@"',
      "",
    ]);
    writeExecutableShim(join(root, "xcrun"), [
      "#!/bin/sh",
      developerDirLine,
      'if [ -n "${TOWNSHIP_IOS_TOOLCHAIN_TRACE:-}" ]; then',
      "  printf '%s\\n' 'xcrun' >> \"$TOWNSHIP_IOS_TOOLCHAIN_TRACE\"",
      "fi",
      'exec /usr/bin/env DEVELOPER_DIR="$developer_dir" /usr/bin/xcrun "$@"',
      "",
    ]);
    writeExecutableShim(join(root, "swift"), [
      "#!/bin/sh",
      developerDirLine,
      'if [ -n "${TOWNSHIP_IOS_TOOLCHAIN_TRACE:-}" ]; then',
      "  printf '%s\\n' 'swift' >> \"$TOWNSHIP_IOS_TOOLCHAIN_TRACE\"",
      "fi",
      'exec /usr/bin/env DEVELOPER_DIR="$developer_dir" "$developer_dir/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift" "$@"',
      "",
    ]);
    writeExecutableShim(join(root, "swiftc"), [
      "#!/bin/sh",
      developerDirLine,
      'if [ -n "${TOWNSHIP_IOS_TOOLCHAIN_TRACE:-}" ]; then',
      "  printf '%s\\n' 'swiftc' >> \"$TOWNSHIP_IOS_TOOLCHAIN_TRACE\"",
      "fi",
      'exec /usr/bin/env DEVELOPER_DIR="$developer_dir" "$developer_dir/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc" "$@"',
      "",
    ]);
    writeExecutableShim(join(root, "xcodebuild"), [
      "#!/bin/sh",
      developerDirLine,
      'if [ -n "${TOWNSHIP_IOS_TOOLCHAIN_TRACE:-}" ]; then',
      "  printf '%s\\n' 'xcodebuild' >> \"$TOWNSHIP_IOS_TOOLCHAIN_TRACE\"",
      "fi",
      'exec /usr/bin/env DEVELOPER_DIR="$developer_dir" "$developer_dir/usr/bin/xcodebuild" "$@"',
      "",
    ]);
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function writeExecutableShim(path: string, lines: string[]): void {
  writeFileSync(path, lines.join("\n"), { encoding: "utf8", mode: 0o700 });
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function readToolchainMarkers(path: string): Set<string> {
  return new Set(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((marker) =>
        ["swift", "swiftc", "xcode-select", "xcodebuild", "xcrun"].includes(
          marker,
        ),
      ),
  );
}

function assertToolchainMarkers(markers: Set<string>): void {
  assert.ok(
    markers.has("xcrun"),
    "deep iOS build did not use the private xcrun selector",
  );
}

function assertFreshSwiftToolchainReferences(
  cargoTargetDir: string,
  developerDir: string,
  buildStartedAt: number,
): void {
  const buildRoot = join(cargoTargetDir, "aarch64-apple-ios", "debug", "build");
  assert.ok(
    existsSync(buildRoot),
    "iOS Cargo build did not produce build-script outputs",
  );

  const swiftRsRoots: string[] = [];
  const pendingDirectories = [buildRoot];
  while (pendingDirectories.length > 0) {
    const current = pendingDirectories.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(current, entry.name);
      if (entry.name === "swift-rs") {
        swiftRsRoots.push(path);
      } else {
        pendingDirectories.push(path);
      }
    }
  }
  assert.ok(
    swiftRsRoots.length > 0,
    "iOS Cargo build did not produce swift-rs outputs",
  );

  let approvedReferenceCount = 0;
  let evidenceFileCount = 0;
  let foreignReferenceCount = 0;

  for (const swiftRsRoot of swiftRsRoots) {
    const pending = [swiftRsRoot];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) continue;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(path);
          continue;
        }
        if (!entry.isFile()) continue;

        const references = classifyDeveloperToolchainReferences(
          readFileSync(path),
          developerDir,
        );
        if (
          references.approvedReferenceCount === 0 &&
          references.foreignReferenceCount === 0
        ) {
          continue;
        }

        evidenceFileCount += 1;
        assert.ok(
          statSync(path).mtimeMs >= buildStartedAt - 1_000,
          "swift-rs toolchain evidence was not generated by the current cold build",
        );
        approvedReferenceCount += references.approvedReferenceCount;
        foreignReferenceCount += references.foreignReferenceCount;
      }
    }
  }

  assert.ok(
    evidenceFileCount > 0,
    "fresh swift-rs outputs contained no Xcode toolchain evidence",
  );
  assert.ok(
    approvedReferenceCount > 0,
    "fresh swift-rs outputs did not reference the approved Xcode toolchain",
  );
  assert.equal(
    foreignReferenceCount,
    0,
    "fresh swift-rs outputs referenced an unapproved Xcode toolchain",
  );
}

function readArchiveToolchainMetadata(env: NodeJS.ProcessEnv): {
  sdkName: string;
  xcodeBuild: string;
} {
  const infoPlist = join(
    sourceArchive,
    "Products",
    "Applications",
    "Township.app",
    "Info.plist",
  );
  assert.ok(
    existsSync(infoPlist),
    "Tauri iOS device archive lacks its app metadata",
  );
  return {
    sdkName: runPreflight(
      "/usr/bin/plutil",
      ["-extract", "DTSDKName", "raw", "-o", "-", infoPlist],
      env,
    ),
    xcodeBuild: runPreflight(
      "/usr/bin/plutil",
      ["-extract", "DTXcodeBuild", "raw", "-o", "-", infoPlist],
      env,
    ),
  };
}

function toolchainMarkerSummary(markers: Set<string>): string {
  return ["xcodebuild", "xcrun", "swift"]
    .map((marker) => `${marker}=${markers.has(marker) ? "yes" : "no"}`)
    .join(" ");
}

function runArchiveBuild(
  logFd: number,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(
      "tauri",
      [
        "ios",
        "build",
        "--debug",
        "--target",
        "aarch64",
        "--ci",
        "--archive-only",
      ],
      {
        cwd: shellRoot,
        detached: true,
        env,
        stdio: ["ignore", logFd, logFd],
      },
    );
    let settled = false;
    let forcedFailure: string | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let buildTimeout: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let terminationConfirmationTimer: NodeJS.Timeout | undefined;

    const clearLifecycle = () => {
      if (heartbeat) clearInterval(heartbeat);
      if (buildTimeout) clearTimeout(buildTimeout);
      if (killTimer) clearTimeout(killTimer);
      if (terminationConfirmationTimer)
        clearTimeout(terminationConfirmationTimer);
      process.removeListener("SIGINT", onSigInt);
      process.removeListener("SIGTERM", onSigTerm);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      clearLifecycle();
      rejectBuild(error);
    };
    const resolveOnce = (status: number) => {
      if (settled) return;
      settled = true;
      clearLifecycle();
      resolveBuild(status);
    };
    const keepForcingBuildExit = () => {
      killBuildProcessGroup(child.pid, "SIGKILL");
      signalBuildChild(child, "SIGKILL");
      terminationConfirmationTimer = setTimeout(
        keepForcingBuildExit,
        BUILD_EXIT_CONFIRMATION_MS,
      );
    };
    const stopBuild = (signal: "SIGINT" | "SIGTERM", message: string) => {
      if (forcedFailure) return;
      forcedFailure = message;
      killBuildProcessGroup(child.pid, signal);
      signalBuildChild(child, signal);
      killTimer = setTimeout(() => {
        keepForcingBuildExit();
      }, BUILD_KILL_GRACE_MS);
    };
    const onSigInt = () => {
      process.exitCode = 130;
      stopBuild(
        "SIGINT",
        "Tauri iOS device archive build interrupted by SIGINT",
      );
    };
    const onSigTerm = () => {
      process.exitCode = 143;
      stopBuild(
        "SIGTERM",
        "Tauri iOS device archive build interrupted by SIGTERM",
      );
    };

    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);
    heartbeat = setInterval(() => {
      console.log("Township iOS device archive is still building...");
    }, 30_000);
    buildTimeout = setTimeout(() => {
      stopBuild(
        "SIGTERM",
        `Tauri iOS device archive build exceeded ${BUILD_TIMEOUT_MS}ms`,
      );
    }, BUILD_TIMEOUT_MS);

    child.once("error", (error) => {
      rejectOnce(
        new Error(
          `unable to start Tauri iOS device archive build: ${error.message}`,
        ),
      );
    });
    child.once("exit", (status, signal) => {
      if (forcedFailure) {
        rejectOnce(new Error(forcedFailure));
        return;
      }
      if (status === null) {
        rejectOnce(
          new Error(
            `Tauri iOS device archive build ended from signal ${signal ?? "unknown"}`,
          ),
        );
        return;
      }
      resolveOnce(status);
    });
  });
}

function killBuildProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function signalBuildChild(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): boolean {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reapExpiredBuildLogs(): void {
  const oldestRetainedAt = Date.now() - FAILED_LOG_RETENTION_MS;
  for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(FAILED_LOG_PREFIX))
      continue;
    const path = join(tmpdir(), entry.name);
    try {
      if (statSync(path).mtimeMs < oldestRetainedAt) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // A concurrent cleanup or OS temp reaper may already have removed it.
    }
  }
}

function reapExpiredAppleToolchainShims(): void {
  const oldestRetainedAt = Date.now() - FAILED_LOG_RETENTION_MS;
  for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !entry.name.startsWith(APPLE_TOOLCHAIN_SHIM_PREFIX)
    )
      continue;
    const path = join(tmpdir(), entry.name);
    try {
      if (statSync(path).mtimeMs < oldestRetainedAt) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // A concurrent cleanup or OS temp reaper may already have removed it.
    }
  }
}

function classifyBuildFailure(output: string): string {
  if (
    /using sysroot for macOS|MacOSX[^\r\n]+\.sdk[^\r\n]*apple-ios|missing required module ['"](?:UIKit|AppKit)/i.test(
      output,
    )
  ) {
    return "swift-sdk-target-mismatch";
  }
  if (
    /provisioning profile|requires a development team|code ?sign|certificate/i.test(
      output,
    )
  ) {
    return "apple-signing-or-provisioning";
  }
  if (/no space left on device/i.test(output)) return "local-disk-capacity";
  return "tauri-ios-archive-build";
}

function redactedBuildTail(output: string): string {
  return redactBuildOutput(output)
    .split(/\r?\n/)
    .filter((line) => !/destination/i.test(line))
    .slice(-24)
    .join("\n");
}

function redactBuildOutput(output: string): string {
  let redacted = output;
  if (deviceUdid)
    redacted = redacted.replaceAll(deviceUdid, "<physical-device>");
  if (developmentTeam)
    redacted = redacted.replaceAll(developmentTeam, "<apple-team>");
  if (process.env.HOME) redacted = redacted.replaceAll(process.env.HOME, "~");
  return redacted
    .replace(/Apple Development:[^\r\n"]+/g, "Apple Development: <redacted>")
    .replace(
      /\b(signing (?:certificate|identity))\s*[:=][^\r\n]+/gi,
      "$1: <redacted>",
    )
    .replace(
      /\b(provisioning profile(?: name)?)\s*[:=][^\r\n]+/gi,
      "$1: <redacted>",
    )
    .replace(/\b[0-9A-F]{8}-[0-9A-F]{16}\b/gi, "<physical-device>")
    .replace(/\b[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\b/gi, "<uuid>")
    .replace(/\b[0-9A-F]{40}\b/gi, "<certificate>")
    .replace(/\b[A-Z0-9]{10}\b/g, "<apple-team>");
}
