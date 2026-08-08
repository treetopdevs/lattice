import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..", "..");
const nativeRoot = join(shellRoot, "src-tauri");
const manifestPath = join(nativeRoot, "Cargo.toml");
const targetDir = join(
  nativeRoot,
  "target",
  "ios-native-probe-feature-contract",
);
const binaryPath = join(
  targetDir,
  "aarch64-apple-ios",
  "debug",
  "libtownship_tauri_shell.a",
);
const marker = "township-ios-key-reuse-probe-";
const feature = "township-ios-key-reuse-native-probe";
const cargo = process.env.CARGO?.trim() || "cargo";
const selectedDeveloperDir = execFileSync("/usr/bin/xcode-select", ["-p"], {
  encoding: "utf8",
}).trim();
const developerDir = resolve(
  process.env.TOWNSHIP_IOS_BUILD_DEVELOPER_DIR?.trim() || selectedDeveloperDir,
);
const swiftRsClang = join(
  developerDir,
  "Toolchains",
  "XcodeDefault.xctoolchain",
  "usr",
  "bin",
  "clang",
);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  CARGO_TARGET_DIR: targetDir,
  DEVELOPER_DIR: developerDir,
  PATH: `/opt/homebrew/opt/rustup/bin:${process.env.PATH ?? ""}`,
  SWIFT_RS_CLANG: swiftRsClang,
};

assert.ok(
  existsSync(developerDir),
  "selected Xcode developer directory is missing",
);
assert.ok(
  existsSync(swiftRsClang),
  "selected Xcode Swift bridge compiler is missing",
);
const sdkVersion = execFileSync(
  "/usr/bin/xcrun",
  ["--sdk", "iphoneos", "--show-sdk-version"],
  { encoding: "utf8", env },
).trim();
const sdkMajor = Number.parseInt(sdkVersion.split(".")[0] ?? "", 10);
assert.ok(
  Number.isInteger(sdkMajor) && sdkMajor < 27,
  "the iOS native probe feature contract requires a pre-Xcode-27 SDK",
);

function build(extraArgs: string[]): void {
  execFileSync(
    cargo,
    [
      "build",
      "--manifest-path",
      manifestPath,
      "--target",
      "aarch64-apple-ios",
      "--lib",
      ...extraArgs,
    ],
    { cwd: nativeRoot, env, stdio: "inherit" },
  );
}

build([]);
assert.equal(
  readFileSync(binaryPath).includes(marker),
  false,
  "ordinary iOS binary unexpectedly contains the native probe marker",
);

build(["--features", feature]);
assert.equal(
  readFileSync(binaryPath).includes(marker),
  true,
  "feature-enabled iOS binary omitted the native probe marker",
);

console.log("Township iOS native probe feature contract passed");
