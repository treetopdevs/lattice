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
