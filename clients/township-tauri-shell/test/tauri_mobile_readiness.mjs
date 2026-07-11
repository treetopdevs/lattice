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
  const releaseRootOriginationProbeSource = readText(
    "clients/township-tauri-shell/src/township_release_root_origination_probe.ts",
  );
  const releasePairingProbeSource = readText("clients/township-tauri-shell/src/township_release_pairing_probe.ts");
  const releaseOnboardingProbeSource = readText("clients/township-tauri-shell/src/township_release_onboarding_probe.ts");
  const onboardingSource = readText("clients/township-tauri-shell/src/township_onboarding.ts");
  const nativeLib = readText("clients/township-tauri-shell/src-tauri/src/lib.rs");
  const canonicalProbeContract = readText("clients/township-tauri-shell/test/township_canonical_probe.ts");
  const releaseTransportProbeContract = readText("clients/township-tauri-shell/test/township_release_transport_probe.ts");
  const releaseBeamProbeContract = readText("clients/township-tauri-shell/test/township_release_beam_probe.ts");
  const releaseSyncProbeContract = readText("clients/township-tauri-shell/test/township_release_sync_probe.ts");
  const releaseAuthorProbeContract = readText("clients/township-tauri-shell/test/township_release_author_probe.ts");
  const releaseRootOriginationProbeContract = readText(
    "clients/township-tauri-shell/test/township_release_root_origination_probe.ts",
  );
  const releasePairingProbeContract = readText("clients/township-tauri-shell/test/township_release_pairing_probe.ts");
  const releaseOnboardingProbeContract = readText("clients/township-tauri-shell/test/township_release_onboarding_probe.ts");
  const onboardingContract = readText("clients/township-tauri-shell/test/township_onboarding.ts");
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
  const androidReleaseRootOriginationSmoke = readText(
    "clients/township-tauri-shell/test/tauri_android_release_root_origination_probe.ts",
  );
  const androidReleasePairingSmoke = readText("clients/township-tauri-shell/test/tauri_android_release_pairing_probe.ts");
  const androidReleaseOnboardingSmoke = readText("clients/township-tauri-shell/test/tauri_android_release_onboarding_probe.ts");
  const androidReleaseBrowserPairingSmoke = readText(
    "clients/township-tauri-shell/test/tauri_android_release_browser_pairing_probe.ts",
  );
  const androidReleaseBrowserOnboardingSmoke = readText(
    "clients/township-tauri-shell/test/tauri_android_release_browser_onboarding_probe.ts",
  );
  const androidReleaseBrowserOnboardingGrantSmoke = readText(
    "clients/township-tauri-shell/test/tauri_android_release_browser_onboarding_grant_probe.ts",
  );
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
  const plansIndex = readText("plans/README.md");
  const plan054 = readText("plans/054-tauri-onboarding-cap-persistence-e1.md");
  const plan055 = readText("plans/055-mobile-secure-store-strategy-e1.md");
  const plan056 = readText("plans/056-real-app-convergence-gate-e1.md");
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
  const plan094 = readText("plans/094-tauri-imported-pairing-confirmation-policy-e1.md");
  const plan095 = readText("plans/095-tauri-armed-deeplink-pairing-import-e1.md");
  const plan096 = readText("plans/096-tauri-installed-app-armed-deeplink-delivery-e1.md");
  const plan097 = readText("plans/097-tauri-pairing-link-no-side-effect-trace-guard-e1.md");
  const plan098 = readText("plans/098-tauri-macos-launchservices-warm-routing-e1.md");
  const plan099 = readText("plans/099-tauri-macos-coldstart-deeplink-delivery-e1.md");
  const plan100 = readText("plans/100-tauri-armed-pairing-state-binding-e1.md");
  const plan102 = readText("plans/102-tauri-release-app-originated-attenuated-grant-e1.md");
  const plan103 = readText("plans/103-tauri-android-release-armed-pairing-delivery-e1.md");
  const plan104 = readText("plans/104-tauri-android-release-convergence-gate-e1.md");
  const plan105 = readText("plans/105-tauri-android-release-cold-start-pairing-delivery-e1.md");
  const plan106 = readText("plans/106-tauri-android-release-single-apk-onboarding-convergence-e1.md");
  const plan107 = readText("plans/107-tauri-android-release-browser-backed-pairing-delivery-e1.md");
  const plan108 = readText("plans/108-tauri-android-release-browser-backed-onboarding-convergence-e1.md");
  const plan109 = readText("plans/109-tauri-android-release-browser-backed-onboarding-child-grant-e1.md");
  const plan110 = readText("plans/110-tauri-android-release-browser-backed-pairing-state-exchange-e1.md");
  const plan111 = readText("plans/111-tauri-android-release-browser-backed-onboarding-state-exchange-e1.md");
  const plan112 = readText("plans/112-tauri-android-release-browser-backed-onboarding-child-grant-state-exchange-e1.md");
  const plan113 = readText("plans/113-tauri-android-release-browser-onboarding-regression-gate-e1.md");
  const plan114 = readText("plans/114-tauri-android-release-chooser-onboarding-state-exchange-e1.md");
  const plan115 = readText("plans/115-township-bounded-authority-origination-c3.md");
  const plan116 = readText("plans/116-tauri-android-release-root-authority-origination-e1.md");
  const plan117 = readText("plans/117-tauri-android-release-visible-chooser-onboarding-e1.md");
  const plan118 = readText("plans/118-desktop-onboarding-convergence-e1.md");
  const plan119 = readText("plans/119-tauri-packaged-onboarding-convergence-e1.md");
  const plan120 = readText("plans/120-tauri-browser-onboarding-click-through-e1.md");
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
  assert.equal(pkg.scripts["release:root-origination:contract"], "tsx test/township_release_root_origination_probe.ts");
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
  assert.equal(
    pkg.scripts["tauri:android:release:root-origination:smoke"],
    "tsx test/tauri_android_release_root_origination_probe.ts",
  );
  assert.equal(pkg.scripts["tauri:android:release:pairing:smoke"], "tsx test/tauri_android_release_pairing_probe.ts");
  assert.equal(
    pkg.scripts["release:onboarding:contract"],
    "tsx test/township_release_onboarding_probe.ts",
  );
  assert.equal(pkg.scripts["onboarding:contract"], "tsx test/township_onboarding.ts");
  assert.equal(pkg.scripts["tauri:onboarding:smoke"], "tsx test/tauri_packaged_onboarding_smoke.ts");
  assert.equal(
    pkg.scripts["onboarding:click-through"],
    "VITE_TOWNSHIP_DEV_TRACE= VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT= npm run build && cd ../.. && npx --no-install playwright test tests/e2e/township_onboarding_click_through.spec.ts --config playwright.config.mjs",
  );
  assert.equal(
    pkg.scripts["app:convergence"],
    "npm run action:contract && npm run sync:contract && npm run onboarding:contract && npm run onboarding:click-through && npm run live:contract && npm run tauri:launch:smoke && npm run tauri:onboarding:smoke && npm run tauri:deep-link:smoke",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:onboarding:smoke"],
    "tsx test/tauri_android_release_onboarding_probe.ts",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:browser-pairing:smoke"],
    "tsx test/tauri_android_release_browser_pairing_probe.ts",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:browser-state-exchange:smoke"],
    "TOWNSHIP_RELEASE_PAIRING_BUILD_SCRIPT=tauri:android:build:release:pairing-state-probe tsx test/tauri_android_release_browser_pairing_probe.ts",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:browser-onboarding:smoke"],
    "tsx test/tauri_android_release_browser_onboarding_probe.ts",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:browser-onboarding-state-exchange:smoke"],
    "TOWNSHIP_RELEASE_ONBOARDING_BUILD_SCRIPT=tauri:android:build:release:onboarding-state-probe tsx test/tauri_android_release_browser_onboarding_probe.ts",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:browser-onboarding-grant:smoke"],
    "tsx test/tauri_android_release_browser_onboarding_grant_probe.ts",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:browser-onboarding-grant-state-exchange:smoke"],
    "TOWNSHIP_RELEASE_ONBOARDING_GRANT_BUILD_SCRIPT=tauri:android:build:release:onboarding-grant-state-probe tsx test/tauri_android_release_browser_onboarding_grant_probe.ts",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:convergence"],
    "npm run tauri:android:build:release:sync-probe && npm run tauri:android:release:sync:smoke && npm run tauri:android:build:release:author-probe && npm run tauri:android:release:author:smoke && npm run tauri:android:build:release:pairing-probe && npm run tauri:android:release:pairing:smoke",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:browser-pairing"],
    "npm run tauri:android:build:release:pairing-probe && npm run tauri:android:release:browser-pairing:smoke",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:browser-state-exchange"],
    "npm run tauri:android:build:release:pairing-state-probe && npm run tauri:android:release:browser-state-exchange:smoke",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:browser-onboarding"],
    "npm run tauri:android:build:release:onboarding-probe && npm run tauri:android:release:browser-onboarding:smoke",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:browser-onboarding-state-exchange"],
    "npm run tauri:android:build:release:onboarding-state-probe && npm run tauri:android:release:browser-onboarding-state-exchange:smoke",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:chooser-onboarding-state-exchange:smoke"],
    "TOWNSHIP_RELEASE_ONBOARDING_BUILD_SCRIPT=tauri:android:build:release:onboarding-state-probe TOWNSHIP_ANDROID_BROWSER_INTENT_MODE=chooser tsx test/tauri_android_release_browser_onboarding_probe.ts",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:chooser-onboarding-state-exchange"],
    "npm run tauri:android:build:release:onboarding-state-probe && npm run tauri:android:release:chooser-onboarding-state-exchange:smoke",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:chooser-visible-onboarding:smoke"],
    "TOWNSHIP_RELEASE_ONBOARDING_BUILD_SCRIPT=tauri:android:build:release:onboarding-state-probe TOWNSHIP_ANDROID_BROWSER_INTENT_MODE=chooser-visible TOWNSHIP_ANDROID_CHOOSER_COMPETITOR_APK=src-tauri/target/app-universal-release-cleartextdiag.apk tsx test/tauri_android_release_browser_onboarding_probe.ts",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:chooser-visible-onboarding"],
    "npm run tauri:android:build:release:chooser-competitor && npm run tauri:android:build:release:onboarding-state-probe && npm run tauri:android:release:chooser-visible-onboarding:smoke",
  );
  assert.equal(
    pkg.scripts["tauri:android:build:release:chooser-competitor"],
    "TOWNSHIP_ANDROID_RELEASE_CLEAR_TEXT_DIAGNOSTIC=1 PATH=/opt/homebrew/opt/rustup/bin:$PATH tauri android build --apk --ci && mkdir -p src-tauri/target && cp src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk src-tauri/target/app-universal-release-cleartextdiag.apk",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:browser-onboarding-grant"],
    "npm run tauri:android:build:release:onboarding-grant-probe && npm run tauri:android:release:browser-onboarding-grant:smoke",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:browser-onboarding-grant-state-exchange"],
    "npm run tauri:android:build:release:onboarding-grant-state-probe && npm run tauri:android:release:browser-onboarding-grant-state-exchange:smoke",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:browser-onboarding-regression"],
    "npm run tauri:android:release:browser-pairing && npm run tauri:android:release:browser-state-exchange && npm run tauri:android:release:browser-onboarding && npm run tauri:android:release:browser-onboarding-state-exchange && npm run tauri:android:release:browser-onboarding-grant && npm run tauri:android:release:browser-onboarding-grant-state-exchange",
  );
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
    /VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_GRANT_AUDIENCE_PUBKEY=QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:author-probe"],
    /VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_TIMEOUT_MS=12000/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:root-origination-probe"],
    /VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_URL=ws:\/\/127\.0\.0\.1:43199\/carrier/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:root-origination-probe"],
    /VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOCAL_REALM=founder/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:root-origination-probe"],
    /VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_STORAGE_NAMESPACE=township:release-root-origination-probe/,
  );
  assert.doesNotMatch(
    pkg.scripts["tauri:android:build:release:root-origination-probe"],
    /VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_GRANT_AUDIENCE_PUBKEY/,
    "release root origination must not use a host-minted bootstrap cap",
  );
  assert.equal(
    pkg.scripts["tauri:android:release:root-origination"],
    "npm run tauri:android:build:release:root-origination-probe && npm run tauri:android:release:root-origination:smoke",
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
    pkg.scripts["tauri:android:build:release:pairing-state-probe"],
    /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_KEY_ID=township-release-pairing-state-resident/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:pairing-state-probe"],
    /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_STORAGE_NAMESPACE=township:release-pairing-state-probe/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:pairing-state-probe"],
    /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_STATE_EXCHANGE_URL=http:\/\/127\.0\.0\.1:43196\/pairing-state/,
  );
  assert.doesNotMatch(
    pkg.scripts["tauri:android:build:release:pairing-state-probe"],
    /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_ARM_STATE=/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:onboarding-probe"],
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STORAGE_NAMESPACE=township:release-onboarding-probe/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:onboarding-probe"],
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_ARM_STATE=release-onboarding-state-106/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:onboarding-probe"],
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_TIMEOUT_MS=120000/,
  );
  assert.doesNotMatch(
    pkg.scripts["tauri:android:build:release:onboarding-probe"],
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_(?:URL|PEER_REALM|PEER_PUBKEY|REPLICA)=/,
    "single-APK onboarding probe must receive peer config from the OS-delivered pairing handoff",
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:onboarding-state-probe"],
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STORAGE_NAMESPACE=township:release-onboarding-state-probe/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:onboarding-state-probe"],
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STATE_EXCHANGE_URL=http:\/\/127\.0\.0\.1:43197\/pairing-state/,
  );
  assert.doesNotMatch(
    pkg.scripts["tauri:android:build:release:onboarding-state-probe"],
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_ARM_STATE=/,
  );
  assert.doesNotMatch(
    pkg.scripts["tauri:android:build:release:onboarding-state-probe"],
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_(?:URL|PEER_REALM|PEER_PUBKEY|REPLICA)=/,
    "browser-backed runtime-state onboarding probe must receive peer config from the browser-delivered pairing handoff",
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:onboarding-grant-probe"],
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STORAGE_NAMESPACE=township:release-onboarding-grant-probe/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:onboarding-grant-probe"],
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_ARM_STATE=release-onboarding-grant-state-109/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:onboarding-grant-probe"],
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_GRANT_AUDIENCE_PUBKEY=QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:onboarding-grant-state-probe"],
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STORAGE_NAMESPACE=township:release-onboarding-grant-state-probe/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:onboarding-grant-state-probe"],
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STATE_EXCHANGE_URL=http:\/\/127\.0\.0\.1:43198\/pairing-state/,
  );
  assert.doesNotMatch(
    pkg.scripts["tauri:android:build:release:onboarding-grant-state-probe"],
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_ARM_STATE=/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:onboarding-grant-state-probe"],
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_GRANT_AUDIENCE_PUBKEY=QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=/,
  );
  assert.doesNotMatch(
    pkg.scripts["tauri:android:build:release:onboarding-grant-state-probe"],
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_(?:URL|PEER_REALM|PEER_PUBKEY|REPLICA)=/,
    "browser-backed onboarding child-grant runtime-state probe must receive peer config from the browser-delivered pairing handoff",
  );
  assert.doesNotMatch(
    pkg.scripts["tauri:android:build:release:onboarding-grant-probe"],
    /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_(?:URL|PEER_REALM|PEER_PUBKEY|REPLICA)=/,
    "browser-backed onboarding child-grant probe must receive peer config from the browser-delivered pairing handoff",
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:pairing-probe"],
    /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_ARM_STATE=release-pairing-state-103/,
  );
  assert.match(
    pkg.scripts["tauri:android:build:release:pairing-probe"],
    /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_TIMEOUT_MS=120000/,
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
  const androidIntentStoreInstrumentedTest = readText(
    "clients/township-tauri-shell/src-tauri/gen/android/app/src/androidTest/java/dev/treetop/lattice/township/intent/TownshipIntentStoreTest.kt",
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
  assert.match(androidGradle, /testInstrumentationRunner = "androidx\.test\.runner\.AndroidJUnitRunner"/);
  assert.match(androidGradle, /androidTestImplementation\("androidx\.test:runner:1\.5\.2"\)/);
  assert.match(androidGradle, /rootDirRel = "\.\.\/\.\.\/\.\.\/"/);
  assert.match(androidGradle, /providers\.environmentVariable\("TOWNSHIP_ANDROID_RELEASE_CLEAR_TEXT_DIAGNOSTIC"\)/);
  assert.doesNotMatch(androidGradle, /System\.getenv\("TOWNSHIP_ANDROID_RELEASE_CLEAR_TEXT_DIAGNOSTIC"\)/);
  assert.match(androidGradle, /manifestPlaceholders\["usesCleartextTraffic"\] = "false"/);
  assert.match(androidGradle, /manifestPlaceholders\["appLabel"\] = "Township"/);
  assert.match(androidGradle, /manifestPlaceholders\["mainActivityLabel"\] = "Township"/);
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
  assert.match(androidReleaseBuildType, /manifestPlaceholders\["appLabel"\] = "Township Diagnostic"/);
  assert.match(androidReleaseBuildType, /manifestPlaceholders\["mainActivityLabel"\] = "Township Diagnostic"/);
  assert.match(androidReleaseBuildType, /manifestPlaceholders\["usesCleartextTraffic"\] = "true"/);
  assert.match(androidDebugBuildType, /manifestPlaceholders\["usesCleartextTraffic"\] = "true"/);
  assert.match(
    androidDebugBuildType,
    /manifestPlaceholders\["networkSecurityConfig"\] = "@xml\/township_debug_network_security_config"/,
  );
  assert.match(androidManifest, /android:name="\.MainActivity"/);
  assert.match(androidManifest, /android:allowBackup="false"/);
  assert.match(androidManifest, /android:label="\$\{appLabel\}"/);
  assert.match(androidManifest, /android:label="\$\{mainActivityLabel\}"/);
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
    /override fun onNewIntent\(intent: Intent\) \{\s+TownshipIntentStore\.record\(intent, "activity_on_new_intent"\)[\s\S]+setIntent\(intent\)[\s\S]+super\.onNewIntent\(intent\)/,
  );
  assert.match(androidMainActivity, /System\.loadLibrary\("township_tauri_shell"\)/);
  assert.match(androidMainActivity, /Keyring\.initializeNdkContext\(applicationContext\)/);
  assert.match(androidIntentPlugin, /object TownshipIntentStore/);
  assert.match(androidIntentPlugin, /LOG_PREFIX = "township-android-intent-store"/);
  assert.match(androidIntentPlugin, /fun record\(intent: Intent\?, source: String = "plugin"\)/);
  assert.match(androidIntentPlugin, /routeShape\(intent\?\.data\)/);
  assert.match(androidIntentPlugin, /intent\.data\?\.scheme == "township"/);
  assert.match(androidIntentPlugin, /val rawUrl = intent\?\.data\?\.toString\(\)/);
  assert.match(androidIntentPlugin, /hasBrowsableCategory\(intent\)/);
  assert.match(androidIntentPlugin, /MAX_PAIRING_INTENT_URL_LENGTH/);
  assert.match(androidIntentPlugin, /fun peek\(\): String\?/);
  assert.match(androidIntentPlugin, /has_current=\$\{currentUrl != null\}/);
  assert.match(androidIntentPlugin, /private fun routeShape\(uri: Uri\?\): String/);
  assert.match(androidIntentPlugin, /pairing_payload/);
  assert.match(androidIntentPlugin, /Base64\.encodeToString/);
  assert.match(androidIntentPlugin, /ret\.put\(\s+"handoffB64"/);
  assert.doesNotMatch(androidIntentPlugin, /"urlB64"|"intentB64"/);
  assert.match(androidIntentPlugin, /val handoff = TownshipIntentStore\.consumePairingHandoff\(\)/);
  assert.match(androidIntentPlugin, /val rawUrl = peek\(\)/);
  assert.match(androidIntentPlugin, /fun consumePairingHandoff\(\): String\?/);
  assert.match(androidIntentPlugin, /if \(handoff != null\) currentUrl = null/);
  assert.match(androidIntentPlugin, /getQueryParameter\("handoff"\)/);
  assert.match(androidIntentPlugin, /private fun isPairingRoute\(uri: Uri, path: String\)/);
  assert.match(androidIntentPlugin, /if \(!isPairingRoute\(uri, path\)\) return null/);
  assert.match(androidIntentPlugin, /uri\.port != -1 -> false/);
  assert.match(androidIntentPlugin, /uri\.host\.isNullOrEmpty\(\)/);
  assert.match(androidIntentPlugin, /currentUrl = TownshipIntentStore\.peek\(\)/);
  assert.match(androidIntentStoreInstrumentedTest, /consumesPairingHandoffOnce/);
  assert.match(androidIntentStoreInstrumentedTest, /rejectsForeignHostsBeforeReturningHandoff/);
  assert.match(androidIntentStoreInstrumentedTest, /township:\/\/pairing@evil\.example\/nohost/);
  assert.match(androidIntentStoreInstrumentedTest, /township:\/\/pairing:80\/nohost/);
  assert.match(androidIntentStoreInstrumentedTest, /township:\/\/PAIRING/);
  assert.match(androidIntentStoreInstrumentedTest, /rejectsNonBrowsableOrNonViewIntents/);
  assert.match(androidIntentStoreInstrumentedTest, /rejectsOversizedIntentUrls/);
  assert.match(nativeLib, /struct CurrentPairingHandoffResponse[\s\S]+handoff_b64: Option<String>/);
  assert.match(nativeLib, /fn lattice_android_current_pairing_handoff_b64/);
  assert.doesNotMatch(nativeLib, /decode_url_b64/);
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
  assert.match(releaseAuthorProbeSource, /VITE_TOWNSHIP_RELEASE_AUTHOR_PROBE_GRANT_AUDIENCE_PUBKEY/);
  assert.match(releaseAuthorProbeSource, /createTownshipNativeWorkflow/);
  assert.match(releaseAuthorProbeSource, /townshipReleaseAuthorReloadResult/);
  assert.match(releaseAuthorProbeSource, /submitTownshipDelegation/);
  assert.match(releaseAuthorProbeSource, /ops: \["post"\]/);
  assert.match(releaseAuthorProbeSource, /phase=grant/);
  assert.match(releaseAuthorProbeSource, /grant_ops/);
  assert.match(releaseAuthorProbeSource, /submitTownshipPost/);
  assert.match(releaseAuthorProbeSource, /authorTownshipCommand/);
  assert.match(releaseAuthorProbeSource, /syncTownshipOutbox/);
  assert.match(releaseAuthorProbeSource, /connectTownshipCarrierPeer/);
  assert.match(releaseAuthorProbeSource, /post_materialized/);
  assert.match(releaseAuthorProbeSource, /bad_authority_reason/);
  assert.match(releaseAuthorProbeSource, /grant_authority_accepted/);
  assert.match(releaseAuthorProbeSource, /operation_not_granted/);
  assert.match(releaseAuthorProbeSource, /townshipReleaseTransportProbeHostClass\(value\) === "loopback"/);
  assert.doesNotMatch(
    releaseAuthorProbeSource,
    /connectToAppWebView|webview_devtools_remote|clickButtonByText|kvJson|run-as|body:|sig:|cap:/,
  );
  assert.match(
    releaseRootOriginationProbeSource,
    /TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOG_PREFIX = "township-release-root-origination-probe"/,
  );
  assert.match(
    releaseRootOriginationProbeSource,
    /TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_STORAGE_NAMESPACE = "township:release-root-origination-probe"/,
  );
  assert.match(releaseRootOriginationProbeSource, /VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_URL/);
  assert.match(releaseRootOriginationProbeSource, /VITE_TOWNSHIP_RELEASE_ROOT_ORIGINATION_PROBE_LOCAL_REALM/);
  assert.match(releaseRootOriginationProbeSource, /createTownshipNativeWorkflow/);
  assert.match(releaseRootOriginationProbeSource, /bindTownshipReplica/);
  assert.match(releaseRootOriginationProbeSource, /authorTownshipGenesis/);
  assert.match(releaseRootOriginationProbeSource, /phase=genesis/);
  assert.match(releaseRootOriginationProbeSource, /root_replica=/);
  assert.match(releaseRootOriginationProbeSource, /outbox_frame_count=1/);
  assert.match(releaseRootOriginationProbeSource, /syncTownshipOutbox/);
  assert.match(releaseRootOriginationProbeSource, /connectTownshipCarrierPeer/);
  assert.match(releaseRootOriginationProbeSource, /root_authority_accepted=true/);
  assert.match(releaseRootOriginationProbeSource, /forged_authority_reason=impostor_genesis/);
  assert.doesNotMatch(
    releaseRootOriginationProbeSource,
    /GRANT_AUDIENCE|bootstrapAudiencePubkey|grant_delegation_id/,
    "release root origination must not depend on pulled or host-minted grants",
  );
  assert.match(releasePairingProbeSource, /TOWNSHIP_RELEASE_PAIRING_PROBE_LOG_PREFIX = "township-release-pairing-probe"/);
  assert.match(releasePairingProbeSource, /TOWNSHIP_RELEASE_PAIRING_PROBE_STORAGE_NAMESPACE = "township:release-pairing-probe"/);
  assert.match(releasePairingProbeSource, /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_LOCAL_REALM/);
  assert.match(releasePairingProbeSource, /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_KEY_ID/);
  assert.match(releasePairingProbeSource, /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_STORAGE_NAMESPACE/);
  assert.match(releasePairingProbeSource, /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_URL/);
  assert.match(releasePairingProbeSource, /createTownshipPairingDeepLinkListener/);
  assert.match(releasePairingProbeSource, /createOneShotTownshipPairingDeepLinkGate/);
  assert.match(releasePairingProbeSource, /createTauriPairingDeepLinkSource/);
  assert.match(releasePairingProbeSource, /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_ARM_STATE/);
  assert.match(releasePairingProbeSource, /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_STATE_EXCHANGE_URL/);
  assert.match(releasePairingProbeSource, /stateExchangeUrl/);
  assert.match(releasePairingProbeSource, /publishPairingState/);
  assert.match(releasePairingProbeSource, /publishReleasePairingState/);
  assert.match(releasePairingProbeSource, /validStateExchangeUrl/);
  assert.match(releasePairingProbeSource, /createOneShotTownshipPairingDeepLinkGate\(\)/);
  assert.match(releasePairingProbeSource, /phase: "arming";\s+outcome: "armed";\s+stateRequired: boolean;/);
  assert.match(releasePairingProbeSource, /blockedReason\?: TownshipPairingDeepLinkBlockedReason/);
  assert.match(releasePairingProbeSource, /phase=arming/);
  assert.match(releasePairingProbeSource, /blocked_reason=/);
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
  assert.match(releaseOnboardingProbeSource, /TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOG_PREFIX = "township-release-onboarding-probe"/);
  assert.match(releaseOnboardingProbeSource, /TOWNSHIP_RELEASE_ONBOARDING_PROBE_STORAGE_NAMESPACE = "township:release-onboarding-probe"/);
  assert.match(releaseOnboardingProbeSource, /townshipReleaseOnboardingProbeConfigFromEnv/);
  assert.match(releaseOnboardingProbeSource, /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_ARM_STATE/);
  assert.match(releaseOnboardingProbeSource, /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STATE_EXCHANGE_URL/);
  assert.match(releaseOnboardingProbeSource, /stateExchangeUrl/);
  assert.match(releaseOnboardingProbeSource, /validStateExchangeUrl/);
  assert.match(releaseOnboardingProbeSource, /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_POST_TEXT/);
  assert.match(releaseOnboardingProbeSource, /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_GRANT_AUDIENCE_PUBKEY/);
  assert.match(releaseOnboardingProbeSource, /grantAudiencePubkey/);
  assert.match(releaseOnboardingProbeSource, /forbiddenPeerEnvPresent/);
  assert.match(releaseOnboardingProbeSource, /createTownshipNativeWorkflow/);
  assert.match(releaseOnboardingProbeSource, /probeTownshipReleasePairing/);
  assert.match(releaseOnboardingProbeSource, /loadTownshipCarrierPeerConfig/);
  assert.match(releaseOnboardingProbeSource, /probeTownshipReleaseAuthor/);
  assert.match(releaseOnboardingProbeSource, /pairingReload\.peer && pairingReload\.carrierFrameCount > 0/);
  assert.match(releaseOnboardingProbeSource, /townshipReleaseOnboardingProbeLogLine/);
  assert.doesNotMatch(releaseOnboardingProbeSource, /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_(?:URL|PEER_REALM|PEER_PUBKEY|REPLICA)/);
  assert.match(appVue, /isAndroidTauriShell/);
  assert.match(appVue, /logTownshipCanonicalProbe\(\)/);
  assert.match(appVue, /logTownshipReleaseBeamProbeFromEnv/);
  assert.match(appVue, /logTownshipReleaseSyncProbeFromEnv/);
  assert.match(appVue, /logTownshipReleaseAuthorProbeFromEnv/);
  assert.match(appVue, /logTownshipReleaseRootOriginationProbeFromEnv/);
  assert.match(appVue, /logTownshipReleasePairingProbeFromEnv/);
  assert.match(appVue, /logTownshipReleaseOnboardingProbeFromEnv/);
  assert.match(appVue, /logTownshipReleaseTransportProbesFromEnv/);
  assert.match(appVue, /townshipReleaseOnboardingProbeConfigFromEnv/);
  assert.match(appVue, /if \(releaseOnboardingProbeActive\) \{\s+void logTownshipReleaseOnboardingProbeFromEnv\(\)\.catch\(\(\) => \{\}\);\s+\} else \{/);
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
  assert.match(releaseRootOriginationProbeContract, /ws:\/\/10\.0\.2\.2:43199\/carrier/);
  assert.match(releaseRootOriginationProbeContract, /wss:\/\/example\.com\/carrier/);
  assert.match(releaseRootOriginationProbeContract, /phase=reload/);
  assert.match(releaseRootOriginationProbeContract, /phase=genesis/);
  assert.match(releaseRootOriginationProbeContract, /phase=push/);
  assert.match(releaseRootOriginationProbeContract, /phase=peer/);
  assert.match(releaseRootOriginationProbeContract, /root_authority_accepted=true/);
  assert.match(releaseRootOriginationProbeContract, /forged_authority_reason=impostor_genesis/);
  assert.match(releasePairingProbeContract, /township:\/\/pairing\?handoff=/);
  assert.match(releasePairingProbeContract, /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_URL/);
  assert.match(releasePairingProbeContract, /phase=native_key/);
  assert.match(releasePairingProbeContract, /paired=false/);
  assert.match(releasePairingProbeContract, /phase=pairing/);
  assert.match(releasePairingProbeContract, /phase=arming/);
  assert.match(releasePairingProbeContract, /blocked_reason=state_mismatch/);
  assert.match(releasePairingProbeContract, /release-pairing-state-103/);
  assert.match(releasePairingProbeContract, /STATE_EXCHANGE_URL/);
  assert.match(releasePairingProbeContract, /stateExchangeUrl: "http:\/\/127\.0\.0\.1:43196\/pairing-state"/);
  assert.match(releasePairingProbeContract, /runtime state exchange must not share a build-time arm-state constant/);
  assert.match(releasePairingProbeContract, /runtime state exchange must reject non-loopback cleartext callback URLs/);
  assert.match(releasePairingProbeContract, /publishPairingState/);
  assert.match(releasePairingProbeContract, /\^\[0-9a-f\]\{32\}\$/);
  assert.match(releasePairingProbeContract, /delayedCurrentCalls >= 3/);
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
  assert.match(androidReleaseAuthorSmoke, /phase=grant/);
  assert.match(androidReleaseAuthorSmoke, /grant_ops/);
  assert.match(androidReleaseAuthorSmoke, /phase=author/);
  assert.match(androidReleaseAuthorSmoke, /phase=push/);
  assert.match(androidReleaseAuthorSmoke, /phase=peer/);
  assert.match(androidReleaseAuthorSmoke, /phase=reload/);
  assert.match(androidReleaseAuthorSmoke, /post_materialized=true/);
  assert.match(androidReleaseAuthorSmoke, /bad_authority_reason=operation_not_granted/);
  assert.match(androidReleaseAuthorSmoke, /grant_authority_accepted=true/);
  assert.match(androidReleaseAuthorSmoke, /outbox_frame_count=3/);
  assert.match(androidReleaseAuthorSmoke, /outbox_frame_count=0/);
  assert.match(androidReleaseAuthorSmoke, /Package \\\\?\[/);
  assert.match(androidReleaseAuthorSmoke, /version\(\?:Code\|Name\)=/);
  assert.doesNotMatch(
    androidReleaseAuthorSmoke,
    /connectToAppWebView|webview_devtools_remote|clickButtonByText|kvJson|run-as/,
  );
  assert.match(androidReleaseRootOriginationSmoke, /tauri:android:release:root-origination:smoke/);
  assert.match(androidReleaseRootOriginationSmoke, /app-universal-release\.apk/);
  assert.match(androidReleaseRootOriginationSmoke, /assertApkUsesCleartextTraffic\(apkPath, false/);
  assert.match(androidReleaseRootOriginationSmoke, /phase=native_key/);
  assert.match(androidReleaseRootOriginationSmoke, /phase=genesis/);
  assert.match(androidReleaseRootOriginationSmoke, /root_replica=/);
  assert.match(androidReleaseRootOriginationSmoke, /outbox_frame_count=1/);
  assert.match(androidReleaseRootOriginationSmoke, /phase=reload/);
  assert.match(androidReleaseRootOriginationSmoke, /phase=push/);
  assert.match(androidReleaseRootOriginationSmoke, /outbox_frame_count=0/);
  assert.match(androidReleaseRootOriginationSmoke, /phase=peer/);
  assert.match(androidReleaseRootOriginationSmoke, /root_authority_accepted=true/);
  assert.match(androidReleaseRootOriginationSmoke, /forged_authority_reason=impostor_genesis/);
  assert.doesNotMatch(
    androidReleaseRootOriginationSmoke,
    /bootstrapAudiencePubkey|grant_delegation_id|webview_devtools_remote/,
    "release root origination smoke must not use host-minted grants or WebView CDP",
  );
  assert.match(androidReleasePairingSmoke, /tauri:android:release:pairing:smoke/);
  assert.match(androidReleasePairingSmoke, /app-universal-release\.apk/);
  assert.match(androidReleasePairingSmoke, /assertApkUsesCleartextTraffic\(apkPath, false/);
  assert.match(androidReleasePairingSmoke, /assertApkNetworkSecurityConfig/);
  assert.match(androidReleasePairingSmoke, /android\.intent\.action\.VIEW/);
  assert.match(androidReleasePairingSmoke, /android\.intent\.category\.BROWSABLE/);
  assert.match(androidReleasePairingSmoke, /township:\/\/pairing/);
  assert.match(androidReleasePairingSmoke, /appActivity/);
  assert.match(androidReleasePairingSmoke, /release-pairing-state-103/);
  assert.match(androidReleasePairingSmoke, /phase=arming/);
  assert.match(androidReleasePairingSmoke, /blocked_reason=state_mismatch/);
  assert.match(androidReleasePairingSmoke, /assertNoPairingSavedYet/);
  assert.match(androidReleasePairingSmoke, /phase=pairing/);
  assert.match(androidReleasePairingSmoke, /paired=false/);
  assert.match(androidReleasePairingSmoke, /paired=true/);
  assert.match(androidReleasePairingSmoke, /phase=sync/);
  assert.match(androidReleasePairingSmoke, /runReleaseColdStartPairingDeliveryProof/);
  assert.match(androidReleasePairingSmoke, /waitForAppNotRunning/);
  assert.match(androidReleasePairingSmoke, /pidof/);
  assert.match(androidReleasePairingSmoke, /cold-start no-state release pairing/);
  assert.match(androidReleasePairingSmoke, /cold-start state-bearing release pairing/);
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
  assert.match(releaseOnboardingProbeSource, /TOWNSHIP_RELEASE_ONBOARDING_PROBE_LOG_PREFIX = "township-release-onboarding-probe"/);
  assert.match(releaseOnboardingProbeSource, /TOWNSHIP_RELEASE_ONBOARDING_PROBE_STORAGE_NAMESPACE = "township:release-onboarding-probe"/);
  assert.match(releaseOnboardingProbeSource, /townshipReleaseOnboardingProbeConfigFromEnv/);
  assert.match(releaseOnboardingProbeSource, /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_ARM_STATE/);
  assert.match(releaseOnboardingProbeSource, /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_POST_TEXT/);
  assert.match(releaseOnboardingProbeSource, /forbiddenPeerEnvPresent/);
  assert.match(releaseOnboardingProbeSource, /createTownshipNativeWorkflow/);
  assert.match(releaseOnboardingProbeSource, /probeTownshipReleasePairing/);
  assert.match(releaseOnboardingProbeSource, /loadTownshipCarrierPeerConfig/);
  assert.match(releaseOnboardingProbeSource, /probeTownshipReleaseAuthor/);
  assert.match(releaseOnboardingProbeSource, /townshipReleaseOnboardingProbeLogLine/);
  assert.doesNotMatch(releaseOnboardingProbeSource, /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_(?:URL|PEER_REALM|PEER_PUBKEY|REPLICA)/);
  assert.match(releaseOnboardingProbeContract, /release-onboarding-state-106/);
  assert.match(releaseOnboardingProbeContract, /http:\/\/127\.0\.0\.1:43197\/pairing-state/);
  assert.match(releaseOnboardingProbeContract, /runtime state exchange must not share a build-time arm-state constant/);
  assert.match(releaseOnboardingProbeContract, /runtime state exchange must reject non-loopback cleartext callback URLs/);
  assert.match(releaseOnboardingProbeContract, /township:release-onboarding-state-probe/);
  assert.match(releaseOnboardingProbeContract, /township:release-onboarding-probe/);
  assert.match(releaseOnboardingProbeContract, /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_GRANT_AUDIENCE_PUBKEY/);
  assert.match(releaseOnboardingProbeContract, /township-release-author-probe phase=grant outcome=authored/);
  assert.match(releaseOnboardingProbeContract, /forbidden peer env/);
  assert.match(onboardingSource, /export async function onboardTownshipDesktop/);
  assert.match(onboardingSource, /importTownshipCarrierPairingHandoff/);
  assert.match(onboardingSource, /saveTownshipCarrierPeerConfig/);
  assert.match(onboardingSource, /syncTownshipOutbox/);
  assert.match(onboardingSource, /submitTownshipPost/);
  assert.match(onboardingSource, /TOWNSHIP_LOCAL_OP_LOG_KEY/);
  assert.match(onboardingSource, /TOWNSHIP_CARRIER_OUTBOX_KEY/);
  assert.match(onboardingSource, /TOWNSHIP_DELEGATION_FRAMES_KEY/);
  assert.match(onboardingContract, /township_carrier_w1\.json/);
  assert.match(onboardingContract, /exportTownshipCarrierPairingHandoff/);
  assert.match(onboardingContract, /TOWNSHIP_STORAGE_NAMESPACE/);
  assert.match(onboardingContract, /TOWNSHIP_CARRIER_PAIRING_KEY/);
  assert.match(onboardingContract, /resident: posted while offline/);
  assert.match(onboardingContract, /initialSync\.pulledFrameCount/);
  assert.match(onboardingContract, /finalSync\.pushedFrameIds/);
  assert.match(onboardingContract, /pendingOutboxIds/);
  assert.match(onboardingContract, /assertTownshipKvStoresNoSecrets/);
  assert.match(onboardingContract, /commandCount\(calls, "lattice_ensure_carrier_key"\)/);
  assert.match(androidReleaseOnboardingSmoke, /tauri:android:release:onboarding:smoke/);
  assert.match(androidReleaseOnboardingSmoke, /app-universal-release\.apk/);
  assert.match(androidReleaseOnboardingSmoke, /assertApkUsesCleartextTraffic\(apkPath, false/);
  assert.match(androidReleaseOnboardingSmoke, /assertApkNetworkSecurityConfig/);
  assert.match(androidReleaseOnboardingSmoke, /release-onboarding-state-106/);
  assert.match(androidReleaseOnboardingSmoke, /township:\/\/pairing/);
  assert.match(androidReleaseOnboardingSmoke, /phase=pairing/);
  assert.match(androidReleaseOnboardingSmoke, /phase=sync/);
  assert.match(androidReleaseOnboardingSmoke, /phase=pull/);
  assert.match(androidReleaseOnboardingSmoke, /phase=author/);
  assert.match(androidReleaseOnboardingSmoke, /pre-push relaunch should retain the post op/);
  assert.match(androidReleaseOnboardingSmoke, /pre-push relaunch should retain the rejected op/);
  assert.match(androidReleaseOnboardingSmoke, /phase=push/);
  assert.match(androidReleaseOnboardingSmoke, /phase=peer/);
  assert.match(androidReleaseOnboardingSmoke, /observed onboarding final peer report/);
  assert.match(androidReleaseOnboardingSmoke, /township-release-author-probe phase=author outcome=authored/);
  assert.match(androidReleaseOnboardingSmoke, /post_materialized=true/);
  assert.match(androidReleaseOnboardingSmoke, /bad_authority_reason=operation_not_granted/);
  assert.match(androidReleaseOnboardingSmoke, /outbox_frame_count=0/);
  assert.match(androidReleaseOnboardingSmoke, /spawnTownshipPeer/);
  assert.match(androidReleaseOnboardingSmoke, /bootstrapAudiencePubkey: devicePublicKeyBase64/);
  assert.match(androidReleaseOnboardingSmoke, /reverse", `tcp:\$\{buildConfig\.port\}`, `tcp:\$\{peer\.port\}`/);
  assert.doesNotMatch(
    androidReleaseOnboardingSmoke,
    /connectToAppWebView|webview_devtools_remote|clickButtonByText|kvJson|run-as/,
  );
  assert.match(androidReleaseBrowserPairingSmoke, /tauri:android:release:browser-pairing:smoke/);
  assert.match(androidReleaseBrowserPairingSmoke, /browser-backed release pairing delivery/);
  assert.match(androidReleaseBrowserPairingSmoke, /app-universal-release\.apk/);
  assert.match(androidReleaseBrowserPairingSmoke, /createServer/);
  assert.match(androidReleaseBrowserPairingSmoke, /data-township-href="township:\/\/pairing/);
  assert.match(androidReleaseBrowserPairingSmoke, /Intent;scheme=township;package=\$\{appId\};component=\$\{appActivity\};end/);
  assert.match(androidReleaseBrowserPairingSmoke, /"input", "tap"/);
  assert.match(androidReleaseBrowserPairingSmoke, /resolveBrowserPackage/);
  assert.match(androidReleaseBrowserPairingSmoke, /"cmd", "package", "resolve-activity"/);
  assert.match(androidReleaseBrowserPairingSmoke, /phase=pairing/);
  assert.match(androidReleaseBrowserPairingSmoke, /phase=sync/);
  assert.match(androidReleaseBrowserPairingSmoke, /blocked_reason=state_mismatch/);
  assert.match(androidReleaseBrowserPairingSmoke, /assertNoPairingSavedYet/);
  assert.match(androidReleaseBrowserPairingSmoke, /TOWNSHIP_RELEASE_PAIRING_BUILD_SCRIPT/);
  assert.match(androidReleaseBrowserPairingSmoke, /startPairingStateExchangeServer/);
  assert.match(androidReleaseBrowserPairingSmoke, /stateExchangeUrl/);
  assert.match(androidReleaseBrowserPairingSmoke, /waitForState/);
  assert.match(androidReleaseBrowserPairingSmoke, /assertLogcatDoesNotContain/);
  assert.match(androidReleaseBrowserPairingSmoke, /runtime pairing state must not be emitted to probe logs/);
  assert.match(androidReleaseBrowserPairingSmoke, /spawnTownshipPeer/);
  assert.match(androidReleaseBrowserPairingSmoke, /bootstrapAudiencePubkey: devicePublicKeyBase64/);
  assert.match(androidReleaseBrowserPairingSmoke, /reverse", `tcp:\$\{buildConfig\.port\}`, `tcp:\$\{peer\.port\}`/);
  assert.doesNotMatch(
    androidReleaseBrowserPairingSmoke,
    /connectToAppWebView|webview_devtools_remote|clickButtonByText|kvJson|run-as/,
  );
  assert.match(androidReleaseBrowserOnboardingSmoke, /tauri:android:release:browser-onboarding:smoke/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /browser-backed release onboarding convergence/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /app-universal-release\.apk/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /createServer/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /data-township-href="township:\/\/pairing/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /Intent;scheme=township;package=\$\{appId\};component=\$\{appActivity\};end/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /TOWNSHIP_ANDROID_BROWSER_INTENT_MODE/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /Intent;scheme=township;end/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /assertUnpinnedTownshipPairingIntentResolves/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /settleTownshipIntentChooser/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /"chooser-visible"/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /TOWNSHIP_ANDROID_CHOOSER_COMPETITOR_APK/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /Township Diagnostic/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /waitForTownshipChooserHierarchy/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /uiautomator/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /assertApkPackage\(apkPath, chooserCompetitorAppId\)/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /"input", "tap"/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /resolveBrowserPackage/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /"cmd", "package", "resolve-activity"/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /assertBrowserPagePrecededPairingSave/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /phase=pairing/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /blocked_reason=state_mismatch/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /assertNoPairingSavedYet/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /TOWNSHIP_RELEASE_ONBOARDING_BUILD_SCRIPT/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /startPairingStateExchangeServer/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /stateExchangeUrl/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /waitForState/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /assertLogcatDoesNotContain/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /runtime onboarding state must not be emitted to probe logs/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /phase=complete/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /post_materialized=true/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /bad_authority_reason=operation_not_granted/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /outbox_frame_count=0/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /spawnTownshipPeer/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /bootstrapAudiencePubkey: devicePublicKeyBase64/);
  assert.match(androidReleaseBrowserOnboardingSmoke, /reverse", `tcp:\$\{buildConfig\.port\}`, `tcp:\$\{peer\.port\}`/);
  assert.doesNotMatch(
    androidReleaseBrowserOnboardingSmoke,
    /connectToAppWebView|webview_devtools_remote|clickButtonByText|kvJson|run-as/,
  );
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /tauri:android:release:browser-onboarding-grant:smoke/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /browser-backed release onboarding child grant/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /app-universal-release\.apk/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /createServer/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /data-township-href="township:\/\/pairing/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /Intent;scheme=township;package=\$\{appId\};component=\$\{appActivity\};end/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /assertBrowserPagePrecededPairingSave/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /phase=grant/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /grant_ops/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /grant_authority_accepted=true/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /outbox_frame_count=3/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /accepted_count=3/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /TOWNSHIP_RELEASE_ONBOARDING_GRANT_BUILD_SCRIPT/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /tauri:android:build:release:onboarding-grant-state-probe/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /startPairingStateExchangeServer/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /stateExchangeUrl/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /waitForState/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /blocked_reason=state_mismatch/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /wrongRuntimeArmState/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /wrong-state/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /assertNoPairingSavedYet/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /assertLogcatDoesNotContain/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /runtime onboarding child-grant state must not be emitted to probe logs/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /post_materialized=true/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /bad_authority_reason=operation_not_granted/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /TOWNSHIP_RELEASE_AUTHOR_PROBE_LOG_PREFIX/);
  assert.match(androidReleaseBrowserOnboardingGrantSmoke, /reauthoredLinePattern/);
  assert.doesNotMatch(
    androidReleaseBrowserOnboardingGrantSmoke,
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
  assert.match(strategy, /adb-delivered Android `VIEW`\/`BROWSABLE` intent/);
  assert.match(strategy, /local-malicious-app threat/);
  assert.match(strategy, /does not prove Chrome\/browser\s+navigation/);
  assert.match(strategy, /persisted deep-link endpoint rather than a build-time peer URL/);
  assert.match(strategy, /Plan 094\s+adds the real\s+Tauri app confirmation policy/);
  assert.match(strategy, /unchecked-by-default user\s+confirmation/);
  assert.match(strategy, /`confirm=1` do not unlock saving/);
  assert.match(strategy, /Plan 095 adds the app-controlled anti-hijack\s+gate/);
  assert.match(strategy, /installed unarmed OS links are\s+traced as blocked/);
  assert.match(strategy, /one valid armed pairing link consumes the\s+arm in the shared listener contract/);
  assert.match(strategy, /Plan 096 proves packaged macOS real-app armed delivery/);
  assert.match(strategy, /explicit `township-dev-trace` release-mode smoke build/);
  assert.match(strategy, /Plan 101 repairs that proof/);
  assert.match(strategy, /dev-trace-only control link/);
  assert.match(strategy, /waits for native hydration/);
  assert.match(strategy, /Plan 097 adds a\s+packaged no-side-effect trace guard/);
  assert.match(strategy, /Save Pairing, Sync Outbox, and\s+Check Carrier now emit explicit dev-trace events/);
  assert.match(strategy, /traced side effects plus native KV writes are absent in a settled\/allowlisted trace window/);
  assert.match(strategy, /Plan 098 proves warm macOS LaunchServices scheme resolution/);
  assert.match(strategy, /Plan 099 proves the\s+packaged macOS cold-start path/);
  assert.match(strategy, /Plan 100 adds\s+app-local state binding/);
  assert.match(strategy, /crypto-generated state token/);
  assert.match(strategy, /Plan 105 separately proves Android release cold-start pairing delivery/);
  assert.match(strategy, /force-stop`\/assert-not-running/);
  assert.match(strategy, /does not prove browser\/chooser UX or iOS\s+cold-start URL delivery/);
  assert.match(strategy, /Plan 103 adds Android release armed OS pairing delivery/);
  assert.match(strategy, /blocked_reason=state_mismatch/);
  assert.match(strategy, /fixed probe-only constant/);
  assert.match(strategy, /not\s+browser\/chooser-backed state exchange or an unforgeable production challenge/);
  assert.match(strategy, /Plan 104 adds the named Android release convergence gate/);
  assert.match(strategy, /tauri:android:release:convergence/);
  assert.match(strategy, /builds each probe APK before running its corresponding\s+smoke/);
  assert.match(strategy, /Plan 105 extends that release pairing smoke to prove Android cold-start pairing delivery/);
  assert.match(strategy, /asserts `pidof` is empty/);
  assert.match(strategy, /no-state cold-start with `blocked_reason=state_mismatch`/);
  assert.match(strategy, /Plan 106 adds a single-APK Android release onboarding convergence probe/);
  assert.match(strategy, /peer config comes from the OS-delivered pairing handoff/);
  assert.match(strategy, /not a browser\/chooser-backed exchange/);
  assert.match(strategy, /Plan 107 adds Android release browser-backed pairing delivery/);
  assert.match(strategy, /browser-loaded HTML page/);
  assert.match(strategy, /does not prove chooser UI/);
  assert.match(strategy, /Plan 108 adds Android release browser-backed onboarding convergence/);
  assert.match(strategy, /browser page request is observed before the\s+onboarding namespace saves pairing/);
  assert.match(strategy, /does not prove chooser UI/);
  assert.match(strategy, /does not prove\s+browser\/chooser-backed or cross-device pairing state exchange/);
  assert.match(strategy, /Plan 109 adds Android release browser-backed onboarding child-grant composition/);
  assert.match(strategy, /phase=grant/);
  assert.match(strategy, /grant_authority_accepted=true/);
  assert.match(strategy, /Plan 110 adds Android release browser-backed pairing state exchange/);
  assert.match(strategy, /runtime state is absent\s+from probe logs/);
  assert.match(strategy, /does not prove chooser UI or cross-device state exchange/);
  assert.match(strategy, /Plan 111 adds Android release browser-backed onboarding state exchange/);
  assert.match(strategy, /runtime state-bearing browser link drives the same onboarding pull-author-reload-push-report flow/);
  assert.match(strategy, /Plan 112 adds Android release browser-backed onboarding child-grant runtime state exchange/);
  assert.match(strategy, /child-grant pull-grant-author-reload-push-report flow/);
  assert.match(strategy, /grant_authority_accepted=true/);
  assert.match(strategy, /Plan 113 adds a named Android release browser\/onboarding regression gate/);
  assert.match(strategy, /back-to-back rebuild\/install\/browser\/port hygiene over plans 107-112/);
  assert.match(strategy, /does not prove chooser UI, cross-device exchange, authority origination, or full mobile onboarding/);
  assert.match(strategy, /Plan 114 adds Android release chooser-eligible onboarding state exchange/);
  assert.match(strategy, /unpinned Android intent URL/);
  assert.match(strategy, /does not prove visible chooser UI or cross-device pairing state\s+exchange/);
  assert.match(strategy, /Plan 115 adds bounded authority origination at the shared TS\/live-BEAM seam/);
  assert.match(strategy, /authorTownshipGenesis/);
  assert.match(strategy, /impostor_genesis/);
  assert.match(strategy, /Plan 116 adds Android release root\/authority origination/);
  assert.match(strategy, /root_authority_accepted=true/);
  assert.match(strategy, /forged_authority_reason=impostor_genesis/);
  assert.match(strategy, /Plan 118 adds desktop Tauri default-namespace onboarding convergence/);
  assert.match(strategy, /default `TOWNSHIP_STORAGE_NAMESPACE`/);
  assert.match(strategy, /onboarding:contract/);
  assert.match(strategy, /no resident private seed\s+material/);
  assert.match(strategy, /does\s+not prove QR camera onboarding/);
  assert.match(strategy, /does\s+not prove LAN discovery/);
  assert.match(strategy, /does\s+not prove physical-device\s+behavior/);
  assert.match(strategy, /does\s+not prove iOS,\s+Expo,\s+cross-device pairing state\s+exchange, or full mobile onboarding/);
  assert.match(strategy, /Android Tauri release APK: bounded release pull\/reload, device-local authoring, app-originated post-only attenuated grants, release root\/authority origination, push\/outbox drain, OS deep-link peer-config persistence, release armed OS pairing delivery with a fixed probe-only state, Android release cold-start pairing delivery, single-APK pairing-to-post convergence, browser-backed pairing delivery, browser-backed onboarding convergence, browser-backed onboarding child-grant composition, browser-backed runtime pairing state exchange, browser-backed onboarding runtime state exchange, browser-backed onboarding child-grant runtime state exchange, browser\/onboarding regression gate, chooser-eligible onboarding state exchange, visible chooser onboarding selection, real-app imported pairing confirmation policy, installed unarmed OS deep-link blocking, and source-level user-armed state-bound one-shot import gating are met by plans 091-095, 100, 102, 103, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 116, and 117/);
  assert.match(strategy, /Android Tauri release APK: bounded carrier pull\/reload, OS deep-link peer-config persistence, release armed OS pairing delivery with a fixed probe-only state, Android release cold-start pairing delivery, single-APK pairing-to-post convergence, browser-backed pairing delivery, browser-backed onboarding convergence, browser-backed onboarding child-grant composition, browser-backed runtime pairing state exchange, browser-backed onboarding runtime state exchange, browser-backed onboarding child-grant runtime state exchange, browser\/onboarding regression gate, chooser-eligible onboarding state exchange, visible chooser onboarding selection, device-local post authoring, app-originated post-only attenuated grants, release root\/authority origination, persisted pending-outbox reload, push\/outbox drain, peer-side authority enforcement, real-app imported pairing confirmation policy, installed unarmed OS deep-link blocking, and source-level user-armed state-bound one-shot import gating are met by plans 091-095, 100, 102, 103, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 116, and 117/);
  assert.match(strategy, /Packaged macOS Tauri app: real-app armed one-shot OS delivery is met by plan 096/);
  assert.match(strategy, /the traced no-side-effect link-load guard is met by plan 097/);
  assert.match(strategy, /app-local state binding is met by plan 100/);
  assert.match(strategy, /release dev-trace hydration and control-link repair is met by plan 101/);
  assert.doesNotMatch(strategy, /full release Sync\/outbox\/KV convergence, and full mobile onboarding remain unproven in release/);
  assert.doesNotMatch(strategy, /Release mobile Sync\/outbox\/KV convergence, iOS Tauri, and Expo: still unproven/);
  assert.match(strategy, /QR camera onboarding,\s+LAN discovery, physical-device behavior, production\s+remote TLS, or full mobile onboarding/);
  assert.match(strategy, /browser\/chooser-backed or cross-device pairing state exchange/);
  assert.doesNotMatch(strategy, /under release minification/);
  assert.match(strategy, /not a phone-grade persistence or BEAM\s+convergence proof/);
  assert.match(strategy, /The generated Tauri iOS and Android projects are build targets only/);
  assert.match(strategy, /Android emulator now proves native carrier key reuse/);
  assert.match(strategy, /No phone-grade persistence claim is allowed/);
  assert.match(buildMap, /clients\/township-tauri-shell/);
  assert.match(buildMap, /shell coverage through plan 120/);
  assert.match(
    buildMap,
    /desktop and Android-release convergence, onboarding,\s+and pairing proofs exist through plan 120/,
  );
  assert.match(buildMap, /docs\/township_mobile_secure_store_strategy\.md/);
  assert.match(
    buildMap,
    /Plan 127 does not change or\s+newly prove Tauri onboarding\/cap persistence,\s+mobile secure-store custody, or real app\s+convergence/,
  );
  assert.match(buildMap, /plans 023-127/);
  assert.match(buildMap, /Xcode 27 beta Tauri Swift-package failure/);
  assert.match(buildMap, /QR camera onboarding/);
  assert.match(buildMap, /LAN discovery/);
  assert.match(buildMap, /Physical-device behavior/);
  assert.match(buildMap, /Cross-device pairing state exchange/);
  assert.match(buildMap, /do not add new probe variants/);
  assert.doesNotMatch(buildMap, /phone-grade mobile BEAM convergence smoke (?:is|are|has been) proven/i);

  assert.match(plansIndex, /\| 054 \| Tauri onboarding\/cap persistence ceremony \| P1 \| M \| 053 \| DONE \|/);
  assert.match(plansIndex, /\| 055 \| Mobile secure-store strategy \| P1 \| S \| 054 \| DONE \|/);
  assert.match(plansIndex, /\| 056 \| Real app convergence gate \| P1 \| S \| 055 \| DONE \|/);
  assert.match(plan054, /## Status\s+DONE/);
  assert.match(plan054, /persist the grant as local\s+delegation evidence/);
  assert.match(plan054, /Keep mobile secure-store implementation[\s\S]*full\s+Expo\/Tauri app convergence out of scope/);
  assert.match(plan055, /## Status\s+DONE/);
  assert.match(plan055, /native secure-store\/signer seam/);
  assert.match(plan055, /replayable sync state that can be rebuilt\s+from the carrier/);
  assert.match(plan056, /## Status\s+DONE/);
  assert.match(plan056, /`app:convergence`/);
  assert.match(plan056, /current Tauri desktop convergence gate/);
  assert.match(plan056, /does not claim phone-grade Tauri\s+mobile or Expo convergence/);

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
  assert.match(plan102, /## Status\s+DONE/);
  assert.match(plan102, /app-originated child\s+post-only grant|app-originated post-only attenuated\s+Township grant/);
  assert.match(plan102, /ops: \["post"\]/);
  assert.match(plan102, /outbox_frame_count=3/);
  assert.match(plan102, /grant_authority_accepted=true/);
  assert.match(plan102, /No root\/authority origination/);
  assert.match(plan102, /No Claude approval is claimed/);
  assert.match(plan103, /## Status\s+DONE/);
  assert.match(plan103, /Android release armed pairing delivery/);
  assert.match(plan103, /blocked_reason=state_mismatch/);
  assert.match(plan103, /no\s+premature `phase=pairing outcome=saved`/);
  assert.match(plan103, /fixed probe-only constant/);
  assert.match(plan103, /not browser\/chooser-backed state exchange or an unforgeable\s+production challenge/);
  assert.match(plan103, /polling path/);
  assert.match(plan103, /Claude Code reviewed/);
  assert.match(plansIndex, /\| 104 \| Tauri Android release convergence gate \| P1 \| S \| 091, 092, 103 \| DONE \|/);
  assert.match(plan104, /## Status\s+DONE/);
  assert.match(plan104, /tauri:android:release:convergence/);
  assert.match(plan104, /builds each probe APK before running its\s+corresponding smoke/);
  assert.match(plan104, /sync-probe[\s\S]*author-probe[\s\S]*pairing-probe/);
  assert.match(plan104, /No browser\/chooser-backed state exchange/);
  assert.match(plan104, /No authority origination[\s\S]*full\s+mobile onboarding/);
  assert.match(plansIndex, /\| 105 \| Tauri Android release cold-start pairing delivery \| P1 \| M \| 103, 104 \| DONE \|/);
  assert.match(plan105, /## Status\s+DONE/);
  assert.match(plan105, /Android release cold-start pairing delivery/);
  assert.match(plan105, /force-stop\/assert-not-running/);
  assert.match(plan105, /no-state cold-start/);
  assert.match(plan105, /state-bearing cold-start/);
  assert.match(plan105, /blocked_reason=state_mismatch/);
  assert.match(plan105, /does not prove browser\/chooser-backed state exchange/);
  assert.match(plan105, /Android\/iOS full onboarding remains unproven|full mobile onboarding remains unproven/);
  assert.match(plansIndex, /\| 106 \| Tauri Android release single-APK onboarding convergence \| P1 \| M \| 093, 092, 105 \| DONE \|/);
  assert.match(plansIndex, /\| 107 \| Tauri Android release browser-backed pairing delivery \| P1 \| M \| 103, 105 \| DONE \|/);
  assert.match(plansIndex, /\| 108 \| Tauri Android release browser-backed onboarding convergence \| P1 \| M \| 106, 107 \| DONE \|/);
  assert.match(plansIndex, /\| 109 \| Tauri Android release browser-backed onboarding child grant \| P1 \| M \| 102, 108 \| DONE \|/);
  assert.match(plansIndex, /\| 110 \| Tauri Android release browser-backed pairing state exchange \| P1 \| M \| 100, 107 \| DONE \|/);
  assert.match(plansIndex, /\| 111 \| Tauri Android release browser-backed onboarding state exchange \| P1 \| M \| 108, 110 \| DONE \|/);
  assert.match(plan106, /## Status\s+DONE/);
  assert.match(plan106, /single-APK Android release onboarding convergence/);
  assert.match(plan106, /peer config comes only from the OS-delivered pairing handoff/);
  assert.match(plan106, /dedicated namespace `township:release-onboarding-probe`/);
  assert.match(plan106, /pulls the bootstrap post-only cap/);
  assert.match(plan106, /post_materialized=true/);
  assert.match(plan106, /bad_authority_reason=operation_not_granted/);
  assert.match(plan106, /does not prove browser\/chooser-backed state exchange/);
  assert.match(plan106, /does not prove app-originated child grant composition/);
  assert.match(plan106, /full mobile onboarding remains unproven/);
  assert.match(plan107, /## Status\s+DONE/);
  assert.match(plan107, /Android release browser-backed pairing delivery/);
  assert.match(plan107, /browser-loaded HTML page/);
  assert.match(plan107, /tap/);
  assert.match(plan107, /state-bearing `township:\/\/pairing`/);
  assert.match(plan107, /does not prove chooser UI/);
  assert.match(plan107, /does not prove cross-device cryptographic state exchange/);
  assert.match(plan107, /full mobile onboarding remains unproven/);
  assert.match(plan108, /## Status\s+DONE/);
  assert.match(plan108, /Android release browser-backed onboarding convergence/);
  assert.match(plan108, /browser page request is observed before the\s+onboarding namespace saves\s+pairing/);
  assert.match(plan108, /pulls the bootstrap post-only cap/);
  assert.match(plan108, /post_materialized=true/);
  assert.match(plan108, /bad_authority_reason=operation_not_granted/);
  assert.match(plan108, /does not prove chooser UI/);
  assert.match(plan108, /does not prove\s+browser\/chooser-backed or cross-device pairing state exchange/);
  assert.match(plan108, /full mobile onboarding remains unproven/);
  assert.match(plan109, /## Status\s+DONE/);
  assert.match(plan109, /Android release browser-backed onboarding child grant/);
  assert.match(plan109, /browser page request is observed before the\s+onboarding namespace saves\s+pairing/);
  assert.match(plan109, /phase=grant/);
  assert.match(plan109, /grant_ops=post/);
  assert.match(plan109, /grant_authority_accepted=true/);
  assert.match(plan109, /accepted_count=3/);
  assert.match(plan109, /does not prove authority origination/);
  assert.match(plan109, /does not prove chooser UI/);
  assert.match(plan109, /full mobile onboarding remains unproven/);
  assert.match(plan110, /## Status\s+DONE/);
  assert.match(plan110, /Android release browser-backed pairing state exchange/);
  assert.match(plan110, /app-minted runtime state/);
  assert.match(plan110, /VITE_TOWNSHIP_RELEASE_PAIRING_PROBE_STATE_EXCHANGE_URL/);
  assert.match(plan110, /No build-time `ARM_STATE`/);
  assert.match(plan110, /blocked_reason=state_mismatch/);
  assert.match(plan110, /runtime pairing state must not be emitted to probe logs/);
  assert.match(plan110, /does not prove chooser UI/);
  assert.match(plan110, /does not prove cross-device/);
  assert.match(plan110, /does not prove full mobile onboarding/);
  assert.match(plan111, /## Status\s+DONE/);
  assert.match(plan111, /Android release browser-backed onboarding state exchange/);
  assert.match(plan111, /app-minted runtime state/);
  assert.match(plan111, /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STATE_EXCHANGE_URL/);
  assert.match(plan111, /No build-time `ARM_STATE`/);
  assert.match(plan111, /blocked_reason=state_mismatch/);
  assert.match(plan111, /runtime onboarding state must not be emitted to probe logs/);
  assert.match(plan111, /post_materialized=true/);
  assert.match(plan111, /bad_authority_reason=operation_not_granted/);
  assert.match(plan111, /does not prove chooser UI/);
  assert.match(plan111, /does not prove cross-device/);
  assert.match(plan111, /does not prove authority origination/);
  assert.match(plan111, /does not prove full mobile onboarding/);
  assert.match(plan112, /## Status\s+DONE/);
  assert.match(plan112, /Android release browser-backed onboarding child-grant state exchange/);
  assert.match(plan112, /app-minted runtime state/);
  assert.match(plan112, /VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_STATE_EXCHANGE_URL/);
  assert.match(plan112, /No build-time `ARM_STATE`/);
  assert.match(plan112, /blocked_reason=state_mismatch/);
  assert.match(plan112, /well-formed wrong-state/);
  assert.match(plan112, /runtime onboarding child-grant state is absent from `LATTICE_PROBE`/);
  assert.match(plan112, /grant_ops=post/);
  assert.match(plan112, /accepted_count=3/);
  assert.match(plan112, /grant_authority_accepted=true/);
  assert.match(plan112, /bad_authority_reason=operation_not_granted/);
  assert.match(plan112, /does not prove chooser UI/);
  assert.match(plan112, /does not prove cross-device/);
  assert.match(plan112, /does not prove authority origination/);
  assert.match(plan112, /does not prove full mobile onboarding/);
  assert.match(plan113, /## Status\s+DONE/);
  assert.match(plan113, /Android release browser\/onboarding regression gate/);
  assert.match(plan113, /tauri:android:release:browser-onboarding-regression/);
  assert.match(plan113, /back-to-back rebuild\/install\/browser\/port hygiene/);
  assert.match(plan113, /No new runtime behavior/);
  assert.match(plan113, /does not prove chooser UI/);
  assert.match(plan113, /does not prove cross-device/);
  assert.match(plan113, /does not prove authority origination/);
  assert.match(plan113, /does not prove full mobile onboarding/);
  assert.match(plan114, /## Status\s+DONE/);
  assert.match(plan114, /Android release chooser-eligible onboarding state exchange/);
  assert.match(plan114, /tauri:android:release:chooser-onboarding-state-exchange/);
  assert.match(plan114, /TOWNSHIP_ANDROID_BROWSER_INTENT_MODE=chooser/);
  assert.match(plan114, /unpinned Android intent URL/);
  assert.match(plan114, /does not prove visible chooser UI/);
  assert.match(plan114, /does not prove cross-device/);
  assert.match(plan114, /does not prove authority origination/);
  assert.match(plan114, /does not prove full mobile onboarding/);
  assert.match(plansIndex, /\| 114 \| Tauri Android release chooser onboarding state exchange \| P1 \| M \| 111, 113 \| DONE \|/);
  assert.match(plan115, /## Status\s+DONE/);
  assert.match(plan115, /bounded authority origination/);
  assert.match(plan115, /authorTownshipGenesis/);
  assert.match(plan115, /impostor_genesis/);
  assert.match(plan115, /does not prove Android release root\/authority origination/);
  assert.match(plansIndex, /\| 115 \| Township bounded authority origination \| P1 \| S \| 058, 114 \| DONE \|/);
  assert.match(plan116, /## Status\s+DONE/);
  assert.match(plan116, /Android release root\/authority origination/);
  assert.match(plan116, /tauri:android:release:root-origination/);
  assert.match(plan116, /authorTownshipGenesis/);
  assert.match(plan116, /native carrier key/);
  assert.match(plan116, /impostor_genesis/);
  assert.match(plan116, /does not prove cross-device/);
  assert.match(plan116, /does not prove full mobile onboarding/);
  assert.match(plansIndex, /\| 116 \| Tauri Android release root authority origination \| P1 \| M \| 115 \| DONE \|/);
  assert.match(plan117, /Android release visible chooser onboarding/);
  assert.match(plan117, /uiautomator/);
  assert.match(plan117, /competing handler/);
  assert.match(plan117, /tauri:android:release:chooser-visible-onboarding/);
  assert.match(plan117, /does not prove cross-device/);
  assert.match(plan117, /does not prove full mobile onboarding/);
  assert.match(plansIndex, /\| 117 \| Tauri Android release visible chooser onboarding \| P1 \| M \| 114 \| DONE \|/);
  assert.match(plan118, /## Status\s+DONE/);
  assert.match(plan118, /Tauri desktop onboarding convergence/);
  assert.match(plan118, /onboarding:contract/);
  assert.match(plan118, /onboardTownshipDesktop/);
  assert.match(plan118, /default `TOWNSHIP_STORAGE_NAMESPACE`/);
  assert.match(plan118, /imported pairing handoff/);
  assert.match(plan118, /initial sync/);
  assert.match(plan118, /author a post/);
  assert.match(plan118, /final sync/);
  assert.match(plan118, /drained\s+outbox/);
  assert.match(plan118, /no resident private seed material/);
  assert.match(plan118, /app:convergence/);
  assert.match(plan118, /does not prove QR camera onboarding/);
  assert.match(plan118, /does not prove LAN discovery/);
  assert.match(plan118, /does not prove physical-device behavior/);
  assert.match(plan118, /does not prove iOS or Expo/);
  assert.match(plan118, /does not prove full mobile onboarding/);
  assert.match(plansIndex, /\| 118 \| Tauri desktop onboarding convergence \| P1 \| M \| 054, 056 \| DONE \|/);
  assert.match(plan119, /## Status\s+DONE/);
  assert.match(plan119, /Tauri packaged onboarding convergence/);
  assert.match(plan119, /tauri:onboarding:smoke/);
  assert.match(plan119, /onboardTownshipDesktop/);
  assert.match(plan119, /Sim-exported post frame/);
  assert.match(plan119, /default `TOWNSHIP_STORAGE_NAMESPACE`/);
  assert.match(plan119, /isolated native KV file/);
  assert.match(plan119, /does not prove human click-through/);
  assert.match(plan119, /does not prove full mobile onboarding/);
  assert.match(plansIndex, /\| 119 \| Tauri packaged onboarding convergence \| P1 \| M \| 118 \| DONE \|/);
  assert.match(plan120, /## Status\s+DONE/);
  assert.match(plan120, /Tauri browser onboarding click-through/);
  assert.match(plan120, /onboarding:click-through/);
  assert.match(plan120, /Post \/ No local cap/);
  assert.match(plan120, /Post action to `Available`/);
  assert.match(plan120, /real BEAM carrier/);
  assert.match(plan120, /does not prove packaged WKWebView/);
  assert.match(plan120, /does not use the real Rust signer/);
  assert.match(plan120, /does not prove human click-through/);
  assert.match(plansIndex, /\| 120 \| Tauri browser onboarding click-through \| P1 \| M \| 119 \| DONE \|/);
  assert.match(plan093, /## Status\s+(?:IN PROGRESS|DONE)/);
  assert.match(plan093, /Android release deep-link pairing ingress/);
  assert.match(plan093, /township:\/\/pairing/);
  assert.match(plan093, /adb-delivered Android `VIEW`\/`BROWSABLE` delivery/);
  assert.match(plan093, /local app can still send a syntactically valid public handoff intent/);
  assert.match(plan093, /persisted deep-link\s+endpoint rather than a build-time peer URL/);
  assert.match(plan093, /township:release-pairing-probe/);
  assert.match(plan093, /no env peer URL/i);
  assert.match(plan093, /STOP Conditions/);
  assert.match(plan094, /## Status\s+(?:IN PROGRESS|DONE)/);
  assert.match(plan094, /Tauri imported pairing confirmation policy/);
  assert.match(plan094, /confirmation_required/);
  assert.match(plan094, /confirm=1/);
  assert.match(plan094, /same-config idempotency/);
  assert.match(plan094, /release probe does not silently share/);
  assert.match(plan094, /STOP Conditions/);
  assert.match(plan095, /## Status\s+(?:IN PROGRESS|DONE)/);
  assert.match(plan095, /Tauri armed deep-link pairing import gate/);
  assert.match(plan095, /one-shot pairing deep-link gate/);
  assert.match(plan095, /unarmed OS deep link can load a pairing draft/);
  assert.match(plan095, /invalid deep links can drain/);
  assert.match(plan095, /cryptographic state\/nonce/);
  assert.match(plan095, /STOP Conditions/);
  assert.match(plan096, /## Status\s+(?:IN PROGRESS|DONE)/);
  assert.match(plan096, /Tauri installed-app armed deep-link delivery smoke/);
  assert.match(plan096, /LaunchServices-delivered/);
  assert.match(plan096, /pairing-link-import-armed/);
  assert.match(plan096, /pairing-link-loaded:<peer-fingerprint>/);
  assert.match(plan096, /second `pairing-link-blocked:not-armed`/);
  assert.match(plan096, /Android release armed-delivery/);
  assert.match(plan096, /STOP Conditions/);
  assert.match(plan097, /## Status\s+(?:IN PROGRESS|DONE)/);
  assert.match(plan097, /Tauri pairing link no-side-effect trace guard/);
  assert.match(plan097, /pairing-config-save-submitted/);
  assert.match(plan097, /sync-outbox-started/);
  assert.match(plan097, /carrier-health-started/);
  assert.match(plan097, /pairing-link-load-settled/);
  assert.match(plan097, /untraced side effects remain outside/);
  assert.match(plan097, /absence assertion is only checking UI copy/);
  assert.match(plan097, /STOP Conditions/);
  assert.match(plan098, /## Status\s+(?:IN PROGRESS|DONE)/);
  assert.match(plan098, /Tauri macOS LaunchServices warm routing/);
  assert.match(plan098, /NSWorkspace/);
  assert.match(plan098, /bare `open township:\/\/`/);
  assert.match(plan098, /cold-start/);
  assert.match(plan098, /browser\/chooser/);
  assert.match(plan098, /STOP Conditions/);
  assert.match(plan099, /## Status\s+(?:IN PROGRESS|DONE)/);
  assert.match(plan099, /Tauri macOS cold-start deep-link delivery/);
  assert.match(plan099, /TownshipDevTraceFile/);
  assert.match(plan099, /cold-start delivery/);
  assert.match(plan099, /not already\s+running/);
  assert.match(plan099, /Android\/iOS cold-start/);
  assert.match(plan099, /STOP Conditions/);
  assert.match(plan100, /## Status\s+(?:IN PROGRESS|DONE)/);
  assert.match(plan100, /Tauri armed pairing state binding/);
  assert.match(plan100, /crypto-generated local state token/);
  assert.match(plan100, /state_mismatch/);
  assert.match(plan100, /cross-device authenticated exchange/);
  assert.match(plan100, /Claude Code was asked twice/);
  assert.match(plan100, /STOP Conditions/);
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
