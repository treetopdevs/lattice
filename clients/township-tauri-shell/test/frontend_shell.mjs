import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const legacySourceLayoutTest = test.skip;

function readText(path) {
  return readFileSync(join(root, path), "utf8");
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function asyncFunctionSource(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start > -1, `expected async function ${name}`);
  const next = source.indexOf("\nasync function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
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
  assert.equal(
    pkg.scripts["tauri:build:dev-trace"],
    "VITE_TOWNSHIP_DEV_TRACE=1 VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT=0 tauri build --features township-dev-trace --bundles app",
  );
  assert.equal(pkg.scripts.typecheck, "vue-tsc --noEmit");
  assert.equal(pkg.scripts["frontend:contract"], "node --test test/frontend_shell.mjs");
  assert.equal(pkg.scripts["mobile:tauri-readiness"], "node --test test/tauri_mobile_readiness.mjs");
  assert.equal(pkg.scripts["tauri:deep-link:smoke"], "tsx test/tauri_installed_deeplink_smoke.ts");
  assert.equal(pkg.scripts["tauri:cold-deep-link:smoke"], "tsx test/tauri_installed_cold_deeplink_smoke.ts");
  assert.equal(pkg.dependencies["@treetopdevs/lattice-client"], "file:../lattice-client");
  assert.match(pkg.devDependencies["@tauri-apps/cli"], /^\^2\./);
  assert.match(pkg.dependencies.vue, /^\^3\.5\./);
});

test("frontend package exposes installed-app cold-start deep-link smoke", () => {
  const smoke = readText("test/tauri_installed_cold_deeplink_smoke.ts");
  const native = readText("src-tauri/src/lib.rs");

  assert.match(smoke, /TownshipDevTraceFile/);
  assert.match(smoke, /await setDevTraceDefaults\(tracePath\)/);
  assert.match(smoke, /await waitForTownshipAppNotRunning\(\)/);
  assert.match(smoke, /await deliverDeepLink\(\)/);
  assert.match(smoke, /deep-link-listener-mounted/);
  assert.match(smoke, /deep-link:township:\/\/pairing/);
  assert.match(smoke, /pairing-link-blocked:not-armed/);
  assert.match(smoke, /await clearDevTraceDefaults\(\)/);
  assert.match(native, /TOWNSHIP_DEV_TRACE_FILE_DEFAULTS_KEY/);
  assert.match(
    native,
    /#\[cfg\(all\(feature = "township-dev-trace", target_os = "macos"\)\)\]\s*fn trace_dev_file_path_from_platform/,
  );
  assert.match(native, /trace_dev_file_path_from_platform/);
  assert.match(native, /std::process::Command::new\("\/usr\/bin\/defaults"\)/);
});

