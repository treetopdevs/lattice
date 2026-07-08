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
  assert.equal(pkg.scripts.typecheck, "vue-tsc --noEmit");
  assert.equal(pkg.scripts["frontend:contract"], "node --test test/frontend_shell.mjs");
  assert.equal(pkg.dependencies["@treetopdevs/lattice-client"], "file:../lattice-client");
  assert.match(pkg.dependencies.vue, /^\^3\.5\./);
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
    "npm run action:contract && npm run sync:contract && npm run live:contract && npm run tauri:launch:smoke",
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
  assert.match(sync, /export async function syncTownshipOutbox/);
  assert.match(sync, /peer\?: TownshipCarrierPeerConfig/);
  assert.match(app, /syncTownshipOutbox/);
  assert.match(app, /townshipCarrierPeerFromEnv\(\)/);
  assert.match(app, /syncStatus/);
  assert.match(app, /Sync outbox/);
});

test("Vue source supports smoke-only auto-sync from Vite env", () => {
  const app = readText("src/App.vue");
  const env = readText("src/env.d.ts");

  assert.match(env, /VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT/);
  assert.match(app, /autosyncOnMount/);
  assert.match(app, /VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT/);
  assert.match(app, /if \(autosyncOnMount && carrierPeer\) await syncOutbox\(\)/);
});
