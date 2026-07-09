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

function extractBlock(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `${marker} should exist`);

  const openIndex = source.indexOf("{", markerIndex);
  assert.notEqual(openIndex, -1, `${marker} should open a block`);

  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openIndex, index + 1);
      }
    }
  }

  assert.fail(`${marker} should close its block`);
}

test("Tauri mobile targets are scaffolded without claiming phone-grade convergence", () => {
  const pkg = readJson("clients/township-tauri-shell/package.json");
  const shellTsconfig = readJson("clients/township-tauri-shell/tsconfig.json");
  const config = readJson("clients/township-tauri-shell/src-tauri/tauri.conf.json");
  const cargoToml = readText("clients/township-tauri-shell/src-tauri/Cargo.toml");
  const appVue = readText("clients/township-tauri-shell/src/App.vue");
  const nativeWorkflow = readText("clients/township-tauri-shell/src/native_workflow.ts");
  const canonicalProbeSource = readText("clients/township-tauri-shell/src/township_canonical_probe.ts");
  const releaseTransportProbeSource = readText("clients/township-tauri-shell/src/township_release_transport_probe.ts");
  const releaseBeamProbeSource = readText("clients/township-tauri-shell/src/township_release_beam_probe.ts");
  const releaseSyncProbeSource = readText("clients/township-tauri-shell/src/township_release_sync_probe.ts");
  const releaseAuthorProbeSource = readText("clients/township-tauri-shell/src/township_release_author_probe.ts");
  const releasePairingProbeSource = readText("clients/township-tauri-shell/src/township_release_pairing_probe.ts");
  const nativeLib = readText("clients/township-tauri-shell/src-tauri/src/lib.rs");
  const canonicalProbeContract = readText("clients/township-tauri-shell/test/township_canonical_probe.ts");
  const releaseTransportProbeContract = readText("clients/township-tauri-shell/test/township_release_transport_probe.ts");
  const releaseBeamProbeContract = readText("clients/township-tauri-shell/test/township_release_beam_probe.ts");
  const releaseSyncProbeContract = readText("clients/township-tauri-shell/test/township_release_sync_probe.ts");
  const releaseAuthorProbeContract = readText("clients/township-tauri-shell/test/township_release_author_probe.ts");
  const releasePairingProbeContract = readText("clients/township-tauri-shell/test/township_release_pairing_probe.ts");
  const androidSmoke = readText("clients/township-tauri-shell/test/tauri_android_emulator_smoke.ts");
  const androidBeamSmoke = readText("clients/township-tauri-shell/test/tauri_android_beam_smoke.ts");
  const androidAuthoringSmoke = readText("clients/township-tauri-shell/test/tauri_android_authoring_smoke.ts");
  const androidOnboardingSmoke = readText("clients/township-tauri-shell/test/tauri_android_onboarding_smoke.ts");
  const androidReleaseSmoke = readText("clients/township-tauri-shell/test/tauri_android_release_smoke.ts");
  const androidReleaseCanonicalSmoke = readText("clients/township-tauri-shell/test/tauri_android_release_canonical_probe.ts");
  const androidReleaseTransportSmoke = readText("clients/township-tauri-shell/test/tauri_android_release_transport_probe.ts");
  const androidReleaseBeamSmoke = readText("clients/township-tauri-shell/test/tauri_android_release_beam_probe.ts");
  const androidReleaseSyncSmoke = readText("clients/township-tauri-shell/test/tauri_android_release_sync_probe.ts");
  const androidReleaseAuthorSmoke = readText("clients/township-tauri-shell/test/tauri_android_release_author_probe.ts");
  const androidReleasePairingSmoke = readText("clients/township-tauri-shell/test/tauri_android_release_pairing_probe.ts");
  const androidReleaseCleartextDiagnosticSmoke = readText(
    "clients/township-tauri-shell/test/tauri_android_release_cleartext_diagnostic_probe.ts",
  );
  const androidDebugTransportSmoke = readText("clients/township-tauri-shell/test/tauri_android_debug_transport_probe.ts");
  const androidReleaseNetworkSecurityConfig = readText(
    "clients/township-tauri-shell/src-tauri/gen/android/app/src/main/res/xml/township_release_network_security_config.xml",
  );
  const androidDebugNetworkSecurityConfig = readText(
    "clients/township-tauri-shell/src-tauri/gen/android/app/src/main/res/xml/township_debug_network_security_config.xml",
  );
  const androidCdpSupport = readText("clients/township-tauri-shell/test/support/android_cdp.ts");
  const androidWebSocketControlSupport = readText("clients/township-tauri-shell/test/support/android_websocket_control.ts");
  const androidApkManifestSupport = readText("clients/township-tauri-shell/test/support/android_apk_manifest.ts");
  const beamPeerSupport = readText("clients/township-tauri-shell/test/support/beam_peer.ts");
  const strategy = readText("docs/township_mobile_secure_store_strategy.md");
  const buildMap = readText("TOWNSHIP_BUILD_MAP.md");
  const plan084 = readText("plans/084-tauri-android-release-canonical-wire-fidelity-e1.md");
  const plan085 = readText("plans/085-tauri-android-release-transport-characterization-e1.md");
  const plan086 = readText("plans/086-tauri-android-debug-positive-transport-control-e1.md");
  const plan087 = readText("plans/087-tauri-android-release-reverse-tunnel-control-e1.md");
  const plan088 = readText("plans/088-tauri-android-release-cleartext-diagnostic-e1.md");
  const plan089 = readText("plans/089-tauri-android-release-loopback-scoped-network-security-e1.md");
  const plan090 = readText("plans/090-tauri-android-release-beam-handshake-e1.md");
  const plan091 = readText("plans/091-tauri-android-release-pull-reload-e1.md");
  const plan092 = readText("plans/092-tauri-android-release-author-push-e1.md");
  const plan093 = readText("plans/093-tauri-android-release-deeplink-pairing-ingress-e1.md");
  const releaseTransportAdr = readText("docs/adr/0010-android-release-carrier-transport-policy.md");

  assert.equal(pkg.scripts["tauri:ios:init"], "tauri ios init --ci --skip-targets-install");
  assert.equal(pkg.scripts["tauri:android:init"], "tauri android init --ci --skip-targets-install");
  assert.equal(
    pkg.scripts["tauri:android:build:debug"],
    "PATH=/opt/homebrew/opt/rustup/bin:$PATH tauri android build --debug --apk --ci",
  );
  assert.equal(
    pkg.scripts["tauri:android:build:release"],
    "PATH=/opt/homebrew/opt/rustup/bin:$PATH tauri android build --apk --ci",
  );
  assert.doesNotMatch(pkg.scripts["tauri:android:build:release"], /VITE_TOWNSHIP_RELEASE_BEAM_PROBE/);
  assert.doesNotMatch(pkg.scripts["tauri:android:build:release"], /VITE_TOWNSHIP_RELEASE_SYNC_PROBE/);
  assert.equal(pkg.scripts["tauri:android:emulator:smoke"], "tsx test/tauri_android_emulator_smoke.ts");
  assert.equal(pkg.scripts["tauri:android:beam:smoke"], "tsx test/tauri_android_beam_smoke.ts");
  assert.equal(pkg.scripts["tauri:android:authoring:smoke"], "tsx test/tauri_android_authoring_smoke.ts");
  assert.equal(pkg.scripts["tauri:android:onboarding:smoke"], "tsx test/tauri_android_onboarding_smoke.ts");
  assert.equal(pkg.scripts["tauri:android:release:smoke"], "tsx test/tauri_android_release_smoke.ts");
  assert.equal(pkg.scripts["canonical:probe:contract"], "tsx test/township_canonical_probe.ts");
  assert.equal(pkg.scripts["release:transport:contract"], "tsx test/township_release_transport_probe.ts");
  assert.equal(pkg.scripts["release:beam:contract"], "tsx test/township_release_beam_probe.ts");
  assert.equal(pkg.scripts["release:sync:contract"], "tsx test/township_release_sync_probe.ts");
  assert.equal(pkg.scripts["release:author:contract"], "tsx test/township_release_author_probe.ts");
  assert.equal(pkg.scripts["release:pairing:contract"], "tsx test/township_release_pairing_probe.ts");
  assert.equal(
    pkg.scripts["tauri:android:release:canonical:smoke"],
    "tsx test/tauri_android_release_canonical_probe.ts",
  );
  assert.equal(
    pkg.scripts["tauri:android:build:debug:transport-probe"],
    "VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URL=ws://127.0.0.1:43186/carrier PATH=/opt/homebrew/opt/rustup/bin:$PATH tauri android build --debug --apk --ci",
  );
  assert.equal(
    pkg.scripts["tauri:android:debug:transport:smoke"],
    "tsx test/tauri_android_debug_transport_probe.ts",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:transport:smoke"],
    "tsx test/tauri_android_release_transport_probe.ts",
  );
  assert.equal(pkg.scripts["tauri:android:release:beam:smoke"], "tsx test/tauri_android_release_beam_probe.ts");
  assert.equal(pkg.scripts["tauri:android:release:sync:smoke"], "tsx test/tauri_android_release_sync_probe.ts");
  assert.equal(pkg.scripts["tauri:android:release:author:smoke"], "tsx test/tauri_android_release_author_probe.ts");
  assert.equal(pkg.scripts["tauri:android:release:pairing:smoke"], "tsx test/tauri_android_release_pairing_probe.ts");
  assert.match(
    pkg.scripts["tauri:android:build:release:beam-probe"],
    /VITE_TOWNSHIP_RELEASE_BEAM_PROBE_URL=ws:\/\/127\.0\.0\.1:43190\/carrier/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:beam-probe"],
    /VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_PUBKEY=Ze1W\+4DnnK6aoJY5GiUoDVyZVhq5\/PCL7UwQALXUQNk=/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:sync-probe"],
    /VITE_TOWNSHIP_RELEASE_SYNC_PROBE_URL=ws:\/\/127\.0\.0\.1:43191\/carrier/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:sync-probe"],
    /VITE_TOWNSHIP_RELEASE_SYNC_PROBE_PEER_PUBKEY=Ze1W\+4DnnK6aoJY5GiUoDVyZVhq5\/PCL7UwQALXUQNk=/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:sync-probe"],
    /VITE_TOWNSHIP_RELEASE_SYNC_PROBE_STORAGE_NAMESPACE=township:release-sync-probe/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:sync-probe"],
    /VITE_TOWNSHIP_RELEASE_SYNC_PROBE_TIMEOUT_MS=8000/,
  );
  assert.doesNotMatch(pkg.scripts["tauri:android:build:release"], /VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE/);
  assert.doesNotMatch(pkg.scripts["tauri:android:build:release"], /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE/);
  assert.match(
    pkg.scripts["tauri:android:build:release:author-probe"],
    /VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_URL=ws:\/\/127\.0\.0\.1:43192\/carrier/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:author-probe"],
    /VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PEER_PUBKEY=Ze1W\+4DnnK6aoJY5GiUoDVyZVhq5\/PCL7UwQALXUQNk=/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:author-probe"],
    /VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_STORAGE_NAMESPACE=township:release-author-probe/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:author-probe"],
    /VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_TIMEOUT_MS=12000/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:pairing-probe"],
    /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_LOCAL_REALM=resident/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:pairing-probe"],
    /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_KEY_ID=township-release-pairing-resident/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:pairing-probe"],
    /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_STORAGE_NAMESPACE=township:release-pairing-probe/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:pairing-probe"],
    /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_TIMEOUT_MS=60000/,
  );
  assert.doesNotMatch(
    pkg.scripts["tauri:android:build:release:pairing-probe"],
    /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_(?:URL|PEER_REALM|PEER_PUBKEY|REPLICA)=/,
  );
  assert.equal(
    pkg.scripts["tauri:android:build:release:transport-probe"],
    "VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URLS=ws://127.0.0.1:43185/carrier,ws://10.0.2.2:43185/carrier PATH=/opt/homebrew/opt/rustup/bin:$PATH tauri android build --apk --ci",
  );
  const releaseCleartextDiagnosticBuildScript =
    pkg.scripts["tauri:android:build:release:cleartext-diagnostic:transport-probe"];
  assert.match(releaseCleartextDiagnosticBuildScript, /tmpdir=\$\(mktemp -d\)/);
  assert.match(releaseCleartextDiagnosticBuildScript, /trap 'rm -rf "\$tmpdir"' EXIT/);
  assert.match(
    releaseCleartextDiagnosticBuildScript,
    /VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URLS=ws:\/\/127\.0\.0\.1:43185\/carrier,ws:\/\/10\.0\.2\.2:43185\/carrier[\s\S]*cp src-tauri\/gen\/android\/app\/build\/outputs\/apk\/universal\/release\/app-universal-release\.apk "\$tmpdir\/app-universal-release\.apk"[\s\S]*TOWNSHIP_ANDROID_RELEASE_CLEAR_TEXT_DIAGNOSTIC=1 VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URL=ws:\/\/127\.0\.0\.1:43188\/carrier[\s\S]*cp src-tauri\/gen\/android\/app\/build\/outputs\/apk\/universal\/release\/app-universal-release\.apk src-tauri\/gen\/android\/app\/build\/outputs\/apk\/universal\/release\/app-universal-release-cleartextdiag\.apk[\s\S]*cp "\$tmpdir\/app-universal-release\.apk" src-tauri\/gen\/android\/app\/build\/outputs\/apk\/universal\/release\/app-universal-release\.apk/,
  );
  assert.equal(
    pkg.scripts["tauri:android:release:cleartext-diagnostic:smoke"],
    "tsx test/tauri_android_release_cleartext_diagnostic_probe.ts",
  );
  assert.equal(pkg.scripts.tauri, "tauri");
  assert.equal(pkg.scripts["mobile:tauri-readiness"], "node --test test/tauri_mobile_readiness.mjs");
  assert.equal(shellTsconfig.compilerOptions.resolveJsonModule, true);

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
  const androidIntentPlugin = readText(
    "clients/township-tauri-shell/src-tauri/gen/android/app/src/main/java/dev/treetop/lattice/township/intent/TownshipIntentPlugin.kt",
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
  assert.match(androidGradle, /providers\.environmentVariable\("TOWNSHIP_ANDROID_RELEASE_CLEAR_TEXT_DIAGNOSTIC"\)/);
  assert.doesNotMatch(androidGradle, /System\.getenv\("TOWNSHIP_ANDROID_RELEASE_CLEAR_TEXT_DIAGNOSTIC"\)/);
  assert.match(androidGradle, /manifestPlaceholders\["usesCleartextTraffic"\] = "false"/);
  assert.match(
    androidGradle,
    /manifestPlaceholders\["networkSecurityConfig"\] = "@xml\/township_release_network_security_config"/,
  );
  const androidReleaseBuildType = extractBlock(androidGradle, 'getByName("release")');
  const androidDebugBuildType = extractBlock(androidGradle, 'getByName("debug")');
  assert.match(androidReleaseBuildType, /local installability smoke only/i);
  assert.match(androidReleaseBuildType, /signingConfig = signingConfigs\.getByName\("debug"\)/);
  assert.match(androidReleaseBuildType, /isMinifyEnabled = true/);
  assert.match(androidReleaseBuildType, /applicationIdSuffix = "\.cleartextdiag"/);
  assert.match(androidReleaseBuildType, /versionNameSuffix = "-cleartextdiag"/);
  assert.match(androidReleaseBuildType, /manifestPlaceholders\["usesCleartextTraffic"\] = "true"/);
  assert.match(androidDebugBuildType, /manifestPlaceholders\["usesCleartextTraffic"\] = "true"/);
  assert.match(
    androidDebugBuildType,
    /manifestPlaceholders\["networkSecurityConfig"\] = "@xml\/township_debug_network_security_config"/,
  );
  assert.match(androidManifest, /android:name="\.MainActivity"/);
  assert.match(androidManifest, /android:allowBackup="false"/);
  assert.match(androidManifest, /android:networkSecurityConfig="\$\{networkSecurityConfig\}"/);
  assert.match(androidReleaseNetworkSecurityConfig, /<base-config cleartextTrafficPermitted="false"\s*\/>/);
  assert.match(androidReleaseNetworkSecurityConfig, /<domain-config cleartextTrafficPermitted="true">/);
  assert.match(androidReleaseNetworkSecurityConfig, /<domain includeSubdomains="false">127\.0\.0\.1<\/domain>/);
  assert.match(androidReleaseNetworkSecurityConfig, /<domain includeSubdomains="false">localhost<\/domain>/);
  assert.match(androidDebugNetworkSecurityConfig, /<base-config cleartextTrafficPermitted="true"\s*\/>/);
  assert.match(androidMainActivity, /import io\.crates\.keyring\.Keyring/);
  assert.match(androidMainActivity, /import android\.content\.Intent/);
  assert.match(androidMainActivity, /import dev\.treetop\.lattice\.township\.intent\.TownshipIntentStore/);
  assert.match(
    androidMainActivity,
    /override fun onCreate\(savedInstanceState: Bundle\?\) \{\s+TownshipIntentStore\.record\(intent, "activity_on_create"\)[\s\S]+super\.onCreate\(savedInstanceState\)/,
  );
  assert.match(
    androidMainActivity,
    /override fun onNewIntent\(intent: Intent\) \{\s+TownshipIntentStore\.record\(intent, "activity_on_new_intent"\)[\s\S]+super\.onNewIntent\(intent\)/,
  );
  assert.match(androidMainActivity, /System\.loadLibrary\("township_tauri_shell"\)/);
  assert.match(androidMainActivity, /Keyring\.initializeNdkContext\(applicationContext\)/);
  assert.match(androidIntentPlugin, /object TownshipIntentStore/);
  assert.match(androidIntentPlugin, /LOG_PREFIX = "township-android-intent-store"/);
  assert.match(androidIntentPlugin, /fun record\(intent: Intent\?, source: String = "plugin"\)/);
  assert.match(androidIntentPlugin, /routeShape\(intent\?\.data\)/);
  assert.match(androidIntentPlugin, /intent\?\.data\?\.scheme == "township"/);
  assert.match(androidIntentPlugin, /intent\?\.data\?\.toString\(\)/);
  assert.match(androidIntentPlugin, /fun peek\(\): String\?/);
  assert.match(androidIntentPlugin, /has_current=\$\{currentUrl != null\}/);
  assert.match(androidIntentPlugin, /private fun routeShape\(uri: Uri\?\): String/);
  assert.match(androidIntentPlugin, /pairing_payload/);
  assert.match(androidIntentPlugin, /currentUrl = TownshipIntentStore\.peek\(\)/);
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
  assert.match(nativeLib, /pub const TOWNSHIP_PROBE_LOG_TAG: &str = "LATTICE_PROBE"/);
  assert.match(nativeLib, /fn lattice_log_probe/);
  assert.match(nativeLib, /__android_log_write/);
  assert.match(nativeWorkflow, /export const TOWNSHIP_LOG_PROBE_COMMAND = "lattice_log_probe"/);
  assert.match(nativeWorkflow, /logTownshipProbeEvent/);
  assert.match(canonicalProbeSource, /createTownshipCanonicalProbeDeepLinkListener/);
  assert.match(canonicalProbeSource, /logTownshipCanonicalProbe/);
  assert.match(releaseTransportProbeSource, /TOWNSHIP_RELEASE_TRANSPORT_PROBE_LOG_PREFIX = "township-release-transport-probe"/);
  assert.match(releaseTransportProbeSource, /VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URL/);
  assert.match(releaseTransportProbeSource, /VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URLS/);
  assert.match(releaseTransportProbeSource, /probeTownshipReleaseTransport/);
  assert.match(releaseTransportProbeSource, /logTownshipReleaseTransportProbeFromEnv/);
  assert.match(releaseTransportProbeSource, /logTownshipReleaseTransportProbesFromEnv/);
  assert.match(releaseTransportProbeSource, /townshipReleaseTransportProbeUrlsFromEnv/);
  assert.match(releaseTransportProbeSource, /host === "10\.0\.2\.2"/);
  assert.doesNotMatch(releaseTransportProbeSource, /connectCarrierWebSocket|Sync outbox|stateReport/);
  assert.match(releaseBeamProbeSource, /TOWNSHIP_RELEASE_BEAM_PROBE_LOG_PREFIX = "township-release-beam-probe"/);
  assert.match(releaseBeamProbeSource, /VITE_TOWNSHIP_RELEASE_BEAM_PROBE_URL/);
  assert.match(releaseBeamProbeSource, /VITE_TOWNSHIP_RELEASE_BEAM_PROBE_LOCAL_REALM/);
  assert.match(releaseBeamProbeSource, /VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_REALM/);
  assert.match(releaseBeamProbeSource, /VITE_TOWNSHIP_RELEASE_BEAM_PROBE_PEER_PUBKEY/);
  assert.match(releaseBeamProbeSource, /VITE_TOWNSHIP_RELEASE_BEAM_PROBE_REPLICA/);
  assert.match(releaseBeamProbeSource, /createTownshipNativeWorkflow/);
  assert.match(releaseBeamProbeSource, /connectCarrierWebSocket/);
  assert.match(releaseBeamProbeSource, /public_key_b64url/);
  assert.match(releaseBeamProbeSource, /stateReport/);
  assert.match(releaseBeamProbeSource, /townshipReleaseTransportProbeHostClass\(value\) === "loopback"/);
  assert.doesNotMatch(releaseBeamProbeSource, /Sync outbox|connectToAppWebView|webview_devtools_remote/);
  assert.match(releaseSyncProbeSource, /TOWNSHIP_RELEASE_SYNC_PROBE_LOG_PREFIX = "township-release-sync-probe"/);
  assert.match(releaseSyncProbeSource, /TOWNSHIP_RELEASE_SYNC_PROBE_STORAGE_NAMESPACE = "township:release-sync-probe"/);
  assert.match(releaseSyncProbeSource, /VITE_TOWNSHIP_RELEASE_SYNC_PROBE_URL/);
  assert.match(releaseSyncProbeSource, /VITE_TOWNSHIP_RELEASE_SYNC_PROBE_PEER_PUBKEY/);
  assert.match(releaseSyncProbeSource, /VITE_TOWNSHIP_RELEASE_SYNC_PROBE_STORAGE_NAMESPACE/);
  assert.match(releaseSyncProbeSource, /createTownshipNativeWorkflow/);
  assert.match(releaseSyncProbeSource, /syncTownshipOutbox/);
  assert.match(releaseSyncProbeSource, /townshipReleaseSyncReloadResult/);
  assert.match(releaseSyncProbeSource, /pulled_op_ids/);
  assert.match(releaseSyncProbeSource, /local_op_ids/);
  assert.match(releaseSyncProbeSource, /delegation_frame_ids/);
  assert.match(releaseSyncProbeSource, /townshipReleaseTransportProbeHostClass\(value\) === "loopback"/);
  assert.doesNotMatch(
    releaseSyncProbeSource,
    /connectToAppWebView|webview_devtools_remote|clickButtonByText|kvJson|run-as|body:|sig:|cap:/,
  );
  assert.match(releaseAuthorProbeSource, /TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX = "township-release-author-probe"/);
  assert.match(releaseAuthorProbeSource, /TOWNSHIP_RELEASE_AUTHOR_PROBE_STORAGE_NAMESPACE = "township:release-author-probe"/);
  assert.match(releaseAuthorProbeSource, /VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_URL/);
  assert.match(releaseAuthorProbeSource, /VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_PEER_PUBKEY/);
  assert.match(releaseAuthorProbeSource, /VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_STORAGE_NAMESPACE/);
  assert.match(releaseAuthorProbeSource, /createTownshipNativeWorkflow/);
  assert.match(releaseAuthorProbeSource, /townshipReleaseAuthorReloadResult/);
  assert.match(releaseAuthorProbeSource, /submitTownshipPost/);
  assert.match(releaseAuthorProbeSource, /authorTownshipCommand/);
  assert.match(releaseAuthorProbeSource, /syncTownshipOutbox/);
  assert.match(releaseAuthorProbeSource, /connectTownshipCarrierPeer/);
  assert.match(releaseAuthorProbeSource, /post_materialized/);
  assert.match(releaseAuthorProbeSource, /bad_authority_reason/);
  assert.match(releaseAuthorProbeSource, /operation_not_granted/);
  assert.match(releaseAuthorProbeSource, /townshipReleaseTransportProbeHostClass\(value\) === "loopback"/);
  assert.doesNotMatch(
    releaseAuthorProbeSource,
    /connectToAppWebView|webview_devtools_remote|clickButtonByText|kvJson|run-as|body:|sig:|cap:/,
  );
  assert.match(releasePairingProbeSource, /TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX = "township-release-pairing-probe"/);
  assert.match(releasePairingProbeSource, /TOWNSHIP_RELEASE_PAIRING_PROBE_STORAGE_NAMESPACE = "township:release-pairing-probe"/);
  assert.match(releasePairingProbeSource, /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_LOCAL_REALM/);
  assert.match(releasePairingProbeSource, /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_KEY_ID/);
  assert.match(releasePairingProbeSource, /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_STORAGE_NAMESPACE/);
  assert.match(releasePairingProbeSource, /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_URL/);
  assert.match(releasePairingProbeSource, /createTownshipPairingDeepLinkListener/);
  assert.match(releasePairingProbeSource, /createTauriPairingDeepLinkSource/);
  assert.match(releasePairingProbeSource, /saveTownshipCarrierPeerConfig/);
  assert.match(releasePairingProbeSource, /loadTownshipCarrierPeerConfig\(workflow\.storage, \{\}\)/);
  assert.match(releasePairingProbeSource, /syncTownshipOutbox/);
  assert.match(releasePairingProbeSource, /townshipReleaseTransportProbeHostClass\(value\) === "loopback"/);
  assert.match(releasePairingProbeSource, /pairingHandoffSecretReason/);
  assert.match(releasePairingProbeSource, /keyid/);
  assert.doesNotMatch(
    releasePairingProbeSource,
    /connectToAppWebView|webview_devtools_remote|clickButtonByText|kvJson|run-as|body:|sig:|cap:/,
  );
  assert.match(appVue, /isAndroidTauriShell/);
  assert.match(appVue, /logTownshipCanonicalProbe\(\)/);
  assert.match(appVue, /logTownshipReleaseBeamProbeFromEnv/);
  assert.match(appVue, /logTownshipReleaseSyncProbeFromEnv/);
  assert.match(appVue, /logTownshipReleaseAuthorProbeFromEnv/);
  assert.match(appVue, /logTownshipReleasePairingProbeFromEnv/);
  assert.match(appVue, /logTownshipReleaseTransportProbesFromEnv/);
  assert.match(appVue, /mountCanonicalProbeDeepLinkListener/);
  assert.match(appVue, /parseTownshipCanonicalProbeDeepLink/);
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
  assert.match(beamPeerSupport, /publicKeyBase64/);
  assert.match(beamPeerSupport, /identitySeed/);
  assert.match(beamPeerSupport, /PEER_PUBKEY/);
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
  assert.match(androidAuthoringSmoke, /tauri:android:authoring:smoke/);
  assert.match(androidAuthoringSmoke, /Township post update/);
  assert.match(androidAuthoringSmoke, /Post update/);
  assert.match(androidAuthoringSmoke, /author === devicePublicKeyBase64/);
  assert.match(androidAuthoringSmoke, /canonicalBytesForCarrierOp/);
  assert.match(androidAuthoringSmoke, /stateReport/);
  assert.match(androidAuthoringSmoke, /authority_quarantine/);
  assert.match(androidOnboardingSmoke, /tauri:android:onboarding:smoke/);
  assert.match(androidOnboardingSmoke, /Pairing handoff/);
  assert.match(androidOnboardingSmoke, /Load handoff/);
  assert.match(androidOnboardingSmoke, /Save pairing/);
  assert.match(androidOnboardingSmoke, /Sync outbox/);
  assert.match(androidOnboardingSmoke, /pulledGrantDelegationId/);
  assert.match(androidOnboardingSmoke, /Township post update/);
  assert.match(androidOnboardingSmoke, /capId === pulledGrantDelegationId/);
  assert.match(androidOnboardingSmoke, /stateReport/);
  assert.match(androidOnboardingSmoke, /authority_quarantine/);
  assert.match(androidReleaseSmoke, /tauri:android:release:smoke/);
  assert.match(androidReleaseSmoke, /app-universal-release\.apk/);
  assert.match(androidReleaseSmoke, /installReleaseApk/);
  assert.match(androidReleaseSmoke, /launchApp/);
  assert.match(androidReleaseSmoke, /pidof/);
  assert.doesNotMatch(androidReleaseSmoke, /connectToAppWebView|webview_devtools_remote|Sync outbox|stateReport/);
  assert.match(canonicalProbeContract, /township:\/\/probe\/canonical\?vector=township_carrier_w1/);
  assert.match(canonicalProbeContract, /TOWNSHIP_LOG_PROBE_COMMAND/);
  assert.match(canonicalProbeContract, /expectedTownshipCanonicalProbeDigest/);
  assert.match(releaseTransportProbeContract, /OpeningWebSocket/);
  assert.match(releaseTransportProbeContract, /FailingWebSocket/);
  assert.match(releaseTransportProbeContract, /UnexpectedWebSocket/);
  assert.match(releaseTransportProbeContract, /logTownshipReleaseTransportProbeFromEnv/);
  assert.match(releaseTransportProbeContract, /ws:\/\/\[::1\]:43185\/carrier/);
  assert.match(releaseTransportProbeContract, /outcome=connected/);
  assert.match(releaseTransportProbeContract, /message=transport_error/);
  assert.match(releaseTransportProbeContract, /message=frame_roundtrip/);
  assert.match(releaseBeamProbeContract, /peer not ready/);
  assert.match(releaseBeamProbeContract, /phase=native_key/);
  assert.match(releaseBeamProbeContract, /phase=carrier/);
  assert.match(releaseBeamProbeContract, /ws:\/\/10\.0\.2\.2:43190\/carrier/);
  assert.match(releaseBeamProbeContract, /wss:\/\/example\.com\/carrier/);
  assert.match(releaseSyncProbeContract, /ws:\/\/10\.0\.2\.2:43191\/carrier/);
  assert.match(releaseSyncProbeContract, /wss:\/\/example\.com\/carrier/);
  assert.match(releaseSyncProbeContract, /phase=reload/);
  assert.match(releaseSyncProbeContract, /outcome=synced/);
  assert.match(releaseSyncProbeContract, /pulled_op_ids=pulled/);
  assert.match(releaseAuthorProbeContract, /ws:\/\/10\.0\.2\.2:43192\/carrier/);
  assert.match(releaseAuthorProbeContract, /wss:\/\/example\.com\/carrier/);
  assert.match(releaseAuthorProbeContract, /phase=reload/);
  assert.match(releaseAuthorProbeContract, /phase=pull/);
  assert.match(releaseAuthorProbeContract, /phase=author/);
  assert.match(releaseAuthorProbeContract, /phase=push/);
  assert.match(releaseAuthorProbeContract, /phase=peer/);
  assert.match(releaseAuthorProbeContract, /bad_authority_reason=operation_not_granted/);
  assert.match(releasePairingProbeContract, /township:\/\/pairing\?handoff=/);
  assert.match(releasePairingProbeContract, /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_URL/);
  assert.match(releasePairingProbeContract, /phase=native_key/);
  assert.match(releasePairingProbeContract, /paired=false/);
  assert.match(releasePairingProbeContract, /phase=pairing/);
  assert.match(releasePairingProbeContract, /outcome=saved/);
  assert.match(releasePairingProbeContract, /paired=true/);
  assert.match(releasePairingProbeContract, /phase=sync/);
  assert.match(releasePairingProbeContract, /ws:\/\/127\.0\.0\.1:43193\/carrier/);
  assert.match(releasePairingProbeContract, /carrier_peer_config/);
  assert.match(canonicalProbeSource, /township_carrier_w1\.json/);
  assert.match(canonicalProbeSource, /canonicalBytesForCarrierOp/);
  assert.match(canonicalProbeSource, /canonicalHash/);
  assert.match(canonicalProbeSource, /TOWNSHIP_CANONICAL_PROBE_LOG_PREFIX = "township-canonical-probe"/);
  assert.match(canonicalProbeSource, /mismatches=\$\{result\.mismatches\.length\}/);
  assert.doesNotMatch(canonicalProbeSource, /connectCarrierWebSocket|Sync outbox|10\.0\.2\.2|stateReport/);
  assert.match(androidReleaseCanonicalSmoke, /tauri:android:release:canonical:smoke/);
  assert.match(androidReleaseCanonicalSmoke, /app-universal-debug\\\.apk/);
  assert.match(androidReleaseCanonicalSmoke, /app-universal-release\\\.apk/);
  assert.match(androidReleaseCanonicalSmoke, /logcat/);
  assert.match(androidReleaseCanonicalSmoke, /android\.intent\.action\.VIEW/);
  assert.match(androidReleaseCanonicalSmoke, /android\.intent\.category\.BROWSABLE/);
  assert.match(androidReleaseCanonicalSmoke, /appActivity/);
  assert.match(androidReleaseCanonicalSmoke, /delay\(8_000\)/);
  assert.match(androidReleaseCanonicalSmoke, /township:\/\/probe\/canonical/);
  assert.match(androidReleaseCanonicalSmoke, /LATTICE_PROBE/);
  assert.match(androidReleaseCanonicalSmoke, /dumpsys/);
  assert.match(androidReleaseCanonicalSmoke, /DEBUGGABLE/);
  assert.match(androidReleaseCanonicalSmoke, /assertReleasePackageIsNotDebuggable/);
  assert.match(androidReleaseCanonicalSmoke, /packageSectionPattern/);
  assert.match(androidReleaseCanonicalSmoke, /flags=/);
  assert.match(androidReleaseCanonicalSmoke, /candidate\.includes\(TOWNSHIP_CANONICAL_PROBE_LOG_PREFIX\)/);
  assert.match(androidReleaseCanonicalSmoke, /actualDigest/);
  assert.doesNotMatch(androidReleaseCanonicalSmoke, /candidate\.includes\(expectedDigest\)/);
  assert.doesNotMatch(
    androidReleaseCanonicalSmoke,
    /connectToAppWebView|webview_devtools_remote|Sync outbox|stateReport|10\.0\.2\.2/,
  );
  assert.match(androidReleaseTransportSmoke, /tauri:android:release:transport:smoke/);
  assert.match(androidReleaseTransportSmoke, /app-universal-release\.apk/);
  assert.match(androidReleaseTransportSmoke, /adb reverse/);
  assert.match(androidReleaseTransportSmoke, /township-release-transport-probe/);
  assert.match(androidReleaseTransportSmoke, /surface=webview-websocket/);
  assert.match(androidReleaseTransportSmoke, /host_class=loopback/);
  assert.match(androidReleaseTransportSmoke, /host_class=android_host/);
  assert.match(androidReleaseTransportSmoke, /outcome=connected/);
  assert.match(androidReleaseTransportSmoke, /message=frame_roundtrip/);
  assert.match(androidReleaseTransportSmoke, /outcome=error/);
  assert.match(androidReleaseTransportSmoke, /assertHostWebSocketEndpoint/);
  assert.match(androidReleaseTransportSmoke, /assertAndroidDeviceWebSocketEndpoint/);
  assert.match(androidReleaseTransportSmoke, /waitForProbeStats/);
  assert.match(androidReleaseTransportSmoke, /host and device shell controls/);
  assert.match(androidReleaseTransportSmoke, /assertAndroidEmulatorHostAlias/);
  assert.match(androidReleaseTransportSmoke, /assertAndroidDeviceWebSocketEndpoint\(serial, probePort, "10\.0\.2\.2"\)/);
  assert.match(androidReleaseTransportSmoke, /accepts: 3, upgrades: 3/);
  assert.match(androidReleaseTransportSmoke, /host, loopback device shell, and android host alias controls/);
  assert.match(androidReleaseTransportSmoke, /readRecentTransportDiagnosticLogcat/);
  assert.match(androidReleaseTransportSmoke, /logcat", "-d", "-t", "200"/);
  assert.match(androidReleaseTransportSmoke, /diagnostic logcat slice after release probe/);
  assert.match(androidReleaseTransportSmoke, /assertReverseMapping/);
  assert.match(androidReleaseTransportSmoke, /releaseTransportProbePortFromBuildScript/);
  assert.match(androidReleaseTransportSmoke, /VITE_TOWNSHIP_RELEASE_TRANSPORT_PROBE_URLS/);
  assert.match(androidReleaseTransportSmoke, /ws:\/\/127\.0\.0\.1:43185\/carrier/);
  assert.match(androidReleaseTransportSmoke, /ws:\/\/10\.0\.2\.2:43185\/carrier/);
  assert.match(androidReleaseTransportSmoke, /controlStats\.accepts/);
  assert.match(androidReleaseTransportSmoke, /controlStats\.upgrades/);
  assert.match(androidReleaseTransportSmoke, /webViewStats\.accepts/);
  assert.match(androidReleaseTransportSmoke, /assert\.equal\(webViewStats\.accepts, 1/);
  assert.match(androidReleaseTransportSmoke, /assert\.equal\(webViewStats\.upgrades, 1/);
  assert.match(androidReleaseTransportSmoke, /assert\.equal\(webViewStats\.framesEchoed, 1/);
  assert.match(androidReleaseTransportSmoke, /server scoped webview stats after controls/);
  assert.match(androidReleaseTransportSmoke, /dumpsys/);
  assert.match(androidReleaseTransportSmoke, /DEBUGGABLE/);
  assert.match(androidReleaseTransportSmoke, /assertApkUsesCleartextTraffic\(apkPath, false/);
  assert.match(androidReleaseTransportSmoke, /assertApkNetworkSecurityConfig/);
  assert.match(androidReleaseTransportSmoke, /baseCleartextTrafficPermitted: false/);
  assert.match(androidReleaseTransportSmoke, /cleartextDomains: \["127\.0\.0\.1", "localhost"\]/);
  assert.match(androidReleaseTransportSmoke, /assertAndroidApiLevelSupportsNetworkSecurityConfig/);
  assert.match(androidReleaseBeamSmoke, /tauri:android:release:beam:smoke/);
  assert.match(androidReleaseBeamSmoke, /app-universal-release\.apk/);
  assert.match(androidReleaseBeamSmoke, /assertApkUsesCleartextTraffic\(apkPath, false/);
  assert.match(androidReleaseBeamSmoke, /assertApkNetworkSecurityConfig/);
  assert.match(androidReleaseBeamSmoke, /public_key_b64url/);
  assert.match(androidReleaseBeamSmoke, /spawnTownshipPeer/);
  assert.match(androidReleaseBeamSmoke, /wrongPeer/);
  assert.match(androidReleaseBeamSmoke, /identitySeed: "wrong-township-release-beam-peer"/);
  assert.match(androidReleaseBeamSmoke, /assertNoConnectedReleaseBeamCarrierLog/);
  assert.match(androidReleaseBeamSmoke, /peer\.publicKeyBase64/);
  assert.match(androidReleaseBeamSmoke, /trustedPeerPubkey: devicePublicKeyBase64/);
  assert.match(androidReleaseBeamSmoke, /reverse", `tcp:\$\{buildConfig\.port\}`, `tcp:\$\{peer\.port\}`/);
  assert.match(androidReleaseBeamSmoke, /Package \\\\?\[/);
  assert.match(androidReleaseBeamSmoke, /version\(\?:Code\|Name\)=/);
  assert.match(androidReleaseBeamSmoke, /phase=carrier/);
  assert.match(androidReleaseBeamSmoke, /outcome=connected/);
  assert.match(androidReleaseBeamSmoke, /status=base/);
  assert.match(androidReleaseBeamSmoke, /op_count=\\d\+/);
  assert.match(androidReleaseBeamSmoke, /authority_quarantine_count=\\d\+/);
  assert.doesNotMatch(
    androidReleaseBeamSmoke,
    /connectToAppWebView|webview_devtools_remote|Sync outbox|clickButtonByText|kvJson/,
  );
  assert.match(androidReleaseSyncSmoke, /tauri:android:release:sync:smoke/);
  assert.match(androidReleaseSyncSmoke, /app-universal-release\.apk/);
  assert.match(androidReleaseSyncSmoke, /assertApkUsesCleartextTraffic\(apkPath, false/);
  assert.match(androidReleaseSyncSmoke, /assertApkNetworkSecurityConfig/);
  assert.match(androidReleaseSyncSmoke, /public_key_b64url/);
  assert.match(androidReleaseSyncSmoke, /wrongPeer/);
  assert.match(androidReleaseSyncSmoke, /identitySeed: "wrong-township-release-sync-peer"/);
  assert.match(androidReleaseSyncSmoke, /outcome=\(\?:error\|timeout\)/);
  assert.match(androidReleaseSyncSmoke, /clientBaseCarrierOps/);
  assert.match(androidReleaseSyncSmoke, /pulled_op_ids/);
  assert.match(androidReleaseSyncSmoke, /local_op_ids/);
  assert.match(androidReleaseSyncSmoke, /delegation_frame_ids/);
  assert.match(androidReleaseSyncSmoke, /success offline cold reload/);
  assert.match(androidReleaseSyncSmoke, /Package \\\\?\[/);
  assert.match(androidReleaseSyncSmoke, /version\(\?:Code\|Name\)=/);
  assert.doesNotMatch(
    androidReleaseSyncSmoke,
    /connectToAppWebView|webview_devtools_remote|clickButtonByText|kvJson|run-as/,
  );
  assert.match(androidReleaseAuthorSmoke, /tauri:android:release:author:smoke/);
  assert.match(androidReleaseAuthorSmoke, /app-universal-release\.apk/);
  assert.match(androidReleaseAuthorSmoke, /assertApkUsesCleartextTraffic\(apkPath, false/);
  assert.match(androidReleaseAuthorSmoke, /assertApkNetworkSecurityConfig/);
  assert.match(androidReleaseAuthorSmoke, /public_key_b64url/);
  assert.match(androidReleaseAuthorSmoke, /fresh install keys differ/);
  assert.match(androidReleaseAuthorSmoke, /bootstrapAudiencePubkey: devicePublicKeyBase64/);
  assert.match(androidReleaseAuthorSmoke, /phase=pull/);
  assert.match(androidReleaseAuthorSmoke, /phase=author/);
  assert.match(androidReleaseAuthorSmoke, /phase=push/);
  assert.match(androidReleaseAuthorSmoke, /phase=peer/);
  assert.match(androidReleaseAuthorSmoke, /phase=reload/);
  assert.match(androidReleaseAuthorSmoke, /post_materialized=true/);
  assert.match(androidReleaseAuthorSmoke, /bad_authority_reason=operation_not_granted/);
  assert.match(androidReleaseAuthorSmoke, /outbox_frame_count=2/);
  assert.match(androidReleaseAuthorSmoke, /outbox_frame_count=0/);
  assert.match(androidReleaseAuthorSmoke, /Package \\\\?\[/);
  assert.match(androidReleaseAuthorSmoke, /version\(\?:Code\|Name\)=/);
  assert.doesNotMatch(
    androidReleaseAuthorSmoke,
    /connectToAppWebView|webview_devtools_remote|clickButtonByText|kvJson|run-as/,
  );
  assert.match(androidReleasePairingSmoke, /tauri:android:release:pairing:smoke/);
  assert.match(androidReleasePairingSmoke, /app-universal-release\.apk/);
  assert.match(androidReleasePairingSmoke, /assertApkUsesCleartextTraffic\(apkPath, false/);
  assert.match(androidReleasePairingSmoke, /assertApkNetworkSecurityConfig/);
  assert.match(androidReleasePairingSmoke, /android\.intent\.action\.VIEW/);
  assert.match(androidReleasePairingSmoke, /android\.intent\.category\.BROWSABLE/);
  assert.match(androidReleasePairingSmoke, /township:\/\/pairing/);
  assert.match(androidReleasePairingSmoke, /appActivity/);
  assert.match(androidReleasePairingSmoke, /phase=pairing/);
  assert.match(androidReleasePairingSmoke, /paired=false/);
  assert.match(androidReleasePairingSmoke, /paired=true/);
  assert.match(androidReleasePairingSmoke, /phase=sync/);
  assert.match(androidReleasePairingSmoke, /spawnTownshipPeer/);
  assert.match(androidReleasePairingSmoke, /bootstrapAudiencePubkey: devicePublicKeyBase64/);
  assert.match(androidReleasePairingSmoke, /reverse", `tcp:\$\{buildConfig\.port\}`, `tcp:\$\{peer\.port\}`/);
  assert.match(androidReleasePairingSmoke, /forceStopApp\(serial\)/);
  assert.match(androidReleasePairingSmoke, /clearLogcat\(serial\)/);
  assert.match(androidReleasePairingSmoke, /Package \\\\?\[/);
  assert.match(androidReleasePairingSmoke, /version\(\?:Code\|Name\)=/);
  assert.doesNotMatch(
    androidReleasePairingSmoke,
    /connectToAppWebView|webview_devtools_remote|clickButtonByText|kvJson|run-as/,
  );
  assert.match(androidApkManifestSupport, /extractManifestNetworkSecurityConfigReference/);
  assert.match(androidApkManifestSupport, /assert\.equal\(\s+manifestResourceId\.toLowerCase\(\),\s+releaseResource\.id\.toLowerCase\(\)/);
  assert.match(androidApkManifestSupport, /extractXmlBooleanAttribute/);
  assert.match(androidApkManifestSupport, /extractXmlDomainTexts/);
  assert.match(androidWebSocketControlSupport, /host = "127\.0\.0\.1"/);
  assert.doesNotMatch(
    androidReleaseTransportSmoke,
    /connectToAppWebView|webview_devtools_remote|Sync outbox|stateReport/,
  );
  assert.match(androidReleaseCleartextDiagnosticSmoke, /tauri:android:release:cleartext-diagnostic:smoke/);
  assert.match(androidReleaseCleartextDiagnosticSmoke, /app-universal-release-cleartextdiag\.apk/);
  assert.match(androidReleaseCleartextDiagnosticSmoke, /dev\.treetop\.lattice\.township\.cleartextdiag/);
  assert.match(androidReleaseCleartextDiagnosticSmoke, /assertApkUsesCleartextTraffic\(apkPath, true/);
  assert.match(androidReleaseCleartextDiagnosticSmoke, /assertReleasePackageIsNotDebuggable/);
  assert.match(androidReleaseCleartextDiagnosticSmoke, /assertAndroidDeviceWebSocketEndpoint/);
  assert.match(androidReleaseCleartextDiagnosticSmoke, /outcome=connected/);
  assert.match(androidReleaseCleartextDiagnosticSmoke, /message=frame_roundtrip/);
  assert.match(androidReleaseCleartextDiagnosticSmoke, /webViewStats\.accepts >= 1/);
  assert.match(androidReleaseCleartextDiagnosticSmoke, /webViewStats\.upgrades >= 1/);
  assert.match(androidReleaseCleartextDiagnosticSmoke, /webViewStats\.framesEchoed >= 1/);
  assert.doesNotMatch(
    androidReleaseCleartextDiagnosticSmoke,
    /connectToAppWebView|webview_devtools_remote|Sync outbox|stateReport|10\.0\.2\.2/,
  );
  assert.match(androidDebugTransportSmoke, /tauri:android:debug:transport:smoke/);
  assert.match(androidDebugTransportSmoke, /app-universal-debug\.apk/);
  assert.match(androidDebugTransportSmoke, /assertDebugPackageIsDebuggable/);
  assert.match(androidDebugTransportSmoke, /adb reverse/);
  assert.match(androidDebugTransportSmoke, /township-release-transport-probe/);
  assert.match(androidDebugTransportSmoke, /surface=webview-websocket/);
  assert.match(androidDebugTransportSmoke, /host_class=loopback/);
  assert.match(androidDebugTransportSmoke, /outcome=connected/);
  assert.match(androidDebugTransportSmoke, /frame_roundtrip/);
  assert.match(androidDebugTransportSmoke, /assertAndroidDeviceWebSocketEndpoint/);
  assert.match(androidDebugTransportSmoke, /waitForProbeStats/);
  assert.match(androidDebugTransportSmoke, /upgrades/);
  assert.match(androidDebugTransportSmoke, /framesEchoed/);
  assert.match(androidDebugTransportSmoke, /webViewStats\.accepts >= 1/);
  assert.match(androidDebugTransportSmoke, /webViewStats\.upgrades >= 1/);
  assert.match(androidDebugTransportSmoke, /webViewStats\.framesEchoed >= 1/);
  assert.match(androidDebugTransportSmoke, /ws:\/\/127\.0\.0\.1:43186\/carrier/);
  assert.doesNotMatch(
    androidDebugTransportSmoke,
    /connectToAppWebView|webview_devtools_remote|Sync outbox|stateReport|10\.0\.2\.2/,
  );
  assert.match(androidWebSocketControlSupport, /assertAndroidDeviceWebSocketEndpoint/);
  assert.match(androidWebSocketControlSupport, /toybox nc/);
  assert.match(androidWebSocketControlSupport, /waitForProbeStats/);

  assert.match(strategy, /Plan 076 adds generated Tauri iOS and Android target scaffolds/);
  assert.match(strategy, /plan 077 pins the repo-side iOS simulator readiness contracts/);
  assert.match(strategy, /plan 078 proves\s+the generated Android target can assemble a debug APK/);
  assert.match(strategy, /Plan 079\s+proves an Android emulator native-key smoke/);
  assert.match(strategy, /Plan 084 proves Android release APK canonical\/wire fidelity/);
  assert.match(strategy, /on Android startup in both debug and\s+release APKs/);
  assert.match(strategy, /township:\/\/probe\/canonical` route remains as a non-secret diagnostic ingress/);
  assert.match(strategy, /release Rust profile and R8'd Android\s+host\s+shell around the unchanged WebView bundle/);
  assert.match(strategy, /Plan 085 characterizes release APK WebView WebSocket\s+transport on loopback/);
  assert.match(strategy, /observed release outcome is `outcome=error`/);
  assert.match(strategy, /registered\s+`adb reverse` mapping/);
  assert.match(strategy, /zero server-side WebView accepts\/upgrades\/echoed frames after controls/);
  assert.match(strategy, /Plan 086 proves a debug APK positive transport control/);
  assert.match(strategy, /outcome=connected/);
  assert.match(strategy, /WebSocket frame roundtrip/);
  assert.match(strategy, /Plan 087 proves\s+the release-route `adb reverse` tunnel/);
  assert.match(strategy, /shell UID/);
  assert.match(strategy, /Plan 088 proves that a separately identified release-shaped cleartext\s+diagnostic APK can complete the loopback WebView frame roundtrip/);
  assert.match(strategy, /cleartext policy is sufficient\s+to explain the observed release WebView failure on this emulator\/WebView version/);
  assert.match(strategy, /not an\s+approved release default/);
  assert.match(strategy, /does not prove release Sync\/outbox\/KV convergence/);
  assert.match(strategy, /Plan 089 proves a\s+normal-app-id release APK with loopback-scoped Android network security config/);
  assert.match(strategy, /Android API 26\+ WebView/);
  assert.match(strategy, /keeping non-loopback cleartext blocked/);
  assert.match(strategy, /Plan 090 proves a release BEAM\s+carrier handshake\/status\/state-report path/);
  assert.match(strategy, /public_key_b64url/);
  assert.match(strategy, /without WebView CDP, Sync, outbox, or\s+native KV inspection/);
  assert.match(strategy, /Plan 091 proves a release APK pull-and-reload path/);
  assert.match(strategy, /dedicated `township:release-sync-probe` storage namespace/);
  assert.match(strategy, /force-stop\/relaunch with the BEAM peer offline/);
  assert.match(strategy, /Plan 092 proves release APK device-local post authoring, push, and outbox drain/);
  assert.match(strategy, /dedicated `township:release-author-probe` storage namespace/);
  assert.match(strategy, /fresh-install runtime keys differ/);
  assert.match(strategy, /post_materialized=true/);
  assert.match(strategy, /bad_authority_reason=operation_not_granted/);
  assert.match(strategy, /Plan 093 proves release APK OS deep-link pairing ingress/);
  assert.match(strategy, /dedicated\s+`township:release-pairing-probe` storage namespace/);
  assert.match(strategy, /Android's `VIEW`\/`BROWSABLE` intent path/);
  assert.match(strategy, /persisted deep-link endpoint rather than a build-time peer URL/);
  assert.match(strategy, /Android Tauri release APK: bounded release pull\/reload, device-local authoring, push\/outbox drain, and OS deep-link peer-config persistence are met by plans 091-093/);
  assert.match(strategy, /Android Tauri release APK: bounded carrier pull\/reload, OS deep-link peer-config persistence, device-local post authoring, persisted pending-outbox reload, push\/outbox drain, and peer-side authority enforcement are met by plans 091-093/);
  assert.doesNotMatch(strategy, /full release Sync\/outbox\/KV convergence, and full mobile onboarding remain unproven in release/);
  assert.doesNotMatch(strategy, /Release mobile Sync\/outbox\/KV convergence, iOS Tauri, and Expo: still unproven/);
  assert.match(strategy, /does not prove QR camera onboarding, app-originated grants, authority origination, LAN\s+discovery, physical-device behavior, production remote TLS, or full mobile onboarding/);
  assert.doesNotMatch(strategy, /under release minification/);
  assert.match(strategy, /not a phone-grade persistence or BEAM\s+convergence proof/);
  assert.match(strategy, /The generated Tauri iOS and Android projects are build targets only/);
  assert.match(strategy, /Android emulator now proves native carrier key reuse/);
  assert.match(strategy, /No phone-grade persistence claim is allowed/);
  assert.match(buildMap, /Plan 077 pins iOS simulator-readiness config/);
  assert.match(buildMap, /Plan 078 pins the Android debug APK build command/);
  assert.match(buildMap, /Plan 079 adds the Android emulator native-key\s+smoke/);
  assert.match(buildMap, /Plan 080 adds the Android debug-APK BEAM convergence smoke/);
  assert.match(buildMap, /Plan 081 adds the Android debug-APK on-device post authoring smoke/);
  assert.match(buildMap, /Plan 082 adds the Android debug-APK pull-based onboarding smoke/);
  assert.match(buildMap, /Plan 083 adds Android release APK build readiness/);
  assert.match(buildMap, /Plan 084 adds Android release-APK canonical\/wire fidelity/);
  assert.match(buildMap, /Plan 085 adds Android release-APK transport characterization/);
  assert.match(buildMap, /release APK WebView WebSocket transport on loopback/);
  assert.match(buildMap, /records `outcome=error` after host-control and registered reverse-mapping checks/);
  assert.match(buildMap, /zero server-side WebView accepts\/upgrades\/echoed frames after controls/);
  assert.match(buildMap, /Plan 086 adds the Android debug-APK positive transport control/);
  assert.match(buildMap, /debug WebView upgrade and echoed frame/);
  assert.match(buildMap, /Plan 087 adds a release-route\s+device-originated reverse-tunnel control/);
  assert.match(buildMap, /shell UID/);
  assert.match(buildMap, /Plan 088 proves a release-shaped cleartext diagnostic APK/);
  assert.match(buildMap, /confirming cleartext policy is\s+sufficient for this emulator\/WebView failure/);
  assert.match(buildMap, /without\s+approving blanket cleartext release defaults/);
  assert.match(buildMap, /Plan 089 proves loopback-scoped Android network security config/);
  assert.match(buildMap, /normal release app id/);
  assert.match(buildMap, /keeping non-loopback cleartext blocked/);
  assert.match(buildMap, /Plan 090\s+proves a release APK BEAM carrier handshake/);
  assert.match(buildMap, /release BEAM carrier handshake\/status\/state-report proof/);
  assert.match(buildMap, /Plan 091 adds Android release APK pull-and-reload persistence/);
  assert.match(buildMap, /release pull \+ KV reload proof/);
  assert.match(buildMap, /Plan 092 adds Android release APK device authoring\/push\/outbox drain/);
  assert.match(buildMap, /release device-local post authoring \+ push\/outbox-drain proof/);
  assert.match(buildMap, /Plan 093 adds Android release APK OS deep-link pairing\s+ingress/);
  assert.match(buildMap, /release OS deep-link peer-config persistence proof/);
  assert.match(
    buildMap,
    /Android release APK pull-and-reload persistence provides a release pull \+ KV reload proof[\s\S]*Android release APK device-local post authoring \+ push\/outbox-drain proof exists under a host-minted bootstrap grant with pre-push pending-outbox cold reload[\s\S]*Android release APK OS deep-link pairing ingress \+ persisted peer-config proof exists in a dedicated probe namespace/,
  );
  assert.match(buildMap, /app-originated grants, authority origination, QR camera onboarding, LAN discovery, and full onboarding remain unproven/);
  assert.doesNotMatch(
    buildMap,
    /release BEAM carrier handshake\/status\/state-report proof exists while release Sync\/outbox\/KV convergence remains unproven/,
  );
  assert.match(buildMap, /release transport policy ADR/);
  assert.match(buildMap, /on Android startup in both debug\s+and release variants/);
  assert.match(buildMap, /township:\/\/probe\/canonical` as a non-secret diagnostic route/);
  assert.match(buildMap, /release Rust profile and R8'd Android\s+host\s+shell around the unchanged WebView bundle/);
  assert.match(buildMap, /Android emulator native carrier key reuse/);
  assert.match(buildMap, /Android debug APK pre-signed-frame BEAM convergence/);
  assert.match(buildMap, /Android debug APK on-device post authoring/);
  assert.match(buildMap, /Android debug APK pull-based cap onboarding/);
  assert.match(buildMap, /Android release APK builds and installs/);
  assert.match(buildMap, /Android release APK canonical\/wire fidelity/);
  assert.match(buildMap, /Xcode 27 beta Tauri Swift-package/);
  assert.doesNotMatch(buildMap, /release mobile BEAM convergence remains unproven/);
  assert.match(buildMap, /full mobile onboarding remains unproven beyond pull-based cap acquisition/);
  assert.doesNotMatch(buildMap, /Android still needs an\s+emulator\/device restart-and-sync smoke/);
  assert.doesNotMatch(buildMap, /phone-grade mobile BEAM convergence smoke (?:is|are|has been) proven/i);

  assert.match(plan084, /release-build-type \(debug-keystore signed\), R8-enabled Android APK/);
  assert.match(plan084, /release Rust profile and R8'd Android\s+host\s+shell around the unchanged WebView bundle/);
  assert.doesNotMatch(plan084, /release-signed/);
  assert.match(plan085, /## Status\s+(?:IN PROGRESS|DONE)/);
  assert.match(plan085, /Release-APK carrier transport characterization/);
  assert.match(plan085, /outcome=error/);
  assert.match(plan085, /server webview stats after\s+controls accepts=0 upgrades=0 framesEchoed=0/);
  assert.match(plan085, /not a convergence proof/);
  assert.match(plan085, /STOP Conditions/);
  assert.match(plan086, /## Status\s+(?:IN PROGRESS|DONE)/);
  assert.match(plan086, /Android debug-APK positive transport control/);
  assert.match(plan086, /outcome=connected/);
  assert.match(plan086, /frame roundtrip/);
  assert.match(plan086, /does not isolate cleartext policy/);
  assert.match(plan086, /does not prove release BEAM convergence/);
  assert.match(plan086, /STOP Conditions/);
  assert.match(plan087, /## Status\s+(?:IN PROGRESS|DONE)/);
  assert.match(plan087, /Android release-route reverse-tunnel control/);
  assert.match(plan087, /shell UID/);
  assert.match(plan087, /outcome=error/);
  assert.match(plan087, /server webview stats after controls accepts=0 upgrades=0 framesEchoed=0/);
  assert.match(plan087, /does not prove release\s+WebView transport/);
  assert.match(plan087, /does not prove release BEAM\s+convergence/);
  assert.match(plan087, /STOP Conditions/);
  assert.match(plan088, /## Status\s+(?:IN PROGRESS|DONE)/);
  assert.match(plan088, /Android release-shaped cleartext diagnostic/);
  assert.match(plan088, /cleartext policy is sufficient/);
  assert.match(plan088, /release-shaped diagnostic APK/);
  assert.match(plan088, /not an approved release default/);
  assert.match(plan088, /does not prove release BEAM\s+convergence/);
  assert.match(plan088, /STOP Conditions/);
  assert.match(plan089, /## Status\s+(?:IN PROGRESS|DONE)/);
  assert.match(plan089, /Android release loopback-scoped network security/);
  assert.match(plan089, /normal(?: release app id|-app-id)/);
  assert.match(plan089, /usesCleartextTraffic=false/);
  assert.match(plan089, /network-security config/);
  assert.match(plan089, /127\.0\.0\.1/);
  assert.match(plan089, /localhost/);
  assert.match(plan089, /10\.0\.2\.2/);
  assert.match(plan089, /Android API 26\+/);
  assert.match(plan089, /not release BEAM\s+convergence|without\s+claiming release BEAM\s+convergence/);
  assert.match(plan089, /STOP Conditions/);
  assert.match(plan090, /## Status\s+(?:IN PROGRESS|DONE)/);
  assert.match(plan090, /Android release BEAM carrier handshake/);
  assert.match(plan090, /non-debuggable/);
  assert.match(plan090, /normal app id|normal-app-id/);
  assert.match(plan090, /public_key_b64url/);
  assert.match(plan090, /adb reverse/);
  assert.match(plan090, /state-report|state report/);
  assert.match(plan090, /does not prove release\s+Sync\/outbox\/KV convergence/);
  assert.match(plan090, /does not add a release command channel/);
  assert.match(plan090, /STOP Conditions/);
  assert.match(plan091, /## Status\s+(?:IN PROGRESS|DONE)/);
  assert.match(plan091, /Android release pull-and-reload persistence/);
  assert.match(plan091, /dedicated probe namespace `township:release-sync-probe`/);
  assert.match(plan091, /wrong-peer negative/);
  assert.match(plan091, /force-stop\/relaunch/);
  assert.match(plan091, /does not prove release device authoring, push, outbox drain, pairing ceremony, or full mobile onboarding/);
  assert.match(plan091, /STOP Conditions/);
  assert.match(plan092, /## Status\s+(?:IN PROGRESS|DONE)/);
  assert.match(plan092, /Android release author\/push\/outbox drain/);
  assert.match(plan092, /fresh-install keys differ/);
  assert.match(plan092, /bootstrapAudiencePubkey/);
  assert.match(plan092, /post_materialized=true/);
  assert.match(plan092, /operation_not_granted/);
  assert.match(plan092, /does not prove pairing ceremony, app-originated grants, or full mobile onboarding/);
  assert.match(plan092, /STOP Conditions/);
  assert.match(plan093, /## Status\s+(?:IN PROGRESS|DONE)/);
  assert.match(plan093, /Android release deep-link pairing ingress/);
  assert.match(plan093, /township:\/\/pairing/);
  assert.match(plan093, /Android's OS intent path|Android's `VIEW`\/`BROWSABLE` intent path/);
  assert.match(plan093, /persisted deep-link\s+endpoint rather than a build-time peer URL/);
  assert.match(plan093, /township:release-pairing-probe/);
  assert.match(plan093, /no env peer URL/i);
  assert.match(plan093, /STOP Conditions/);
  assert.match(releaseTransportAdr, /Android Release Carrier Transport Policy/);
  assert.match(releaseTransportAdr, /Observed Release Transport Behavior/);
  assert.match(releaseTransportAdr, /outcome=error/);
  assert.match(releaseTransportAdr, /Plan 086 adds the first positive control/);
  assert.match(releaseTransportAdr, /outcome=connected/);
  assert.match(releaseTransportAdr, /framesEchoed=1/);
  assert.match(releaseTransportAdr, /Plan 087 reran the release smoke/);
  assert.match(releaseTransportAdr, /Plan 087 proves the release-route\s+reverse tunnel/);
  assert.match(releaseTransportAdr, /server\s+webview stats after controls accepts=0 upgrades=0 framesEchoed=0/);
  assert.match(releaseTransportAdr, /shell UID/);
  assert.match(releaseTransportAdr, /release-shaped\s+cleartext diagnostic/);
  assert.match(releaseTransportAdr, /does not authorize blanket cleartext release defaults/);
  assert.match(releaseTransportAdr, /loopback-scoped Android network security config/);
  assert.match(releaseTransportAdr, /normal release app id/);
  assert.match(releaseTransportAdr, /non-loopback cleartext/);
  assert.match(releaseTransportAdr, /Android API 26\+/);
  assert.match(releaseTransportAdr, /does not distinguish Android network security cleartext\s+policy/);
  assert.match(releaseTransportAdr, /Decision/);
  assert.match(releaseTransportAdr, /does not authorize a release BEAM convergence claim/);
});