test("frontend package exposes installed-app armed deep-link delivery smoke", () => {
  const smoke = readText("test/tauri_installed_deeplink_smoke.ts");
  const native = readText("src-tauri/src/lib.rs");
  const cargoToml = readText("src-tauri/Cargo.toml");
  const app = readText("src/App.vue");
  const workflow = readText("src/native_workflow.ts");

  assert.match(smoke, /township:\/\/pairing/);
  assert.match(smoke, /TOWNSHIP_DEV_TRACE_FILE/);
  assert.match(smoke, /deep-link-listener-mounted/);
  assert.match(smoke, /waitForTraceLine\("township-native-hydration-settled", 60_000\)/);
  assert.doesNotMatch(smoke, /waitForTraceLine\("lattice_sign_carrier", 60_000\)/);
  assert.match(smoke, /deep-link:township:\/\/pairing/);
  assert.match(smoke, /pairing-link-blocked:not-armed/);
  assert.match(smoke, /township:\/\/dev\/pairing-import\/arm/);
  assert.match(smoke, /deliverDevTraceControlDeepLink\(armPairingImportUrl\)/);
  assert.match(smoke, /pairing-link-import-armed/);
  assert.match(smoke, /pairing-link-import-state:/);
  assert.match(smoke, /deliverDeepLink\(\{ state: armedState \}\)/);
  assert.match(smoke, /waitForTraceLine\(`pairing-link-loaded:/);
  assert.match(smoke, /blockedBeforeThirdDelivery \+ 1/);
  assert.match(smoke, /thirdBlockedIndex > loadedIndex/);
  assert.match(smoke, /\.app/);
  assert.match(smoke, /spawnManaged\(\s*"open",\s*\[\s*"-n",\s*"-W"/);
  assert.match(smoke, /"--env"/);
  assert.match(smoke, /await registerLaunchServicesHandler\(\)/);
  assert.match(smoke, /await assertLaunchServicesRoutesTownshipSchemeToBundle\(\)/);
  assert.match(smoke, /function deliverDeepLink/);
  assert.match(smoke, /function registerLaunchServicesHandler/);
  assert.match(smoke, /function assertLaunchServicesRoutesTownshipSchemeToBundle/);
  assert.match(smoke, /NSWorkspace\.shared\.urlForApplication\(toOpen:/);
  assert.match(smoke, /const url = options\.state \? `\$\{deepLinkUrl\}&state=\$\{encodeURIComponent\(options\.state\)\}` : deepLinkUrl/);
  assert.match(smoke, /run\("open", \[url\]/);
  assert.doesNotMatch(smoke, /run\("open", \["-a", appBundlePath, deepLinkUrl\]/);
  assert.match(smoke, /npm", \["run", "tauri:build:dev-trace"\]/);
  assert.match(smoke, /if \(child\.exitCode !== null\) return Promise\.resolve\(child\.exitCode\)/);
  assert.match(cargoToml, /\[features\][\s\S]*township-dev-trace = \[\]/);
  assert.match(native, /TOWNSHIP_DEV_TRACE_EVENT_MAX_CHARS/);
  assert.match(native, /sanitize_trace_dev_event/);
  assert.match(native, /replace\(\['\\r', '\\n', '\\0'\], " "\)/);
  assert.match(native, /#\[cfg\(feature = "township-dev-trace"\)\]\s*#\[tauri::command\]\s*fn lattice_trace_dev_event/);
  assert.match(native, /#\[cfg\(feature = "township-dev-trace"\)\]\s*fn trace_dev_command/);
  assert.match(native, /#\[cfg\(not\(feature = "township-dev-trace"\)\)\]\s*fn trace_dev_command\(_command: &str\) \{\}/);
  assert.doesNotMatch(native, /#\[cfg\(debug_assertions\)\]\s*fn trace_dev_command/);
  assert.doesNotMatch(native, /#\[cfg\(not\(debug_assertions\)\)\]\s*fn trace_dev_command/);
  assert.match(native, /#\[cfg\(any\(debug_assertions, feature = "township-dev-trace"\)\)\]\s*pub fn seed_dev_carrier_key_from_vars/);
  assert.match(native, /lattice_trace_dev_event/);
  assert.match(app, /devTraceRuntime = truthy\(import\.meta\.env\.VITE_TOWNSHIP_DEV_TRACE\)/);
  assert.match(app, /if \(devTraceRuntime\) await mountDevTraceShortcut\(\)/);
  assert.match(app, /async function mountDevTraceShortcut\(\)/);
  assert.match(app, /await traceTownshipDevEvent\(TOWNSHIP_TRACE_DEV_RUNTIME_READY\)/);
  assert.match(app, /traceTownshipDevEvent\("township-native-hydration-settled"\)/);
  assert.match(app, /if \(appUnmounted\) return/);
  assert.match(app, /devTraceShortcutMounted = true/);
  assert.match(app, /appUnmounted = true/);
  assert.match(app, /if \(devTraceShortcutMounted\) window\.removeEventListener\("keydown", handleDevTraceShortcut\)/);
  assert.match(app, /handleDevTraceShortcut/);
  assert.match(app, /if \(event && !event\.isTrusted\) return/);
  assert.match(app, /event\.metaKey/);
  assert.match(app, /event\.shiftKey/);
  assert.match(app, /event\.key\.toLowerCase\(\)/);
  assert.match(workflow, /TOWNSHIP_TRACE_DEV_SHORTCUT_KEYDOWN_PREFIX = "dev-trace-shortcut-keydown:"/);
  assert.match(workflow, /TOWNSHIP_TRACE_DEV_RUNTIME_READY = "dev-trace-runtime-ready"/);
  assert.match(workflow, /TOWNSHIP_TRACE_PAIRING_LINK_LOAD_SETTLED = "pairing-link-load-settled"/);
  assert.match(app, /TOWNSHIP_TRACE_DEV_SHORTCUT_KEYDOWN_PREFIX/);
  assert.match(app, /TOWNSHIP_TRACE_PAIRING_LINK_LOAD_SETTLED/);
  assert.match(smoke, /township:\/\/dev\/carrier-health\/check/);
  assert.match(smoke, /deliverDevTraceControlDeepLink\(checkCarrierHealthUrl\)/);
  assert.match(smoke, /waitForTraceLine\(TOWNSHIP_TRACE_PAIRING_LINK_LOAD_SETTLED/);
  assert.match(app, /traceTownshipDevEvent\("pairing-link-import-armed"\)/);
  assert.match(app, /handleDevTraceControlDeepLink/);
  assert.match(app, /route === "pairing-import\/arm"/);
  assert.match(app, /route === "carrier-health\/check"/);
  assert.match(app, /pairingDeepLinkImportState = ref<string \| null>\(null\)/);
  assert.match(app, /pairingDeepLinkImportState\.value = state/);
  assert.match(app, /traceTownshipDevEvent\(`pairing-link-import-state:\$\{state\}`\)/);
  assert.match(app, /traceTownshipDevEvent\(TOWNSHIP_TRACE_PAIRING_CONFIG_SAVE_SUBMITTED\)/);
  assert.match(app, /traceTownshipDevEvent\(TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED\)/);
  assert.match(app, /traceTownshipDevEvent\(TOWNSHIP_TRACE_CARRIER_HEALTH_STARTED\)/);
  assert.match(smoke, /TOWNSHIP_TRACE_PAIRING_CONFIG_SAVE_SUBMITTED/);
  assert.match(smoke, /TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED/);
  assert.match(smoke, /TOWNSHIP_TRACE_CARRIER_HEALTH_STARTED/);
  assert.match(smoke, /assertNoSideEffectTraceBetween/);
  assert.match(smoke, /assertAllowedDraftLoadTraceWindow/);
  assert.match(smoke, /waitForTraceLine\(TOWNSHIP_TRACE_CARRIER_HEALTH_STARTED/);
});

test("Vue source mounts a reducer-backed Township matter surface", () => {
  const indexHtml = readText("index.html");
  const main = readText("src/main.ts");
  const preview = readText("src/township_preview.ts");
  const app = readText("src/App.vue");

  assert.match(indexHtml, /<div id="app"><\/div>/);
  assert.match(main, /createApp\(App\)\.mount\("#app"\)/);
  assert.match(preview, /from "@treetopdevs\/lattice-client"/);
  assert.match(
    preview,
    /materialize\(\s*townshipMatterSchema,\s*ops,\s*undefined,\s*externallyQuarantined,?\s*\)/,
  );
  assert.match(preview, /export function townshipPreview/);
  assert.match(preview, /export function townshipPreviewFromOps/);
  assert.match(preview, /Zoning Variance #24/);
  assert.match(app, /townshipPreviewFromOps\(townshipMatterOps\)/);
});

test("Township preview uses one complete regenerated matter chain", () => {
  const preview = readText("src/township_preview.ts");
  const vector = readJson("../lattice-client/test/vectors/township_zoning_variance_24.json");
  const previewOpIds = [...preview.matchAll(/\bop\(\s*"([A-Za-z0-9_-]{43})"/g)].map(
    ([, id]) => id,
  );
  const previewReferencedIds = new Set(
    [...preview.matchAll(/"([A-Za-z0-9_-]{43})"/g)].map(([, id]) => id),
  );
  const expectedIds = vector.oracleCarrierOps
    .filter((frame) => {
      const command = frame.body?.[1]?.[0]?.[1];
      return command !== "transfer" && command !== "reopen_matter";
    })
    .map((frame) => frame.id)
    .sort();

  assert.deepEqual([...new Set(previewOpIds)].sort(), expectedIds);
  assert.equal(previewOpIds.length, expectedIds.length);
  assert.deepEqual([...previewReferencedIds].sort(), expectedIds);
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
  const acceptedRevoke = asyncFunctionSource(app, "submitAcceptedRevokeIntent");
  const manualRevoke = asyncFunctionSource(app, "submitRevoke");

  assert.match(actions, /export async function submitTownshipRevocation/);
  assert.match(app, /submitTownshipRevocation/);
  assert.match(acceptedRevoke, /delegationId: intent\.authority\.delegation/);
  assert.match(acceptedRevoke, /replica: intent\.replica/);
  assert.doesNotMatch(acceptedRevoke, /\bsyncTownshipOutbox\s*\(|\bsyncOutbox\s*\(/);
  assert.match(app, /revokeDelegationDraft/);
  assert.match(app, /revokeStatus/);
  assert.match(app, /revokeSubmitting/);
  assert.match(app, /const revokeIntentSubmitting = actionIntentDescriptorForSlot\("revoke"\)\.submitting/);
  assert.match(manualRevoke, /if \(revokeSubmitting\.value \|\| revokeIntentSubmitting\.value\) return/);
  assert.match(app, /submitRevoke/);
  assert.match(app, /Delegation id/);
  assert.match(app, /Revoke access/);
  assert.match(app, /:disabled="revokeSubmitting \|\| revokeIntentSubmitting \|\| revokeDelegationDraft\.trim\(\)\.length === 0"/);
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

test("Vue source surfaces locally verified revoked-cap commands without overclaiming revocation effectiveness", () => {
  const app = readText("src/App.vue");
  const sync = readText("src/township_sync.ts");

  assert.match(sync, /stateReport/);
  assert.match(sync, /materialize/);
  assert.match(sync, /carrierOpsToSemanticOps/);
  assert.match(sync, /townshipMatterSchema/);
  assert.match(sync, /authority_report_divergence/);
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
  assert.match(app, /local verification/);
  assert.match(app, /revoked-cap command/);
  assert.doesNotMatch(app, /carrier reports as revoked/);
  assert.doesNotMatch(app, /blocked by carrier authority/);
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

legacySourceLayoutTest("frontend package exposes the real app convergence gate", () => {
  const pkg = readJson("package.json");
  const launchSmoke = readText("test/tauri_launch_smoke.ts");
  const onboardingSmoke = readText("test/tauri_packaged_onboarding_smoke.ts");
  const clickThrough = readText("../../tests/e2e/township_onboarding_click_through.spec.ts");

  assert.equal(pkg.scripts["tauri:onboarding:smoke"], "tsx test/tauri_packaged_onboarding_smoke.ts");
  assert.equal(pkg.scripts["stable:relay:contract"], "tsx test/township_stable_relay.ts");
  assert.equal(
    pkg.scripts["tauri:stable-relay:onboarding:smoke"],
    "tsx test/tauri_stable_relay_onboarding_smoke.ts",
  );
  assert.equal(
    pkg.scripts["onboarding:click-through"],
    "VITE_TOWNSHIP_DEV_TRACE= VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT= npm run build && cd ../.. && npx --no-install playwright test tests/e2e/township_onboarding_click_through.spec.ts --config playwright.config.mjs",
  );
  assert.equal(
    pkg.scripts["app:convergence"],
    "npm run action:contract && npm run sync:contract && npm run stable:relay:contract && npm run feed:contract && npm run feed:app:contract && npm run onboarding:contract && npm run onboarding:click-through && npm run live:contract && npm run tauri:launch:smoke && npm run tauri:onboarding:smoke && npm run tauri:stable-relay:onboarding:smoke && npm run tauri:action-handoff:smoke && TOWNSHIP_SKIP_CLERK_ACTION_APP_BUILD=1 npm run tauri:clerk-action-handoff:smoke && TOWNSHIP_SKIP_FIELD_ACTION_APP_BUILD=1 npm run tauri:field-action-handoff:smoke && TOWNSHIP_SKIP_ROSTER_ACTION_APP_BUILD=1 npm run tauri:roster-action-handoff:smoke && TOWNSHIP_SKIP_DELEGATION_GRANT_APP_BUILD=1 npm run tauri:delegation-grant-handoff:smoke && npm run tauri:feed:smoke && npm run tauri:deep-link:smoke",
  );
  assert.match(launchSmoke, /"tauri", \["build", "--features", "township-dev-trace", "--bundles", "app"\]/);
  assert.match(launchSmoke, /VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT: "1"/);
  assert.match(launchSmoke, /appBundlePath/);
  assert.match(launchSmoke, /spawnManaged\(\s*"open",\s*\[\s*"-n",\s*"-W"/);
  assert.match(launchSmoke, /"--env"/);
  assert.match(onboardingSmoke, /township_carrier_w1\.json/);
  assert.match(onboardingSmoke, /TownshipOnboardingScenario/);
  assert.match(onboardingSmoke, /TOWNSHIP_NATIVE_KV_FILE/);
  assert.match(onboardingSmoke, /township-onboarding-drained/);
  assert.match(onboardingSmoke, /connectCarrierWebSocket/);
  assert.match(onboardingSmoke, /assertTownshipKvStoresNoSecrets/);
  assert.match(clickThrough, /TownshipOnboardingScenario/);
  assert.match(clickThrough, /__TAURI_INTERNALS__/);
  assert.match(clickThrough, /toContainText\("No local cap"\)/);
  assert.match(clickThrough, /toContainText\("Available"\)/);
  assert.match(clickThrough, /report\.state\.posts\.includes\(postText\)/);
});

legacySourceLayoutTest("frontend package exposes a Sim-anchored packaged v4 roster convergence gate", () => {
  const pkg = readJson("package.json");
  const smoke = readText("test/tauri_roster_action_handoff_smoke.ts");
  const fixture = readText("test/support/stable_roster_action_fixture.exs");
  const peerRelay = readText("test/support/stable_roster_action_peer_relay.exs");
  const workflow = readText("../../.github/workflows/flagship.yml");

  assert.equal(
    pkg.scripts["tauri:roster-action-handoff:smoke"],
    "tsx test/tauri_roster_action_handoff_smoke.ts",
  );
  assert.match(fixture, /TownshipOnboardingScenario\.base_sim/);
  assert.match(fixture, /Dag\.ancestors/);
  assert.match(fixture, /expected_remove\.deps != base_frontier/);
  assert.match(fixture, /expected_peer_admit\.deps != base_frontier/);
  assert.match(fixture, /expected_remove\.cap != genesis_cap_id/);
  assert.match(fixture, /ROSTER_FIXTURE_READY/);
  assert.match(peerRelay, /expectedPeerAdmit/);
  assert.match(peerRelay, /ROSTER_PEER_RELAY_READY/);
  assert.match(smoke, /#participant-roster-handoff/);
  assert.match(smoke, /assertLaunchServicesRoutesTownshipSchemeToBundle/);
  assert.match(smoke, /township:\/\/dev\/action-roster\/use/);
  assert.match(smoke, /township:\/\/dev\/action-roster\/sign/);
  assert.match(smoke, /township:\/\/dev\/carrier\/sync/);
  assert.match(smoke, /submitTownshipCommand/);
  assert.match(smoke, /missing_delegation/);
  assert.match(smoke, /lattice_sign_carrier/);
  assert.match(smoke, /lattice_kv_set/);
  assert.match(smoke, /expectedRemove/);
  assert.match(smoke, /expectedPeerAdmit/);
  assert.match(smoke, /expectedAdmit/);
  assert.match(smoke, /afterContested\.causalReplay/);
  assert.match(smoke, /afterAdmit\.causalReplay/);
  assert.match(smoke, /memberDigests/);
  assert.match(smoke, /relayPeerAdmitBeforeSync/);
  assert.match(
    pkg.scripts["app:convergence"],
    /TOWNSHIP_SKIP_FIELD_ACTION_APP_BUILD=1 npm run tauri:field-action-handoff:smoke && TOWNSHIP_SKIP_ROSTER_ACTION_APP_BUILD=1 npm run tauri:roster-action-handoff:smoke && TOWNSHIP_SKIP_DELEGATION_GRANT_APP_BUILD=1 npm run tauri:delegation-grant-handoff:smoke && npm run tauri:feed:smoke/,
  );
  assert.match(
    workflow,
    /Verify packaged field edit handoff[\s\S]*TOWNSHIP_SKIP_FIELD_ACTION_APP_BUILD: "1"[\s\S]*npm run tauri:field-action-handoff:smoke[\s\S]*Verify packaged roster handoff[\s\S]*TOWNSHIP_SKIP_ROSTER_ACTION_APP_BUILD: "1"[\s\S]*npm run tauri:roster-action-handoff:smoke[\s\S]*Verify packaged reactive carrier feed/,
  );
  for (const command of [
    "npm run action-intent:contract",
    "npm run deeplink:dispatcher:contract",
    "npm run action:contract",
    "npm run frontend:contract",
  ]) {
    assert.match(workflow, new RegExp(command.replaceAll(":", "\\:")));
  }
});

legacySourceLayoutTest("frontend package exposes a Sim-anchored packaged v5 delegation grant handoff", () => {
  const pkg = readJson("package.json");
  const smoke = readText("test/tauri_delegation_grant_handoff_smoke.ts");
  const fixture = readText("test/support/stable_grant_handoff_fixture.exs");
  const unsoundRelay = readText("test/support/stable_grant_handoff_relay.exs");
  const verifier = readText("test/support/stable_relay_verify.exs");
  const workflow = readText("../../.github/workflows/flagship.yml");

  assert.equal(
    pkg.scripts["tauri:delegation-grant-handoff:smoke"],
    "tsx test/tauri_delegation_grant_handoff_smoke.ts",
  );
  assert.match(fixture, /TownshipGrantHandoffScenario\.oracle/);
  assert.match(fixture, /GRANT_FIXTURE_READY/);
  assert.match(unsoundRelay, /unsoundGrant/);
  assert.match(unsoundRelay, /unsoundUse/);
  assert.match(unsoundRelay, /GRANT_UNSOUND_RELAY_READY/);
  assert.match(verifier, /grant_base/);
  assert.match(verifier, /grant_sound/);
  assert.match(verifier, /grant_recipient_use/);
  assert.match(verifier, /grant_unsound/);
  assert.match(smoke, /issuerKvPath/);
  assert.match(smoke, /recipientKvPath/);
  assert.match(smoke, /issuerSeed/);
  assert.match(smoke, /recipientSeed/);
  assert.match(smoke, /#participant-grant-handoff/);
  assert.match(smoke, /#participant-post-handoff/);
  assert.match(smoke, /assertLaunchServicesRoutesTownshipSchemeToBundle/);
  assert.match(smoke, /township:\/\/dev\/action-grant\/use/);
  assert.match(smoke, /township:\/\/dev\/action-grant\/sign/);
  assert.match(smoke, /township:\/\/dev\/action-post\/use/);
  assert.match(smoke, /township:\/\/dev\/action-post\/sign/);
  assert.match(smoke, /township:\/\/dev\/carrier\/sync/);
  assert.match(smoke, /soundGrant\.frame/);
  assert.match(smoke, /recipientUse\.frame/);
  assert.match(smoke, /not_attenuated/);
  assert.match(smoke, /invalid_capability/);
  assert.match(smoke, /matterState/);
  assert.match(smoke, /assertSourceUnchanged/);
  assert.match(smoke, /assertNoParentControls/);
  assert.match(smoke, /lattice_sign_carrier/);
  assert.match(smoke, /lattice_kv_set/);
  assert.match(smoke, /assertTownshipKvStoresNoSecrets/);
  assert.match(
    smoke,
    /function pinnedToolPath\(\): string \{[\s\S]*?process\.env\.PATH \?\? ""[\s\S]*?\.filter\(\(path\) => path\.length > 0 && \(path === process\.env\.PATH \|\| existsSync\(path\)\)\)[\s\S]*?\.join\(":"\);\n\}/,
  );
  assert.match(
    pkg.scripts["app:convergence"],
    /TOWNSHIP_SKIP_ROSTER_ACTION_APP_BUILD=1 npm run tauri:roster-action-handoff:smoke && TOWNSHIP_SKIP_DELEGATION_GRANT_APP_BUILD=1 npm run tauri:delegation-grant-handoff:smoke && npm run tauri:feed:smoke/,
  );
  assert.match(
    workflow,
    /Verify packaged roster handoff[\s\S]*Verify packaged delegation grant handoff[\s\S]*TOWNSHIP_SKIP_DELEGATION_GRANT_APP_BUILD: "1"[\s\S]*npm run tauri:delegation-grant-handoff:smoke[\s\S]*Verify packaged reactive carrier feed/,
  );
  assert.match(
    workflow,
    /TS Township delegation-grant fixture[\s\S]*npm run grant:fixture:contract/,
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
  assert.match(app, /v-model="pairingDraft\.submission"/);
  assert.match(app, /aria-label="Carrier submission"/);
  assert.match(app, /<option value="push">Generic push<\/option>/);
  assert.match(app, /<option value="relay">One-op relay<\/option>/);
  assert.match(app, /submission: config\.submission \?\? "push"/);
  assert.match(peer, /submission\?: TownshipCarrierSubmission/);
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

test("Vue source preserves gated pairing import through the shared participant dispatcher", () => {
  const app = readText("src/App.vue");
  const peer = readText("src/township_carrier_peer.ts");
  const link = readText("src/township_pairing_deeplink.ts");
  const source = readText("src/township_pairing_deeplink_source.ts");
  const dispatcher = readText("src/township_deep_link_dispatcher.ts");
  const pkg = readJson("package.json");

  assert.equal(pkg.scripts["deeplink:contract"], "tsx test/township_pairing_deeplink.ts");
  assert.equal(pkg.scripts["deeplink:source:contract"], "tsx test/township_pairing_deeplink_source.ts");
  assert.equal(pkg.scripts["deeplink:dispatcher:contract"], "tsx test/township_deep_link_dispatcher.ts");
  assert.match(peer, /exportTownshipCarrierPairingHandoff/);
  assert.match(peer, /importTownshipCarrierPairingHandoff/);
  assert.match(peer, /townshipCarrierPeerFingerprint/);
  assert.match(link, /parseTownshipPairingDeepLink/);
  assert.match(link, /createTownshipPairingDeepLinkListener/);
  assert.match(link, /createOneShotTownshipPairingDeepLinkGate/);
  assert.match(link, /createPairingImportState/);
  assert.match(link, /getRandomValues/);
  assert.match(link, /state_mismatch/);
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
  assert.match(dispatcher, /createTownshipParticipantDeepLinkDispatcher/);
  assert.match(dispatcher, /options\.source\.onOpenUrl\(handleUrls\)/);
  assert.match(dispatcher, /handleUrls\(await options\.source\.current\(\)\)/);
  assert.match(app, /createTownshipParticipantDeepLinkDispatcher/);
  assert.match(app, /routeOtherParticipantDeepLink/);
  assert.match(app, /createTauriPairingDeepLinkSource/);
  assert.match(
    app,
    /source: createTauriPairingDeepLinkSource\(\{ includeAndroidPairingIntent: true \}\)/,
  );
  assert.match(
    app,
    /source: createTauriPairingDeepLinkSource\(\{ includeAndroidPairingIntent: false \}\)/,
  );
  assert.match(app, /tauriDeepLinkRuntimeAvailable/);
  assert.match(app, /participantDeepLinkDispatcher/);
  assert.match(app, /pairingDeepLinkGate = createOneShotTownshipPairingDeepLinkGate\(\)/);
  assert.match(app, /pairingDeepLinkImportArmed = ref\(false\)/);
  assert.match(app, /pairingDeepLinkImportState = ref<string \| null>\(null\)/);
  assert.match(app, /armPairingDeepLinkImport/);
  assert.match(app, /disarmPairingDeepLinkImport/);
  assert.match(app, /consumePairingDeepLinkImport/);
  assert.match(app, /handleBlockedPairingDeepLink\(\{ reason: consumption\.reason, parse \}\)/);
  assert.match(app, /Pairing link ignored; enable link import first/);
  assert.match(app, /Pairing link ignored; state token did not match/);
  assert.match(app, /link state/);
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

test("Vue source mounts participant ingress before the best-effort canonical probe listener", () => {
  const app = readText("src/App.vue");
  const mountedStart = app.indexOf("onMounted(async () => {");
  const mountedEnd = app.indexOf("\n});\n\nonUnmounted", mountedStart);
  const mounted = app.slice(mountedStart, mountedEnd);

  assert.ok(mountedStart > -1, "expected App.vue to define an onMounted boot sequence");
  assert.ok(
    mounted.indexOf("await mountParticipantDeepLinkDispatcher()") > -1,
    "expected the boot sequence to mount the shared participant dispatcher",
  );
  assert.ok(
    mounted.indexOf("await mountCanonicalProbeDeepLinkListener()") > -1,
    "expected the boot sequence to mount the canonical probe listener",
  );
  assert.ok(
    mounted.indexOf("await mountParticipantDeepLinkDispatcher()") <
      mounted.indexOf("await mountCanonicalProbeDeepLinkListener()"),
    "participant ingress readiness should not sit behind a best-effort probe listener",
  );
});

test("Vue source does not block participant deep-link readiness on native keychain probes", () => {
  const app = readText("src/App.vue");
  const mountedStart = app.indexOf("onMounted(async () => {");
  const mountedEnd = app.indexOf("\n});\n\nonUnmounted", mountedStart);
  const mounted = app.slice(mountedStart, mountedEnd);

  assert.ok(mountedStart > -1, "expected App.vue to define an onMounted boot sequence");
  assert.ok(
    mounted.indexOf("await mountParticipantDeepLinkDispatcher()") > -1,
    "expected the boot sequence to mount the shared participant dispatcher",
  );
  assert.ok(
    mounted.indexOf("await loadPairingConfig()") < mounted.indexOf("await mountParticipantDeepLinkDispatcher()"),
    "participant action validation should have the saved replica before cold-start URLs are dispatched",
  );
  assert.ok(
    mounted.indexOf("await mountParticipantDeepLinkDispatcher()") <
      mounted.indexOf("scheduleTownshipNativeHydration()"),
    "participant ingress should mount before deferred keychain readiness starts",
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

legacySourceLayoutTest("Vue source limits packaged action execution to a dev-trace control over production functions", () => {
  const app = readText("src/App.vue");
  const smoke = readText("test/tauri_action_handoff_smoke.ts");
  const pkg = readJson("package.json");

  assert.equal(pkg.scripts["tauri:action-handoff:smoke"], "tsx test/tauri_action_handoff_smoke.ts");
  assert.match(pkg.scripts["app:convergence"], /tauri:action-handoff:smoke/);
  assert.match(app, /const devTraceRuntimeReady = ref\(false\)/);
  assert.match(
    app,
    /function handleDevTraceControlDeepLink\(value: string\): boolean \{[\s\S]*if \(!devTraceRuntime \|\| !devTraceRuntimeReady\.value\) return false/,
  );
  assert.match(
    app,
    /await traceTownshipDevEvent\(TOWNSHIP_TRACE_DEV_RUNTIME_READY\)[\s\S]*devTraceRuntimeReady\.value = true/,
  );
  assert.match(app, /route === "action-intent\/submit"/);
  assert.match(
    app,
    /async function submitPendingPostIntentFromDevTrace\(\)[\s\S]*acceptPendingActionIntent\(\)[\s\S]*await submitPost\(\)[\s\S]*await syncOutbox\(\)/,
  );
  assert.doesNotMatch(app, /VITE_TOWNSHIP_ACTION_INTENT_AUTO/);
  assert.match(smoke, /spawnTownshipActionLiveProjection/);
  assert.match(smoke, /#participant-post-handoff/);
  assert.match(smoke, /await deliverDeepLink\(handoff\.url\)/);
  assert.match(smoke, /township:\/\/dev\/action-intent\/submit/);
  assert.match(smoke, /assertLaunchServicesRoutesTownshipSchemeToBundle/);
  assert.match(smoke, /spawnStableCarrierServer/);
  assert.match(smoke, /stable_relay_verify\.exs/);
  assert.match(smoke, /assertTraceRedacted/);
});

legacySourceLayoutTest("Vue exposes separate redacted v1 post Use and Sign controls before explicit Sync", () => {
  const app = readText("src/App.vue");
  const useStart = app.indexOf("async function usePendingPostIntentFromDevTrace");
  const useEnd = app.indexOf("async function signAcceptedPostIntentFromDevTrace", useStart);
  const usePost = app.slice(useStart, useEnd);
  const signStart = useEnd;
  const signEnd = app.indexOf("async function usePendingStatusIntentFromDevTrace", signStart);
  const signPost = app.slice(signStart, signEnd);
  const traceStart = app.indexOf("async function tracePostIntentDevControl");
  const traceEnd = app.indexOf("async function tracePairingDeepLinkUrls", traceStart);
  const tracePost = app.slice(traceStart, traceEnd);

  assert.ok(useStart >= 0 && useEnd > useStart);
  assert.ok(signStart >= 0 && signEnd > signStart);
  assert.ok(traceStart >= 0 && traceEnd > traceStart);
  assert.match(app, /route === "action-post\/use"/);
  assert.match(app, /route === "action-post\/sign"/);
  assert.match(usePost, /intent\.v !== 1[\s\S]*acceptPendingActionIntent\(\)[\s\S]*acceptedPostIntent\.value\?\.id === intent\.id/);
  assert.doesNotMatch(usePost, /submitPost|syncOutbox/);
  assert.match(signPost, /await submitPost\(\)/);
  assert.doesNotMatch(signPost, /syncOutbox/);
  assert.match(app, /tracePostIntentDevControl\("sync", syncStatus\.value\?\.ok \? "synced" : "failed"\)/);
  assert.match(tracePost, /action-post-dev-\$\{step\}:\$\{outcome\}/);
  assert.doesNotMatch(tracePost, /\.text|postDraft|intent|action URL|deep-link/);
});

legacySourceLayoutTest("Vue keeps versioned clerk status signing separate from outbox sync", () => {
  const app = readText("src/App.vue");
  const start = app.indexOf("async function signAcceptedStatusIntent");
  const end = app.indexOf("function dismissAcceptedStatusIntent", start);
  const signStatus = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(app, /const pendingActionIntent = ref<TownshipReviewableActionIntent \| null>\(null\)/);
  assert.match(app, /const acceptedStatusIntent = ref<TownshipStatusActionIntent \| null>\(null\)/);
  assert.match(app, /id="participant-status-request"/);
  assert.match(app, /Sign \$\{statusIntentVerb\(acceptedStatusIntent\)\}/);
  assert.match(signStatus, /await submitMatterStatus\(intent\.command\.command, intent\.replica\)/);
  assert.doesNotMatch(signStatus, /syncOutbox/);
});

legacySourceLayoutTest("Vue keeps versioned field-edit review and signing separate from local drafts and sync", () => {
  const app = readText("src/App.vue");
  const acceptStart = app.indexOf("function acceptPendingActionIntent");
  const acceptEnd = app.indexOf("function dismissPendingActionIntent", acceptStart);
  const acceptIntent = app.slice(acceptStart, acceptEnd);
  const signStart = app.indexOf("async function signAcceptedFieldIntent");
  const signEnd = app.indexOf("function dismissAcceptedFieldIntent", signStart);
  const signField = app.slice(signStart, signEnd);

  assert.ok(acceptStart >= 0 && acceptEnd > acceptStart);
  assert.ok(signStart >= 0 && signEnd > signStart);
  assert.match(app, /import type \{[\s\S]*TownshipFieldActionIntent[\s\S]*\} from "\.\/township_action_intent"/);
  assert.match(app, /const acceptedFieldIntent = ref<TownshipFieldActionIntent \| null>\(null\)/);
  assert.match(acceptIntent, /intent\.v === 3[\s\S]*acceptedFieldIntent\.value = intent/);
  assert.doesNotMatch(acceptIntent, /summaryDraft\.value\s*=/);
  assert.match(app, /id="participant-field-request"/);
  assert.match(app, /Sign \$\{fieldIntentVerb\(acceptedFieldIntent\)\}/);
  assert.match(app, /route === "action-field\/use"/);
  assert.match(app, /route === "action-field\/sign"/);
  assert.match(
    app,
    /async function usePendingFieldIntentFromDevTrace\(\)[\s\S]*acceptPendingActionIntent\(\)[\s\S]*acceptedFieldIntent\.value\?\.id === intent\.id/,
  );
  assert.match(
    app,
    /async function signAcceptedFieldIntentFromDevTrace\(\)[\s\S]*fieldActionAllowed\(intent\.command\.command\)[\s\S]*await signAcceptedFieldIntent\(\)/,
  );
  assert.match(app, /traceFieldIntentDevControl\("sync", syncStatus\.value\?\.ok \? "synced" : "failed"\)/);
  assert.match(
    signField,
    /await submitTownshipCommand\(\{[\s\S]*command: intent\.command,[\s\S]*replica: intent\.replica/,
  );
  assert.doesNotMatch(signField, /syncOutbox/);
});

legacySourceLayoutTest("Vue stages and accepts v4 roster requests inertly in a separate review state", () => {
  const app = readText("src/App.vue");
  const actionIntent = readText("src/township_action_intent.ts");
  const dispatcher = readText("src/township_deep_link_dispatcher.ts");
  const stageStart = app.indexOf("function stageActionIntent");
  const stageEnd = app.indexOf("function rejectActionIntent", stageStart);
  const stageIntent = app.slice(stageStart, stageEnd);
  const acceptStart = app.indexOf("function acceptPendingActionIntent");
  const acceptEnd = app.indexOf("function dismissPendingActionIntent", acceptStart);
  const acceptIntent = app.slice(acceptStart, acceptEnd);
  const rosterAcceptStart = acceptIntent.indexOf("else if (intent.v === 4)");
  const rosterAcceptEnd = acceptIntent.indexOf("} else {", rosterAcceptStart);
  const acceptRosterIntent = acceptIntent.slice(rosterAcceptStart, rosterAcceptEnd);
  const labelStart = app.indexOf("function actionIntentLabel");
  const labelEnd = app.indexOf("function statusIntentVerb", labelStart);
  const label = app.slice(labelStart, labelEnd);

  assert.ok(stageStart >= 0 && stageEnd > stageStart);
  assert.ok(acceptStart >= 0 && acceptEnd > acceptStart);
  assert.ok(rosterAcceptStart >= 0 && rosterAcceptEnd > rosterAcceptStart);
  assert.ok(labelStart >= 0 && labelEnd > labelStart);
  assert.match(
    actionIntent,
    /export type TownshipReviewableActionIntent =[^;]*TownshipRosterActionIntent/s,
  );
  assert.doesNotMatch(dispatcher, /parsed\.intent\.v === 4/);
  assert.match(app, /TownshipRosterActionIntent/);
  assert.match(app, /const acceptedRosterIntent = ref<TownshipRosterActionIntent \| null>\(null\)/);
  assert.match(stageIntent, /pendingActionIntent\.value = intent/);
  assert.doesNotMatch(stageIntent, /submitTownshipCommand|syncOutbox|accepted\w+Intent\.value|Draft\.value/);
  assert.match(acceptIntent, /intent\.v === 4[\s\S]*acceptedRosterIntent\.value = intent/);
  assert.doesNotMatch(acceptIntent, /submitTownshipCommand|syncOutbox/);
  assert.doesNotMatch(
    acceptRosterIntent,
    /memberDraft\.value|postDraft\.value|accepted(?:Post|Status|Field)Intent\.value/,
  );
  assert.match(app, /function assertNeverActionIntent\(_intent: never\): never/);
  assert.match(acceptIntent, /intent\.v === 4[\s\S]*assertNeverActionIntent\(intent\)/);
  assert.match(label, /intent\.v === 4[\s\S]*return assertNeverActionIntent\(intent\)/);
  assert.match(app, /pendingActionIntent\.v === 4[\s\S]*pendingActionIntent\.command\.member/);
  assert.match(app, /id="participant-roster-request"/);
  assert.match(app, /acceptedRosterIntent\.command\.member/);
  assert.match(app, /acceptedRosterIntent\.value = null/);
  assert.doesNotMatch(acceptRosterIntent, /signAcceptedRosterIntent|submitTownshipCommand|syncOutbox/);
});

legacySourceLayoutTest("Vue signs accepted v4 roster requests locally while keeping outbox sync separate", () => {
  const app = readText("src/App.vue");
  const signStart = app.indexOf("async function signAcceptedRosterIntent");
  const signEnd = app.indexOf("function dismissAcceptedRosterIntent", signStart);
  const signRoster = app.slice(signStart, signEnd);
  const useDevStart = app.indexOf("async function usePendingRosterIntentFromDevTrace");
  const useDevEnd = app.indexOf("async function signAcceptedRosterIntentFromDevTrace", useDevStart);
  const useDev = app.slice(useDevStart, useDevEnd);
  const signDevStart = useDevEnd;
  const signDevEnd = app.indexOf("async function syncStatusIntentFromDevTrace", signDevStart);
  const signDev = app.slice(signDevStart, signDevEnd);
  const traceStart = app.indexOf("async function traceRosterIntentDevControl");
  const traceEnd = app.indexOf("async function tracePairingDeepLinkUrls", traceStart);
  const traceRoster = app.slice(traceStart, traceEnd);

  assert.ok(signStart >= 0 && signEnd > signStart);
  assert.ok(useDevStart >= 0 && useDevEnd > useDevStart);
  assert.ok(signDevStart >= 0 && signDevEnd > signDevStart);
  assert.ok(traceStart >= 0 && traceEnd > traceStart);
  assert.match(
    app,
    /const rosterIntentSubmitting = ref<TownshipRosterActionIntent\["command"\]\["command"\] \| null>\(null\)/,
  );
  assert.match(signRoster, /carrierPeer\.value\?\.replica !== intent\.replica[\s\S]*return/);
  assert.match(signRoster, /rosterIntentSubmitting\.value = intent\.command\.command/);
  assert.match(
    signRoster,
    /await submitTownshipCommand\(\{[\s\S]*command: intent\.command,[\s\S]*replica: intent\.replica/,
  );
  assert.match(signRoster, /rosterIntentSubmitting\.value = null/);
  assert.match(signRoster, /if \(submission\.ok\)[\s\S]*acceptedRosterIntent\.value = null/);
  assert.doesNotMatch(signRoster, /syncOutbox/);
  assert.match(app, /function rosterActionAllowed\(command: TownshipRosterActionIntent\["command"\]\["command"\]\): boolean/);
  assert.match(app, /function rosterIntentVerb\(intent: TownshipRosterActionIntent\): "admit" \| "remove member"/);
  assert.match(app, /@click="signAcceptedRosterIntent"/);
  assert.match(app, /Sign \$\{rosterIntentVerb\(acceptedRosterIntent\)\}/);
  assert.match(
    app,
    /:disabled="rosterIntentSubmitting !== null \|\| !rosterActionAllowed\(acceptedRosterIntent\.command\.command\)"/,
  );
  assert.match(app, /route === "action-roster\/use"/);
  assert.match(app, /route === "action-roster\/sign"/);
  assert.match(useDev, /intent\.v !== 4[\s\S]*acceptPendingActionIntent\(\)[\s\S]*acceptedRosterIntent\.value\?\.id === intent\.id/);
  assert.match(signDev, /rosterActionAllowed\(intent\.command\.command\)[\s\S]*await signAcceptedRosterIntent\(\)/);
  assert.match(app, /traceRosterIntentDevControl\("sync", syncStatus\.value\?\.ok \? "synced" : "failed"\)/);
  assert.match(traceRoster, /action-roster-dev-\$\{step\}:\$\{outcome\}/);
  assert.doesNotMatch(traceRoster, /\.member|intent|action URL|deep-link/);
});

legacySourceLayoutTest("Vue stages and accepts v5 grant requests inertly in an independent review state", () => {
  const app = readText("src/App.vue");
  const actionIntent = readText("src/township_action_intent.ts");
  const dispatcher = readText("src/township_deep_link_dispatcher.ts");
  const stageStart = app.indexOf("function stageActionIntent");
  const stageEnd = app.indexOf("function rejectActionIntent", stageStart);
  const stageIntent = app.slice(stageStart, stageEnd);
  const acceptStart = app.indexOf("function acceptPendingActionIntent");
  const acceptEnd = app.indexOf("function dismissPendingActionIntent", acceptStart);
  const acceptIntent = app.slice(acceptStart, acceptEnd);
  const grantAcceptStart = acceptIntent.indexOf("else if (intent.v === 5)");
  const grantAcceptEnd = acceptIntent.indexOf("} else {", grantAcceptStart);
  const acceptGrantIntent = acceptIntent.slice(grantAcceptStart, grantAcceptEnd);
  const labelStart = app.indexOf("function actionIntentLabel");
  const labelEnd = app.indexOf("function assertNeverActionIntent", labelStart);
  const label = app.slice(labelStart, labelEnd);

  assert.ok(stageStart >= 0 && stageEnd > stageStart);
  assert.ok(acceptStart >= 0 && acceptEnd > acceptStart);
  assert.ok(grantAcceptStart >= 0 && grantAcceptEnd > grantAcceptStart);
  assert.ok(labelStart >= 0 && labelEnd > labelStart);
  assert.match(
    actionIntent,
    /export type TownshipReviewableActionIntent =[^;]*TownshipGrantActionIntent/s,
  );
  assert.doesNotMatch(dispatcher, /parsed\.intent\.v === 5/);
  assert.match(app, /TownshipGrantActionIntent/);
  assert.match(app, /const acceptedGrantIntent = ref<TownshipGrantActionIntent \| null>\(null\)/);
  assert.match(stageIntent, /pendingActionIntent\.value = intent/);
  assert.doesNotMatch(stageIntent, /submitTownshipDelegation|syncOutbox|accepted\w+Intent\.value|Draft\.value/);
  assert.match(acceptGrantIntent, /acceptedGrantIntent\.value = intent/);
  assert.doesNotMatch(acceptGrantIntent, /submitTownshipDelegation|syncOutbox|grantAudienceDraft\.value/);
  assert.doesNotMatch(
    acceptGrantIntent,
    /accepted(?:Post|Status|Field|Roster)Intent\.value/,
  );
  assert.match(label, /intent\.v === 5[\s\S]*return "Grant access request"/);
  assert.match(app, /id="participant-grant-request"/);
  assert.match(app, /grantIntentFingerprint\(acceptedGrantIntent\)/);
  assert.match(app, /acceptedGrantIntent\.authority\.ops\.join\(", "\)/);
  assert.match(app, /acceptedGrantIntent\.authority\.roles\.length === 0/);
  assert.match(app, /acceptedGrantIntent\.authority\.live \? "Live" : "Offline"/);
});

legacySourceLayoutTest("Vue signs accepted v5 grants locally while keeping explicit Sync separate", () => {
  const app = readText("src/App.vue");
  const signStart = app.indexOf("async function signAcceptedGrantIntent");
  const signEnd = app.indexOf("function dismissAcceptedGrantIntent", signStart);
  const signGrant = app.slice(signStart, signEnd);
  const useDevStart = app.indexOf("async function usePendingGrantIntentFromDevTrace");
  const useDevEnd = app.indexOf("async function signAcceptedGrantIntentFromDevTrace", useDevStart);
  const useDev = app.slice(useDevStart, useDevEnd);
  const signDevStart = useDevEnd;
  const signDevEnd = app.indexOf("async function syncStatusIntentFromDevTrace", signDevStart);
  const signDev = app.slice(signDevStart, signDevEnd);
  const traceStart = app.indexOf("async function traceGrantIntentDevControl");
  const traceEnd = app.indexOf("async function tracePairingDeepLinkUrls", traceStart);
  const traceGrant = app.slice(traceStart, traceEnd);

  assert.ok(signStart >= 0 && signEnd > signStart);
  assert.ok(useDevStart >= 0 && useDevEnd > useDevStart);
  assert.ok(signDevStart >= 0 && signDevEnd > signDevStart);
  assert.ok(traceStart >= 0 && traceEnd > traceStart);
  assert.match(app, /const grantIntentSubmitting = ref\(false\)/);
  assert.match(signGrant, /carrierPeer\.value\?\.replica !== intent\.replica[\s\S]*return/);
  assert.match(signGrant, /grantIntentSubmitting\.value = true/);
  assert.match(
    signGrant,
    /await submitTownshipDelegation\(\{[\s\S]*audiencePubkey: intent\.authority\.audience,[\s\S]*ops: intent\.authority\.ops,[\s\S]*roles: intent\.authority\.roles,[\s\S]*live: intent\.authority\.live,[\s\S]*replica: intent\.replica/,
  );
  assert.match(signGrant, /grantIntentSubmitting\.value = false/);
  assert.match(signGrant, /if \(submission\.ok\)[\s\S]*acceptedGrantIntent\.value = null/);
  assert.doesNotMatch(signGrant, /syncOutbox/);
  assert.doesNotMatch(signGrant, /grantStatus\.value/);
  assert.match(app, /@click="signAcceptedGrantIntent"/);
  assert.match(app, />[\s\S]*Sign grant[\s\S]*<\/button>/);
  assert.match(app, /route === "action-grant\/use"/);
  assert.match(app, /route === "action-grant\/sign"/);
  assert.match(useDev, /intent\.v !== 5[\s\S]*acceptPendingActionIntent\(\)[\s\S]*acceptedGrantIntent\.value\?\.id === intent\.id/);
  assert.match(signDev, /await signAcceptedGrantIntent\(\)/);
  assert.match(app, /traceGrantIntentDevControl\("sync", syncStatus\.value\?\.ok \? "synced" : "failed"\)/);
  assert.match(traceGrant, /action-grant-dev-\$\{step\}:\$\{outcome\}/);
  assert.doesNotMatch(traceGrant, /\.audience|recipient|intent|action URL|deep-link/);
});

test("Vue traces rendered title, summary, and members only through SHA-256 commitments", () => {
  const app = readText("src/App.vue");
  const start = app.indexOf("async function traceRenderedTownshipFeed");
  const end = app.indexOf("async function digestTownshipTraceText", start);
  const traceFeed = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(app, /id="matter-title"/);
  assert.match(app, /id="matter-summary"/);
  assert.match(app, /id="township-roster"/);
  assert.match(traceFeed, /document\.querySelector\("#matter-title"\)/);
  assert.match(traceFeed, /document\.querySelector\("#matter-summary"\)/);
  assert.match(traceFeed, /document\.querySelectorAll\("#township-roster \.member-list li"\)/);
  assert.match(traceFeed, /titleDigest/);
  assert.match(traceFeed, /summaryDigest/);
  assert.match(traceFeed, /memberDigests/);
  assert.match(traceFeed, /digestTownshipTraceText/);
  assert.doesNotMatch(traceFeed, /\btitle:\s*titleText/);
  assert.doesNotMatch(traceFeed, /\bsummary:\s*summaryText/);
  assert.doesNotMatch(traceFeed, /\bmembers:\s*memberTexts/);
  assert.doesNotMatch(traceFeed, /memberTexts\s*[,}]/);
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

test("Vue persistence entry points guard async re-entry", () => {
  const app = readText("src/App.vue");
  const guardedEntries = [
    ["submitPost", "if (postSubmitting.value) return;", "postSubmitting.value = true;"],
    ["submitSummary", "if (summarySubmitting.value) return;", "summarySubmitting.value = true;"],
    ["submitMatterStatus", "if (statusSubmitting.value !== null) return;", "statusSubmitting.value = command;"],
    ["submitMemberCommand", "if (memberSubmitting.value !== null) return;", "memberSubmitting.value = command;"],
    ["submitGrant", "if (grantSubmitting.value) return;", "grantSubmitting.value = true;"],
    [
      "submitRevoke",
      "if (revokeSubmitting.value || revokeIntentSubmitting.value) return;",
      "revokeSubmitting.value = true;",
    ],
    ["syncOutbox", "if (syncSubmitting.value) return;", "syncSubmitting.value = true;"],
    ["submitPairing", "if (pairingSubmitting.value) return;", "pairingSubmitting.value = true;"],
  ];

  for (const [name, guard, firstEffect] of guardedEntries) {
    const entry = asyncFunctionSource(app, name);
    assert.ok(entry.includes(guard), `${name} should guard re-entry`);
    assert.ok(
      entry.indexOf(guard) < entry.indexOf(firstEffect),
      `${name} should guard before ${firstEffect}`,
    );
  }

  const releasingEntries = [
    ["submitPost", "postSubmitting.value = false;"],
    ["submitSummary", "summarySubmitting.value = false;"],
    ["submitMatterStatus", "statusSubmitting.value = null;"],
    ["submitMemberCommand", "memberSubmitting.value = null;"],
    ["submitGrant", "grantSubmitting.value = false;"],
    ["submitRevoke", "revokeSubmitting.value = false;"],
    ["syncOutbox", "syncSubmitting.value = false;"],
    ["submitPairing", "pairingSubmitting.value = false;"],
  ];

  for (const [name, release] of releasingEntries) {
    const entry = asyncFunctionSource(app, name);
    const finallyIndex = entry.lastIndexOf("finally {");
    assert.ok(finallyIndex > -1, `${name} should release its guard in finally`);
    assert.ok(entry.indexOf(release, finallyIndex) > finallyIndex, `${name} should run ${release} in finally`);
  }
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

test("witness review failures stay visible without invalidating an accepted review", () => {
  const app = readText("src/App.vue");
  const stageStart = app.indexOf("function stageActionIntent(");
  const stageEnd = app.indexOf("\nfunction rejectActionIntent", stageStart);
  const stage = app.slice(stageStart, stageEnd);
  const prepare = asyncFunctionSource(app, "prepareAcceptedWitnessIntent");

  assert.ok(stageStart > -1 && stageEnd > stageStart);
  assert.doesNotMatch(stage, /witnessReview\.value = null/);
  assert.match(app, /const witnessReviewStatus = ref<ActionIntentStatus \| null>\(null\)/);
  assert.match(prepare, /witnessReviewStatus\.value = \{ ok: false, message: loaded\.message \}/);
  assert.match(app, /v-if="witnessReviewStatus"/);
  assert.match(app, /\{\{ witnessReviewStatus\.message \}\}/);
});

test("every retained witness artifact can be selected for explicit export", () => {
  const app = readText("src/App.vue");
  const panelStart = app.indexOf('id="participant-witness-artifact"');
  const panelEnd = app.indexOf('<section class="compose-panel">', panelStart);
  const panel = app.slice(panelStart, panelEnd);

  assert.ok(panelStart > -1 && panelEnd > panelStart);
  assert.match(panel, /<select[\s\S]*v-model="selectedWitnessArtifactId"/);
  assert.match(panel, /v-for="artifact in storedWitnessArtifacts"/);
  assert.match(panel, /:value="artifact\.artifactId"/);
  assert.match(panel, /\{\{ artifact\.artifactId \}\}/);
  assert.match(panel, /@click="exportSelectedWitnessArtifact"/);
});
