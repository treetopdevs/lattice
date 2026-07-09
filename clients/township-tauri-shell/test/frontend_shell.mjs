import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function readText(path) {
  return readFileSync(join(root, path), "utf8");
}

function readJson(path) {
  return JSON.parse(readText(path));
}

test("Tauri serves the built Vue frontend assets", () => {
  const config = readJson("src-tauri/tauri.conf.json");

  assert.equal(config.build.beforeBuildCommand, "npm run build");
  assert.equal(config.build.beforeDevCommand, "npm run dev");
  assert.equal(config.build.devUrl, "http://localhost:5173");
  assert.equal(config.build.frontendDist, "../dist");
});

test("frontend package builds and tests the Township Vue shell", () => {
  assert.ok(existsSync(join(root, "package.json")), "frontend package.json should exist");

  const pkg = readJson("package.json");
  assert.equal(pkg.name, "@treetopdevs/township-tauri-shell");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.scripts.build, "vite build");
  assert.equal(pkg.scripts["tauri:build"], "tauri build --bundles app");
  assert.equal(pkg.scripts.typecheck, "vue-tsc --noEmit");
  assert.equal(pkg.scripts["frontend:contract"], "node --test test/frontend_shell.mjs");
  assert.equal(pkg.scripts["mobile:tauri-readiness"], "node --test test/tauri_mobile_readiness.mjs");
  assert.equal(pkg.scripts["tauri:deep-link:smoke"], "tsx test/tauri_installed_deeplink_smoke.ts");
  assert.equal(pkg.dependencies["@treetopdevs/lattice-client"], "file:../lattice-client");
  assert.match(pkg.devDependencies["@tauri-apps/cli"], /^\^2\./);
  assert.match(pkg.dependencies.vue, /^\^3\.5\./);
});

