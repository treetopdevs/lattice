import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const shellRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(shellRoot, "../..");
const readText = (root, path) => readFileSync(join(root, path), "utf8");
const readJson = (root, path) => JSON.parse(readText(root, path));

test("Tauri serves the Vue build and registers the Township deep-link scheme", () => {
  const config = readJson(shellRoot, "src-tauri/tauri.conf.json");

  assert.deepEqual(config.build, {
    beforeBuildCommand: "npm run build",
    beforeDevCommand: "npm run dev",
    devUrl: "http://localhost:5173",
    frontendDist: "../dist",
  });
  assert.deepEqual(config.plugins["deep-link"].desktop.schemes, ["township"]);
  assert.deepEqual(config.plugins["deep-link"].mobile, [{ scheme: ["township"], appLink: false }]);
});

test("the shell exposes every packaged action gate in convergence order", () => {
  const scripts = readJson(shellRoot, "package.json").scripts;

  assert.equal(scripts["runtime:wiring:contract"], "node --test test/runtime_wiring_contract.mjs");
  assert.equal(scripts["governance:native:contract"], "tsx test/governance_witness_native.ts");
  assert.equal(scripts["action-handoff-support:contract"], "tsx test/packaged_action_handoff_support.ts");
  assert.equal(
    scripts["intent-ui:contract"],
    "vitest run test/use_action_intent.test.ts test/IntentReviewPanel.test.ts",
  );
  assert.equal(scripts["tauri:action-handoff:smoke"], "tsx test/tauri_action_handoff_smoke.ts");
  assert.equal(scripts["tauri:clerk-action-handoff:smoke"], "tsx test/tauri_clerk_action_handoff_smoke.ts");
  assert.equal(scripts["tauri:field-action-handoff:smoke"], "tsx test/tauri_field_action_handoff_smoke.ts");
  assert.equal(scripts["tauri:roster-action-handoff:smoke"], "tsx test/tauri_roster_action_handoff_smoke.ts");
  assert.equal(
    scripts["tauri:delegation-grant-handoff:smoke"],
    "tsx test/tauri_delegation_grant_handoff_smoke.ts",
  );
  assert.equal(
    scripts["tauri:revocation-action-handoff:smoke"],
    "tsx test/tauri_revoke_access_handoff_smoke.ts",
  );

  const convergence = scripts["app:convergence"];
  const orderedGates = [
    "runtime:wiring:contract",
    "governance:native:contract",
    "intent-ui:contract",
    "action-handoff-support:contract",
    "tauri:action-handoff:smoke",
    "tauri:clerk-action-handoff:smoke",
    "tauri:field-action-handoff:smoke",
    "tauri:roster-action-handoff:smoke",
    "tauri:delegation-grant-handoff:smoke",
    "tauri:revocation-action-handoff:smoke",
    "tauri:feed:smoke",
  ];
  const offsets = orderedGates.map((gate) => convergence.indexOf(gate));
  assert.ok(offsets.every((offset) => offset >= 0));
  assert.deepEqual(offsets, [...offsets].sort((left, right) => left - right));
});

test("the release feature and hosted workflow retain the executable gates", () => {
  const cargo = readText(shellRoot, "src-tauri/Cargo.toml");
  const workflow = readText(repoRoot, ".github/workflows/flagship.yml");
  const rootScripts = readJson(repoRoot, "package.json").scripts;

  assert.match(cargo, /\[features\]\s+township-dev-trace = \[\]/);
  assert.equal(rootScripts["township:instrument:e2e"], "npx --no-install playwright test --config playwright.township.config.mjs");
  assert.equal(rootScripts["township:instrument:live-e2e"], "npx --no-install playwright test --config playwright.township-live.config.mjs");
  assert.equal(rootScripts["township:instrument:server-e2e"], "npx --no-install playwright test --config playwright.township-server.config.mjs");
  assert.equal(rootScripts["township:action-handoff:e2e"], "scripts/township_action_handoff_e2e.sh");

  for (const gate of [
    "npm run typecheck",
    "npm run runtime:wiring:contract",
    "npm run governance:native:contract",
    "npm run intent-ui:contract",
    "npm run action-handoff-support:contract",
    "npm run action-intent:contract",
    "npm run deeplink:dispatcher:contract",
    "npm run action:contract",
    "npm run frontend:contract",
    "npm run tauri:action-handoff:smoke",
    "npm run tauri:clerk-action-handoff:smoke",
    "npm run tauri:field-action-handoff:smoke",
    "npm run tauri:roster-action-handoff:smoke",
    "npm run tauri:delegation-grant-handoff:smoke",
    "npm run tauri:revocation-action-handoff:smoke",
  ]) {
    assert.ok(workflow.includes(gate), `flagship workflow must run ${gate}`);
  }

  const packagedMacos = workflow.slice(workflow.indexOf("packaged_macos:"));
  assert.match(
    packagedMacos,
    /^        working-directory: clients\/township-tauri-shell\/src-tauri\n        run: cargo test --test governance_release_binding$/m,
  );
});
