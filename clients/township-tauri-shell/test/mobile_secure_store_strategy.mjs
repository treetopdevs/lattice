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

test("mobile secure-store strategy keeps secrets behind native signers", () => {
  const strategyPath = "docs/township_mobile_secure_store_strategy.md";
  assert.ok(existsSync(join(repoRoot, strategyPath)), "strategy document should exist");

  const strategy = readText(strategyPath);
  const nativeWorkflow = readText("clients/township-tauri-shell/src/native_workflow.ts");
  const tauriLib = readText("clients/township-tauri-shell/src-tauri/src/lib.rs");
  const cargo = readText("clients/township-tauri-shell/src-tauri/Cargo.toml");
  const identity = readText("clients/lattice-client/src/identity.ts");
  const localLog = readText("clients/lattice-client/src/local_log.ts");

  assert.match(strategy, /^# Township Mobile Secure-Store Strategy/m);
  assert.match(strategy, /Secret material/);
  assert.match(strategy, /Replayable state/);
  assert.match(strategy, /CarrierKeySeedStore/);
  assert.match(strategy, /lattice_sign_carrier/);
  assert.match(strategy, /TownshipNativeState::platform_secure/);
  assert.match(strategy, /expo-secure-store/);
  assert.match(strategy, /Android Keystore/);
  assert.match(strategy, /iOS Keychain/);
  assert.match(strategy, /local_ops/);
  assert.match(strategy, /carrier_frames/);
  assert.match(strategy, /delegation_frames/);
  assert.match(strategy, /not secrets/);
  assert.match(strategy, /No phone-grade persistence claim/);

  assert.match(tauriLib, /trait CarrierKeySeedStore/);
  assert.match(tauriLib, /struct KeyringCarrierKeySeedStore/);
  assert.match(tauriLib, /TownshipNativeState::platform_secure/);
  assert.match(tauriLib, /fn lattice_sign_carrier/);
  assert.match(cargo, /keyring = "4"/);
  assert.match(nativeWorkflow, /TOWNSHIP_LOCAL_OP_LOG_KEY = "local_ops"/);
  assert.match(nativeWorkflow, /TOWNSHIP_CARRIER_OUTBOX_KEY = "carrier_frames"/);
  assert.match(nativeWorkflow, /TOWNSHIP_DELEGATION_FRAMES_KEY = "delegation_frames"/);
  assert.match(identity, /expo-secure-store/);
  assert.match(identity, /native module fronting iOS Secure Enclave \/ Android Keystore/);
  assert.match(localLog, /interface LocalKeyValueStore/);
});
