import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..", "..");
const appleRoot = join(shellRoot, "src-tauri", "gen", "apple");
const generatedSourcePaths = [
  join(appleRoot, "township-tauri-shell.xcodeproj", "project.pbxproj"),
  join(appleRoot, "township-tauri-shell_iOS", "Info.plist"),
  join(appleRoot, "township-tauri-shell_iOS", "township-tauri-shell_iOS.entitlements"),
];
const generatedSourceSnapshots = new Map(
  generatedSourcePaths.map((path) => [path, readFileSync(path)] as const),
);
const developmentTeam = process.env.APPLE_DEVELOPMENT_TEAM?.trim();

assert.match(
  developmentTeam ?? "",
  /^[A-Z0-9]{10}$/,
  "set APPLE_DEVELOPMENT_TEAM to the 10-character Apple team ID used for this local simulator build",
);

let exitStatus = 1;
try {
  const result = spawnSync(
    "tauri",
    ["ios", "build", "--debug", "--target", "aarch64-sim", "--ci", "--archive-only"],
    {
      cwd: shellRoot,
      env: {
        ...process.env,
        APPLE_DEVELOPMENT_TEAM: developmentTeam,
        ENTITLEMENTS_ALLOWED: "YES",
        PATH: `/opt/homebrew/opt/rustup/bin:${process.env.PATH ?? ""}`,
        VITE_TOWNSHIP_IOS_KEY_REUSE_PROBE: "1",
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  exitStatus = result.status ?? 1;
} finally {
  for (const [path, contents] of generatedSourceSnapshots) {
    writeFileSync(path, contents);
  }
}

process.exitCode = exitStatus;