test("frontend package exposes installed-app deep-link delivery smoke", () => {
  const smoke = readText("test/tauri_installed_deeplink_smoke.ts");
  const native = readText("src-tauri/src/lib.rs");

  assert.match(smoke, /township:\/\/pairing/);
  assert.match(smoke, /TOWNSHIP_DEV_TRACE_FILE/);
  assert.match(smoke, /deep-link-listener-mounted/);
  assert.match(smoke, /deep-link:township:\/\/pairing/);
  assert.match(smoke, /pairing-link-blocked:not-armed/);
  assert.doesNotMatch(smoke, /waitForTraceLine\(`pairing-link-loaded:/);
  assert.match(smoke, /\.app/);
  assert.match(smoke, /spawnManaged\(\s*"open",\s*\[\s*"-n",\s*"-W",\s*"-j"/);
  assert.match(smoke, /"--env"/);
  assert.match(smoke, /run\("open", \["-b", appIdentifier, "-u", deepLinkUrl\]/);
  assert.match(smoke, /npm", \["run", "tauri:build"\]/);
  assert.match(smoke, /if \(child\.exitCode !== null\) return Promise\.resolve\(child\.exitCode\)/);
  assert.match(native, /TOWNSHIP_DEV_TRACE_EVENT_MAX_CHARS/);
  assert.match(native, /sanitize_trace_dev_event/);
  assert.match(native, /replace\(\['\\r', '\\n', '\\0'\], " "\)/);
  assert.doesNotMatch(native, /#\[cfg\(debug_assertions\)\]\s*fn trace_dev_command/);
  assert.doesNotMatch(native, /#\[cfg\(not\(debug_assertions\)\)\]\s*fn trace_dev_command/);
  assert.match(native, /lattice_trace_dev_event/);
});

test("Vue source mounts a reducer-backed Township matter surface", () => {
  const indexHtml = readText("index.html");
  const main = readText("src/main.ts");
  const preview = readText("src/township_preview.ts");
  const app = readText("src/App.vue");

  assert.match(indexHtml, /<div id="app"><\/div>/);
  assert.match(main, /createApp\(App\)\.mount\("#app"\)/);
  assert.match(preview, /from "@treetopdevs\/lattice-client"/);
  assert.match(preview, /materialize\(townshipMatterSchema, townshipMatterOps\)/);
  assert.match(preview, /export function townshipPreview/);
  assert.match(preview, /Zoning Variance #24/);
  assert.match(app, /townshipPreview\(\)/);
});

test("Vue source surfaces native invoke readiness from the Tauri workflow", () => {
  const app = readText("src/App.vue");
  const nativeWorkflow = readText("src/native_workflow.ts");
  const pkg = readJson("package.json");

  assert.equal(pkg.dependencies["@tauri-apps/api"], "^2.11.1");
  assert.equal(pkg.scripts["native:contract"], "tsx test/native_workflow.ts");
  assert.match(nativeWorkflow, /from "@tauri-apps\/api\/core"/);
  assert.match(nativeWorkflow, /createTauriKeyValueStore/);
  assert.match(nativeWorkflow, /createTauriNativeCarrierSigner/);
  assert.match(app, /loadTownshipNativeStatus\(\)/);
  assert.match(app, /Device key/);
  assert.match(app, /nativeStatus\.ready/);
});

test("Vue source exposes a cap-gated author-and-persist post action", () => {
  const app = readText("src/App.vue");
  const actions = readText("src/township_actions.ts");
  const pkg = readJson("package.json");

  assert.equal(pkg.scripts["action:contract"], "tsx test/township_actions.ts");
  assert.match(actions, /authorAndPersistTownshipCommand/);
  assert.match(actions, /createTownshipNativeWorkflow/);
  assert.match(actions, /export async function submitTownshipPost/);
  assert.match(app, /submitTownshipPost/);
  assert.match(app, /postDraft/);
  assert.match(app, /@submit\.prevent="submitPost"/);
  assert.match(app, /Post update/);
});

test("Vue source exposes a cap-gated summary edit action", () => {
  const app = readText("src/App.vue");
  const actions = readText("src/township_actions.ts");

  assert.match(actions, /export async function submitTownshipCommand/);
  assert.match(app, /submitTownshipCommand/);
  assert.match(app, /summaryDraft/);
  assert.match(app, /submitSummary/);
  assert.match(app, /command: "set_summary"/);
  assert.match(app, /Update summary/);
});

test("Vue source shows cap-aware action availability", () => {
  const app = readText("src/App.vue");
  const actions = readText("src/township_actions.ts");

  assert.match(actions, /export async function loadTownshipActionAvailability/);
  assert.match(app, /loadTownshipActionAvailability/);
  assert.match(app, /actionAvailability/);
  assert.match(app, /availableActions/);
  assert.match(app, /Available actions/);
  assert.match(app, /close_matter/);
  assert.match(app, /remove_member/);
});

test("Vue source exposes close and reopen matter status actions", () => {
  const app = readText("src/App.vue");

  assert.match(app, /statusStatus/);
  assert.match(app, /statusSubmitting/);
  assert.match(app, /submitMatterStatus/);
  assert.match(app, /statusActionAllowed/);
  assert.match(app, /command: \{ command \}/);
  assert.match(app, /Close matter/);
  assert.match(app, /Reopen matter/);
  assert.match(app, /close_matter/);
  assert.match(app, /reopen_matter/);
});

test("Vue source exposes member-management actions", () => {
  const app = readText("src/App.vue");

  assert.match(app, /memberDraft/);
  assert.match(app, /memberStatus/);
  assert.match(app, /memberSubmitting/);
  assert.match(app, /submitMemberCommand/);
  assert.match(app, /memberActionAllowed/);
  assert.match(app, /command: \{ command, member: memberDraft\.value \}/);
  assert.match(app, /Member management/);
  assert.match(app, /Member name/);
  assert.match(app, /Admit member/);
  assert.match(app, /Remove member/);
  assert.match(app, /remove_member/);
});

test("Vue source exposes a cap grant ceremony", () => {
  const app = readText("src/App.vue");
  const actions = readText("src/township_actions.ts");

  assert.match(actions, /export async function submitTownshipDelegation/);
  assert.match(app, /submitTownshipDelegation/);
  assert.match(app, /grantAudienceDraft/);
  assert.match(app, /grantStatus/);
  assert.match(app, /grantSubmitting/);
  assert.match(app, /submitGrant/);
  assert.match(app, /@submit\.prevent="submitGrant"/);
  assert.match(app, /Device public key/);
  assert.match(app, /Grant access/);
  assert.match(app, /pending carrier sync/);
});

test("Vue source exposes a pending-sync revocation ceremony", () => {
  const app = readText("src/App.vue");
  const actions = readText("src/township_actions.ts");

  assert.match(actions, /export async function submitTownshipRevocation/);
  assert.match(app, /submitTownshipRevocation/);
  assert.match(app, /revokeDelegationDraft/);
  assert.match(app, /revokeStatus/);
  assert.match(app, /revokeSubmitting/);
  assert.match(app, /submitRevoke/);
  assert.match(app, /Delegation id/);
  assert.match(app, /Revoke access/);
  assert.match(app, /pending carrier sync/);
  assert.doesNotMatch(app, /access revoked/i);
});

test("Vue source exposes carrier-accepted revocation acknowledgement without claiming access removal", () => {
  const app = readText("src/App.vue");
  const sync = readText("src/township_sync.ts");

  assert.match(sync, /carrierAcceptedRevocationIds/);
  assert.match(sync, /authorityQuarantinedRevocationIds/);
  assert.match(app, /carrierAcceptedRevocationCount/);
  assert.match(app, /carrier accepted/);
  assert.match(app, /revoke frame/);
  assert.match(app, /pending authority confirmation/);
  assert.doesNotMatch(app, /access revoked/i);
  assert.doesNotMatch(app, /access removed/i);
  assert.doesNotMatch(app, /revocation confirmed/i);
  assert.doesNotMatch(app, /confirmed by carrier sync/i);
});

test("Vue source surfaces authority-blocked revoked-cap commands without overclaiming revocation effectiveness", () => {
  const app = readText("src/App.vue");
  const sync = readText("src/township_sync.ts");

  assert.match(sync, /stateReport/);
  assert.match(sync, /authorityRevokedCapabilityIds/);
  assert.match(sync, /authorityRevokedCapabilityAttributions/);
  assert.match(sync, /authorityRevokedCapabilityUnattributedIds/);
  assert.match(sync, /delegationIdFromCapTerm/);
  assert.match(sync, /revoked_capability/);
  assert.match(app, /authorityRevokedCapabilityCount/);
  assert.match(app, /authorityRevokedCapabilityAttributionCount/);
  assert.match(app, /authorityRevokedCapabilityAttributions/);
  assert.match(app, /authorityRevokedCapabilityUnattributedCount/);
  assert.match(app, /cited delegation/);
  assert.match(app, /carrier reports as revoked/);
  assert.match(app, /more blocked by carrier authority/);
  assert.match(app, /revoked-cap command/);
  assert.match(app, /blocked by carrier authority/);
  assert.ok(
    app.indexOf("authorityRevokedCapabilityAttributionCount") < app.indexOf("authorityRevokedCapabilityCount"),
    "attributed revoked-cap message should take priority over carrier-wide fallback",
  );
  assert.ok(
    app.indexOf("authorityRevokedCapabilityCount") < app.indexOf("carrierAcceptedRevocationCount"),
    "authority-blocked revoked-cap message should take priority over carrier-accepted pending copy",
  );
  assert.doesNotMatch(app, /access revoked/i);
  assert.doesNotMatch(app, /access removed/i);
  assert.doesNotMatch(app, /revocation confirmed/i);
  assert.doesNotMatch(app, /confirmed by carrier sync/i);
  assert.doesNotMatch(app, /effective removal/i);
  assert.doesNotMatch(app, /effective for all future/i);
  assert.doesNotMatch(app, /your revocation/i);
  assert.doesNotMatch(app, /revocation worked/i);
});

test("Vue source does not claim phone-grade secure persistence", () => {
  const app = readText("src/App.vue");

  assert.doesNotMatch(app, /phone-grade/i);
  assert.doesNotMatch(app, /secure persistence/i);
  assert.doesNotMatch(app, /mobile secure/i);
});

test("frontend package exposes the real app convergence gate", () => {
  const pkg = readJson("package.json");

  assert.equal(
    pkg.scripts["app:convergence"],
    "npm run action:contract && npm run sync:contract && npm run live:contract && npm run tauri:launch:smoke && npm run tauri:deep-link:smoke",
  );
});

test("Vue source exposes a carrier sync outbox action", () => {
  const app = readText("src/App.vue");
  const sync = readText("src/township_sync.ts");
  const peer = readText("src/township_carrier_peer.ts");
  const pkg = readJson("package.json");

  assert.equal(pkg.scripts["sync:contract"], "tsx test/township_sync.ts");
  assert.equal(pkg.scripts["peer:contract"], "tsx test/township_carrier_peer.ts");
  assert.match(sync, /syncCarrierOnce/);
  assert.match(sync, /createTownshipNativeWorkflow/);
  assert.match(peer, /connectCarrierWebSocket/);
  assert.match(peer, /createWebCryptoCarrierVerifier/);
  assert.match(peer, /townshipCarrierPeerFromEnv/);
  assert.match(peer, /checkTownshipCarrierPeerHealth/);
  assert.match(peer, /status\(\)/);
  assert.match(sync, /export async function syncTownshipOutbox/);
  assert.match(sync, /peer\?: TownshipCarrierPeerConfig/);
  assert.match(app, /syncTownshipOutbox/);
  assert.match(app, /townshipCarrierPeerFromEnv\(\)/);
  assert.match(app, /syncStatus/);
  assert.match(app, /Sync outbox/);
});

test("Vue source exposes runtime carrier pairing config without storing secrets", () => {
  const app = readText("src/App.vue");
  const peer = readText("src/township_carrier_peer.ts");
  const nativeWorkflow = readText("src/native_workflow.ts");

  assert.match(nativeWorkflow, /export function createTownshipNativeStorage/);
  assert.match(peer, /TOWNSHIP_CARRIER_PAIRING_KEY = "carrier_peer_config"/);
  assert.match(peer, /normalizeTownshipCarrierPeerConfig/);
  assert.match(peer, /saveTownshipCarrierPeerConfig/);
  assert.match(peer, /loadTownshipCarrierPeerConfig/);
  assert.match(peer, /invalid_expected_peer_pubkey/);
  assert.match(peer, /invalid_url/);
  assert.match(app, /carrierPeer = ref<TownshipCarrierPeerConfig \| null>/);
  assert.match(app, /pairingDraft/);
  assert.match(app, /pairingStatus/);
  assert.match(app, /loadPairingConfig/);
  assert.match(app, /submitPairing/);
  assert.match(app, /saveTownshipCarrierPeerConfig/);
  assert.match(app, /loadTownshipCarrierPeerConfig/);
  assert.match(app, /createTownshipNativeStorage/);
  assert.match(app, /Carrier pairing/);
  assert.match(app, /Carrier URL/);
  assert.match(app, /Local realm/);
  assert.match(app, /Peer realm/);
  assert.match(app, /Peer public key/);
  assert.match(app, /Key id/);
  assert.match(app, /Save pairing/);
  assert.match(app, /carrierPeer\.value/);
  assert.doesNotMatch(app, /const carrierPeer = townshipCarrierPeerFromEnv\(\)/);
  assert.doesNotMatch(app, /seed phrase/i);
  assert.doesNotMatch(app, /private key/i);
  assert.doesNotMatch(app, /shared secret/i);
  assert.doesNotMatch(app, /connected to carrier/i);
  assert.doesNotMatch(app, /paired with/i);
});

test("Vue source gates imported pairing saves on explicit confirmation", () => {
  const app = readText("src/App.vue");
  const peer = readText("src/township_carrier_peer.ts");
  const releaseProbe = readText("src/township_release_pairing_probe.ts");

  assert.match(peer, /TownshipCarrierPairingDraftOrigin/);
  assert.match(peer, /confirmation_required/);
  assert.match(peer, /requiresPairingSaveConfirmation/);
  assert.match(peer, /townshipCarrierPeerConfigsEqual/);
  assert.match(app, /pairingDraftOrigin = ref<TownshipCarrierPairingDraftOrigin>\("manual"\)/);
  assert.match(app, /pairingSaveConfirmed = ref\(false\)/);
  assert.match(app, /pairingSaveConfirmationRequired/);
  assert.match(app, /pairingSaveConfirmationLabel/);
  assert.match(app, /pairingSaveConfirmationDetail/);
  assert.match(app, /clearPairingSaveConfirmation/);
  assert.match(app, /markImportedPairingDraft\("handoff"\)/);
  assert.match(app, /markImportedPairingDraft\("deep_link"\)/);
  assert.match(app, /markImportedPairingDraft\("qr_image"\)/);
  assert.match(app, /markImportedPairingDraft\("qr_camera"\)/);
  assert.match(app, /markImportedPairingDraft\("discovery"\)/);
  assert.match(app, /origin: pairingDraftOrigin\.value/);
  assert.match(app, /confirmed: pairingSaveConfirmed\.value/);
  assert.match(app, /I verified this imported carrier pairing/);
  assert.match(app, /I verified replacing the saved carrier pairing/);
  assert.match(app, /Current peer/);
  assert.match(app, /Draft peer/);
  assert.doesNotMatch(app, /pairingSaveConfirmed = ref\(true\)/);
  assert.match(releaseProbe, /origin: "release_probe"/);
  assert.match(releaseProbe, /confirmed: true/);
});

test("Vue source exposes pairing handoff import without device-local identity transfer", () => {
  const app = readText("src/App.vue");
  const peer = readText("src/township_carrier_peer.ts");
  const link = readText("src/township_pairing_deeplink.ts");
  const source = readText("src/township_pairing_deeplink_source.ts");
  const pkg = readJson("package.json");

  assert.equal(pkg.scripts["deeplink:contract"], "tsx test/township_pairing_deeplink.ts");
  assert.equal(pkg.scripts["deeplink:source:contract"], "tsx test/township_pairing_deeplink_source.ts");
  assert.match(peer, /exportTownshipCarrierPairingHandoff/);
  assert.match(peer, /importTownshipCarrierPairingHandoff/);
  assert.match(peer, /townshipCarrierPeerFingerprint/);
  assert.match(link, /parseTownshipPairingDeepLink/);
  assert.match(link, /createTownshipPairingDeepLinkListener/);
  assert.match(link, /createOneShotTownshipPairingDeepLinkGate/);
  assert.match(link, /importTownshipCarrierPairingHandoff/);
  assert.doesNotMatch(link, /@tauri-apps\/plugin-deep-link/);
  assert.match(source, /createTauriPairingDeepLinkSource/);
  assert.match(source, /import\("@tauri-apps\/plugin-deep-link"\)/);
  assert.match(peer, /invalid_pairing_format/);
  assert.match(peer, /unsupported_pairing_version/);
  assert.match(peer, /invalid_pairing_payload/);
  assert.match(app, /pairingHandoffDraft/);
  assert.match(app, /pairingHandoffFingerprint/);
  assert.match(app, /parseTownshipPairingDeepLink/);
  assert.match(app, /createTownshipPairingDeepLinkListener/);
  assert.match(app, /createTauriPairingDeepLinkSource/);
  assert.match(app, /createTauriPairingDeepLinkSource\(\{ includeAndroidPairingIntent: false \}\)/);
  assert.match(app, /tauriDeepLinkRuntimeAvailable/);
  assert.match(app, /pairingDeepLinkListener/);
  assert.match(app, /pairingDeepLinkGate = createOneShotTownshipPairingDeepLinkGate\(\)/);
  assert.match(app, /pairingDeepLinkImportArmed = ref\(false\)/);
  assert.match(app, /armPairingDeepLinkImport/);
  assert.match(app, /disarmPairingDeepLinkImport/);
  assert.match(app, /consumePairingDeepLinkImport/);
  assert.match(app, /onBlocked: handleBlockedPairingDeepLink/);
  assert.match(app, /Pairing link ignored; enable link import first/);
  assert.match(app, /Enable link import/);
  assert.match(app, /Cancel link import/);
  assert.doesNotMatch(app, /pairingDeepLinkImportArmed = ref\(true\)/);
  assert.match(app, /Pairing link loaded; save before sync/);
  assert.match(app, /deep-link-listener-mounted/);
  assert.match(app, /pairing-link-loaded:/);
  assert.match(app, /pairingHandoffDraft\.value = imported\.handoff/);
  assert.match(app, /exportPairingHandoff/);
  assert.match(app, /importPairingHandoff/);
  assert.match(app, /Pairing handoff/);
  assert.match(app, /Export handoff/);
  assert.match(app, /Load handoff/);
  assert.match(app, /Verify peer fingerprint before saving/);
  assert.match(app, /Pairing handoff loaded; save before sync/);
  assert.match(app, /peer fingerprint/);
  assert.doesNotMatch(app, /handoff.*localRealm/i);
  assert.doesNotMatch(app, /handoff.*keyId/i);
  assert.doesNotMatch(app, /auto.?connect/i);
  assert.doesNotMatch(app, /connected to carrier/i);
  assert.doesNotMatch(app, /paired with/i);
  assert.doesNotMatch(app, /deep.?link registered/i);
  assert.doesNotMatch(app, /opened by (the )?os/i);
  assert.doesNotMatch(app, /secure pairing/i);
});

test("Vue source mounts the pairing deep-link listener before the best-effort canonical probe listener", () => {
  const app = readText("src/App.vue");
  const mountedStart = app.indexOf("onMounted(async () => {");
  const mountedEnd = app.indexOf("if (autosyncOnMount && carrierPeer.value) await syncOutbox()");
  const mounted = app.slice(mountedStart, mountedEnd);

  assert.ok(mountedStart > -1, "expected App.vue to define an onMounted boot sequence");
  assert.ok(
    mounted.indexOf("await mountPairingDeepLinkListener()") > -1,
    "expected the boot sequence to mount the pairing deep-link listener",
  );
  assert.ok(
    mounted.indexOf("await mountCanonicalProbeDeepLinkListener()") > -1,
    "expected the boot sequence to mount the canonical probe listener",
  );
  assert.ok(
    mounted.indexOf("await mountPairingDeepLinkListener()") <
      mounted.indexOf("await mountCanonicalProbeDeepLinkListener()"),
    "pairing import readiness should not sit behind a best-effort probe listener",
  );
});

test("Vue source does not block pairing deep-link readiness on native keychain probes", () => {
  const app = readText("src/App.vue");
  const mountedStart = app.indexOf("onMounted(async () => {");
  const mountedEnd = app.indexOf("if (autosyncOnMount && carrierPeer.value) await syncOutbox()");
  const mounted = app.slice(mountedStart, mountedEnd);

  assert.ok(mountedStart > -1, "expected App.vue to define an onMounted boot sequence");
  assert.ok(
    mounted.indexOf("await mountPairingDeepLinkListener()") > -1,
    "expected the boot sequence to mount the pairing deep-link listener",
  );
  assert.equal(
    mounted.indexOf("nativeStatus.value = await loadTownshipNativeStatus()"),
    -1,
    "boot should not start keychain-backed readiness before pairing imports can receive OS events",
  );
  assert.ok(
    app.indexOf("async function hydrateTownshipNativeReadiness()") > -1,
    "expected native readiness to be hydrated by a deferred helper",
  );
  assert.match(app, /nativeStatus\.value = await loadTownshipNativeStatus\(\)/);
  assert.match(app, /window\.setTimeout\(\(\) => \{[\s\S]*void hydrateTownshipNativeReadiness\(\);[\s\S]*\}/);
});

test("Vue source renders pairing handoff QR without trust claims", () => {
  const app = readText("src/App.vue");
  const qr = readText("src/township_pairing_qr.ts");
  const pkg = readJson("package.json");

  assert.match(pkg.scripts["qr:contract"], /test\/township_pairing_qr\.ts/);
  assert.match(qr, /renderTownshipPairingQrSvg/);
  assert.match(qr, /importTownshipCarrierPairingHandoff/);
  assert.match(qr, /role="img"/);
  assert.match(qr, /aria-label="Township pairing QR"/);
  assert.match(app, /renderTownshipPairingQrSvg/);
  assert.match(app, /pairingQrSvg/);
  assert.match(app, /v-html="pairingQrSvg"/);
  assert.match(app, /Pairing QR/);
  assert.match(app, /QR carries the same public handoff/);
  assert.match(app, /fingerprint before saving/);
  assert.doesNotMatch(app, /scan to pair/i);
  assert.doesNotMatch(app, /deep.?link registered/i);
  assert.doesNotMatch(app, /secure pairing/i);
  assert.doesNotMatch(app, /connected to carrier/i);
});

test("Vue source decodes pairing QR images and camera frames as draft imports", () => {
  const app = readText("src/App.vue");
  const qr = readText("src/township_pairing_qr.ts");
  const camera = readText("src/township_pairing_qr_camera.ts");
  const pkg = readJson("package.json");

  assert.equal(pkg.scripts["qr:camera:contract"], "tsx test/township_pairing_qr_camera.ts");
  assert.match(qr, /decodeTownshipPairingQrImageData/);
  assert.match(qr, /invalid_pairing_qr/);
  assert.match(camera, /createTownshipPairingQrCameraScanner/);
  assert.match(camera, /decodeTownshipPairingQrImageData/);
  assert.match(app, /decodeTownshipPairingQrImageData/);
  assert.match(app, /createTownshipPairingQrCameraScanner/);
  assert.match(app, /pairingQrImageStatus/);
  assert.match(app, /pairingCameraStatus/);
  assert.match(app, /pairingCameraScanning/);
  assert.match(app, /importPairingQrImage/);
  assert.match(app, /startPairingQrCamera/);
  assert.match(app, /stopPairingQrCamera/);
  assert.match(app, /createBrowserPairingQrCameraSource/);
  assert.match(app, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(app, /facingMode: "environment"/);
  assert.match(app, /Pairing QR image/);
  assert.match(app, /Load QR image/);
  assert.match(app, /Pairing QR camera/);
  assert.match(app, /Start camera/);
  assert.match(app, /Stop camera/);
  assert.match(app, /accept="image\/\*"/);
  assert.match(app, /Pairing QR image loaded; save before sync/);
  assert.match(app, /Pairing camera loaded; save before sync/);
  assert.match(app, /pairingDraft\.value = \{[\s\S]*\.\.\.pairingDraft\.value,[\s\S]*\.\.\.decoded\.draft,/);
  assert.match(app, /try \{[\s\S]*const decoded = await decodePairingQrImageFile\(file\)/);
  assert.match(app, /catch \{[\s\S]*Load an image containing a Township pairing QR/);
  assert.match(app, /finally \{[\s\S]*pairingQrImporting\.value = false;[\s\S]*input\.value = "";/);
  assert.doesNotMatch(app, /scan to pair/i);
  assert.doesNotMatch(app, /auto.?connect/i);
  assert.doesNotMatch(app, /connected to carrier/i);
  assert.doesNotMatch(app, /secure pairing/i);
});

test("Vue source exposes manual pairing discovery without auto-pairing", () => {
  const app = readText("src/App.vue");
  const discovery = readText("src/township_pairing_discovery.ts");
  const discoverySource = readText("src/township_pairing_discovery_source.ts");
  const pkg = readJson("package.json");

  assert.equal(pkg.scripts["discovery:contract"], "tsx test/township_pairing_discovery.ts");
  assert.match(discovery, /createTownshipPairingDiscovery/);
  assert.match(discovery, /importTownshipCarrierPairingHandoff/);
  assert.match(discoverySource, /TOWNSHIP_PAIRING_DISCOVERY_COMMAND = "lattice_discover_pairing_adverts"/);
  assert.match(discoverySource, /TOWNSHIP_PAIRING_ADVERTISE_COMMAND = "lattice_advertise_pairing_handoff"/);
  assert.match(discoverySource, /createTauriPairingDiscoverySource/);
  assert.match(discoverySource, /advertiseTauriPairingHandoff/);
  assert.match(discoverySource, /timeoutMs/);
  assert.match(discoverySource, /townshipPairingDiscoveryAdvertsFromNative/);
  assert.match(app, /createTownshipPairingDiscovery/);
  assert.match(app, /createTauriPairingDiscoverySource/);
  assert.match(app, /advertiseTauriPairingHandoff/);
  assert.match(app, /pairingAdvertiseStatus/);
  assert.match(app, /pairingAdvertiseSubmitting/);
  assert.match(app, /pairingDiscoveryStatus/);
  assert.match(app, /pairingDiscoveryRunning/);
  assert.match(app, /pairingDiscoveryCandidate/);
  assert.match(app, /advertisePairingHandoff/);
  assert.match(app, /startPairingDiscovery/);
  assert.match(app, /stopPairingDiscovery/);
  assert.match(app, /loadDiscoveredPairing/);
  assert.match(app, /tauriNativeRuntimeAvailable/);
  assert.match(app, /preferNativeDiscovery/);
  assert.match(app, /createBrowserPairingDiscoverySource/);
  assert.match(app, /BroadcastChannel\("township-pairing-discovery"\)/);
  assert.match(app, /postMessage\(\{[\s\S]*type: "township-pairing-discovery"[\s\S]*handoff/);
  assert.match(app, /township-pairing-discovery/);
  assert.match(app, /Pairing discovery/);
  assert.match(app, /Advertise handoff/);
  assert.match(app, /Start discovery/);
  assert.match(app, /Stop discovery/);
  assert.match(app, /Load discovered handoff/);
  assert.match(app, /Public pairing handoff advertised; verify peer fingerprint before saving on another device/);
  assert.match(app, /Discovered pairing loaded; save before sync/);
  assert.match(app, /peer fingerprint/);
  assert.doesNotMatch(app, /auto.?pair/i);
  assert.doesNotMatch(app, /auto.?connect/i);
  assert.doesNotMatch(app, /connected to carrier/i);
  assert.doesNotMatch(app, /paired with/i);
  assert.doesNotMatch(app, /secure pairing/i);
  assert.doesNotMatch(app, /trusted peer/i);
});

test("Vue source exposes a one-shot carrier health probe without overclaiming connection state", () => {
  const app = readText("src/App.vue");
  const peer = readText("src/township_carrier_peer.ts");

  assert.match(peer, /export async function checkTownshipCarrierPeerHealth/);
  assert.match(peer, /probe_failed/);
  assert.match(peer, /\.status\(\)/);
  assert.match(peer, /\.close\(\)/);
  assert.match(app, /checkTownshipCarrierPeerHealth/);
  assert.match(app, /healthStatus/);
  assert.match(app, /healthSubmitting/);
  assert.match(app, /checkCarrierHealth/);
  assert.match(app, /Check carrier/);
  assert.match(app, /Carrier session opened/);
  assert.match(app, /peer status/);
  assert.doesNotMatch(app, /connected to carrier/i);
  assert.doesNotMatch(app, /paired with/i);
  assert.doesNotMatch(app, /durably connected/i);
  assert.doesNotMatch(app, /carrier online/i);
});

test("Vue source supports smoke-only auto-sync from Vite env", () => {
  const app = readText("src/App.vue");
  const env = readText("src/env.d.ts");

  assert.match(env, /VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT/);
  assert.match(app, /autosyncOnMount/);
  assert.match(app, /VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT/);
  assert.match(app, /if \(autosyncOnMount && carrierPeer\.value\) await syncOutbox\(\)/);
});

test("Vue source does not block smoke auto-sync on action availability hydration", () => {
  const app = readText("src/App.vue");
  const mountedStart = app.indexOf("onMounted(async () => {");
  const mountedEnd = app.indexOf("async function submitPost");
  const mounted = app.slice(mountedStart, mountedEnd);

  assert.ok(mountedStart > -1, "expected App.vue to define an onMounted boot sequence");
  assert.ok(
    mounted.indexOf("await loadPairingConfig()") < mounted.indexOf("if (autosyncOnMount && carrierPeer.value) await syncOutbox()"),
    "pairing config should load before smoke-only auto-sync",
  );
  assert.ok(
    mounted.indexOf("if (autosyncOnMount && carrierPeer.value) await syncOutbox()")
      < mounted.indexOf("scheduleTownshipNativeHydration()"),
    "native/action availability hydration should be scheduled after smoke-only auto-sync can converge",
  );
  assert.match(app, /actionAvailability\.value = await loadTownshipActionAvailability\(\)/);
});
