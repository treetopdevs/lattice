import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const shellRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repoRoot = resolve(shellRoot, "..", "..");

function readText(path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function assertDir(path, message) {
  assert.ok(existsSync(join(repoRoot, path)), message);
}

test("Tauri mobile targets are scaffolded without claiming phone-grade convergence", () => {
  const pkg = readJson("clients/township-tauri-shell/package.json");
  const config = readJson("clients/township-tauri-shell/src-tauri/tauri.conf.json");
  const cargoToml = readText("clients/township-tauri-shell/src-tauri/Cargo.toml");
  const nativeLib = readText("clients/township-tauri-shell/src-tauri/src/lib.rs");
  const androidSmoke = readText("clients/township-tauri-shell/test/tauri_android_emulator_smoke.ts");
  const androidBeamSmoke = readText("clients/township-tauri-shell/test/tauri_android_beam_smoke.ts");
  const androidCdpSupport = readText("clients/township-tauri-shell/test/support/android_cdp.ts");
  const beamPeerSupport = readText("clients/township-tauri-shell/test/support/beam_peer.ts");
  const strategy = readText("docs/township_mobile_secure_store_strategy.md");
  const buildMap = readText("TOWNSHIP_BUILD_MAP.md");

  assert.equal(pkg.scripts["tauri:ios:init"], "tauri ios init --ci --skip-targets-install");
  assert.equal(pkg.scripts["tauri:android:init"], "tauri android init --ci --skip-targets-install");
  assert.equal(
    pkg.scripts["tauri:android:build:debug"],
    "PATH=/opt/homebrew/opt/rustup/bin:$PATH tauri android build --debug --apk --ci",
  );
  assert.equal(pkg.scripts["tauri:android:emulator:smoke"], "tsx test/tauri_android_emulator_smoke.ts");
  assert.equal(pkg.scripts["tauri:android:beam:smoke"], "tsx test/tauri_android_beam_smoke.ts");
  assert.equal(pkg.scripts.tauri, "tauri");
  assert.equal(pkg.scripts["mobile:tauri-readiness"], "node --test test/tauri_mobile_readiness.mjs");

  assert.equal(config.plugins["deep-link"].mobile[0].scheme[0], "township");
  assert.equal(config.plugins["deep-link"].mobile[0].appLink, false);
  assertDir("clients/township-tauri-shell/src-tauri/gen/apple", "Tauri iOS target should be initialized");
  assertDir("clients/township-tauri-shell/src-tauri/gen/android", "Tauri Android target should be initialized");
  assertDir(
    "clients/township-tauri-shell/src-tauri/gen/apple/township-tauri-shell.xcodeproj",
    "Tauri iOS Xcode project should be generated",
  );
  assertDir(
    "clients/township-tauri-shell/src-tauri/gen/android/gradle/wrapper",
    "Tauri Android Gradle wrapper should be generated",
  );

  const iosProject = readText("clients/township-tauri-shell/src-tauri/gen/apple/project.yml");
  const iosPbxproj = readText(
    "clients/township-tauri-shell/src-tauri/gen/apple/township-tauri-shell.xcodeproj/project.pbxproj",
  );
  const androidGradle = readText("clients/township-tauri-shell/src-tauri/gen/android/app/build.gradle.kts");
  const androidManifest = readText("clients/township-tauri-shell/src-tauri/gen/android/app/src/main/AndroidManifest.xml");
  const androidMainActivity = readText(
    "clients/township-tauri-shell/src-tauri/gen/android/app/src/main/java/dev/treetop/lattice/township/MainActivity.kt",
  );
  const androidKeyringShim = readText(
    "clients/township-tauri-shell/src-tauri/gen/android/app/src/main/java/io/crates/keyring/Keyring.kt",
  );
  assert.match(iosProject, /PRODUCT_BUNDLE_IDENTIFIER: dev\.treetop\.lattice\.township/);
  assert.match(iosProject, /iOS: 15\.0/);
  assert.match(iosProject, /platform: iOS/);
  assert.match(iosProject, /Build Rust Code/);
  assert.match(iosPbxproj, /IPHONEOS_DEPLOYMENT_TARGET = 15\.0;/);
  assert.doesNotMatch(iosPbxproj, /IPHONEOS_DEPLOYMENT_TARGET = 14\.0;/);
  assert.match(androidGradle, /namespace = "dev\.treetop\.lattice\.township"/);
  assert.match(androidGradle, /applicationId = "dev\.treetop\.lattice\.township"/);
  assert.match(androidGradle, /rootDirRel = "\.\.\/\.\.\/\.\.\/"/);
  assert.match(androidManifest, /android:name="\.MainActivity"/);
  assert.match(androidManifest, /android:allowBackup="false"/);
  assert.match(androidMainActivity, /import io\.crates\.keyring\.Keyring/);
  assert.match(androidMainActivity, /System\.loadLibrary\("township_tauri_shell"\)/);
  assert.match(androidMainActivity, /Keyring\.initializeNdkContext\(applicationContext\)/);
  assert.match(androidKeyringShim, /package io\.crates\.keyring/);
  assert.match(androidKeyringShim, /companion object\s*\{\s*external fun initializeNdkContext\(context: Context\)/);
  assert.match(cargoToml, /\[lib\]\nname = "township_tauri_shell"\npath = "src\/lib\.rs"\ncrate-type = \["staticlib", "cdylib", "rlib"\]/);
  assert.match(nativeLib, /#\[cfg_attr\(mobile, tauri::mobile_entry_point\)\]\npub fn run\(\)/);
  assert.match(cargoToml, /\[target\.'cfg\(target_os = "ios"\)'\.dependencies\]\nkeyring-core = "1\.0\.0"/);
  assert.match(
    cargoToml,
    /\[target\.'cfg\(target_os = "ios"\)'\.dependencies\.apple-native-keyring-store\]\nversion = "1\.0\.0"\nfeatures = \["protected"\]/,
  );
  assert.match(
    cargoToml,
    /\[target\.'cfg\(target_os = "android"\)'\.dependencies\]\nandroid-native-keyring-store = "1\.0\.0"\nkeyring-core = "1\.0\.0"/,
  );
  assert.match(nativeLib, /fn configure_mobile_keyring_store\(\) -> Result<\(\), String>/);
  assert.match(nativeLib, /android_native_keyring_store::Store::new_with_configuration/);
  assert.match(nativeLib, /apple_native_keyring_store::protected::Store::new/);
  assert.match(nativeLib, /keyring_core::set_default_store/);
  assert.match(nativeLib, /\("name", TOWNSHIP_KEYRING_SERVICE\)/);
  assert.match(nativeLib, /static MOBILE_KEYRING_STORE_CONFIGURED: OnceLock<\(\)> = OnceLock::new\(\);/);
  assert.match(
    nativeLib,
    /configure_mobile_keyring_store\(\)\?;\n\s+keyring::Entry::new\(&self\.service, key_id\)/,
  );
  assert.doesNotMatch(nativeLib, /configure_mobile_keyring_store\(\)\.expect/);
  assert.match(androidSmoke, /webview_devtools_remote/);
  assert.match(androidSmoke, /lattice_ensure_carrier_key/);
  assert.match(androidSmoke, /lattice_sign_carrier/);
  assert.match(androidSmoke, /\["shell", "am", "force-stop", appId\]/);
  assert.match(androidSmoke, /publicKeyAfterRestart/);
  assert.match(androidSmoke, /publicKeyAfterClear/);
  assert.match(androidCdpSupport, /connectToAppWebView/);
  assert.match(androidCdpSupport, /tauriInvoke/);
  assert.match(androidCdpSupport, /clickButtonByText/);
  assert.match(beamPeerSupport, /spawnTownshipPeer/);
  assert.match(beamPeerSupport, /trustedPeerPubkey/);
  assert.match(beamPeerSupport, /\.asdf\/shims\/elixir/);
  assert.match(androidBeamSmoke, /tauri:android:beam:smoke/);
  assert.match(androidBeamSmoke, /10\.0\.2\.2/);
  assert.match(androidBeamSmoke, /lattice_ensure_carrier_key/);
  assert.match(androidBeamSmoke, /spawnTownshipPeer\([^)]*trustedPeerPubkey: devicePublicKeyBase64/s);
  assert.match(androidBeamSmoke, /carrier_peer_config/);
  assert.match(androidBeamSmoke, /Sync outbox/);
  assert.match(androidBeamSmoke, /expectAfterSync\.opIds/);
  assert.match(androidBeamSmoke, /stateReport/);
  assert.match(androidBeamSmoke, /pre-signed carrier frames/);
  assert.match(androidBeamSmoke, /debug APK/);
  assert.doesNotMatch(androidBeamSmoke, /VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT/);

  assert.match(strategy, /Plan 076 adds generated Tauri iOS and Android target scaffolds/);
  assert.match(strategy, /plan 077 pins the repo-side iOS simulator readiness contracts/);
  assert.match(strategy, /plan 078 proves\s+the generated Android target can assemble a debug APK/);
  assert.match(strategy, /Plan 079\s+proves an Android emulator native-key smoke/);
  assert.match(strategy, /not a phone-grade persistence or BEAM\s+convergence proof/);
  assert.match(strategy, /The generated Tauri iOS and Android projects are build targets only/);
  assert.match(strategy, /Android emulator now proves native carrier key reuse/);
  assert.match(strategy, /No phone-grade persistence claim is allowed/);
  assert.match(buildMap, /Plan 077 pins iOS simulator-readiness config/);
  assert.match(buildMap, /Plan 078 pins the Android debug APK build command/);
  assert.match(buildMap, /Plan 079 adds the Android emulator native-key\s+smoke/);
  assert.match(buildMap, /Plan 080 adds the Android debug-APK BEAM convergence smoke/);
  assert.match(buildMap, /Android emulator native carrier key reuse/);
  assert.match(buildMap, /Android debug APK pre-signed-frame BEAM convergence/);
  assert.match(buildMap, /Xcode 27 beta Tauri Swift-package/);
  assert.match(buildMap, /release mobile BEAM convergence remains unproven/);
  assert.doesNotMatch(buildMap, /Android still needs an\s+emulator\/device restart-and-sync smoke/);
  assert.doesNotMatch(buildMap, /phone-grade mobile BEAM convergence smoke (?:is|are|has been) proven/i);
});
