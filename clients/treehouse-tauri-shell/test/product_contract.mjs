import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
const manifest = JSON.parse(
  await readFile("../lattice-mobile-core/products.json", "utf8"),
).products.find((p) => p.product === "treehouse");
const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
assert.equal(config.identifier, manifest.appId);
assert.equal(config.productName, "Treehouse");
assert.equal(
  config.app.security.csp["connect-src"],
  "'self' ipc: http://ipc.localhost",
);
// Plan 181 5a: the dev-trace overlay is the only place a relay socket origin may be named. The
// ordinary connect-src above stays offline-only, and the overlay is a merge patch of connect-src alone.
const overlay = JSON.parse(
  await readFile("src-tauri/tauri.dev-trace.conf.json", "utf8"),
);
assert.deepEqual(Object.keys(overlay.app.security.csp), ["connect-src"]);
assert.equal(
  overlay.app.security.csp["connect-src"],
  "'self' ipc: http://ipc.localhost ws://127.0.0.1:*",
);
assert.deepEqual(Object.keys(overlay.app.security), ["csp"]);
assert.deepEqual(Object.keys(overlay.app), ["security"]);
const keyStore = await readFile("src-tauri/src/key_store.rs", "utf8");
assert(keyStore.includes(manifest.keyService));
async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else files.push(path);
  }
  return files;
}
// `websocket` is allowed only in the named TS files that import the carrier client. Everything else
// under src and src-tauri/src stays closed to it, and the other markers stay forbidden everywhere.
const carrierClientFiles = new Set([
  "src/treehouse_relay_client.ts",
  "src/treehouse_feed.ts",
  "src/treehouse_sync.ts",
]);
const forbiddenEverywhere =
  /insert_seeded_dev_key|import_seed|DEV_SEED|SEED_PHRASE|governance-test-presence|NativeCarrierPeer|discovery/i;
const forbiddenOutsideClient = /websocket/i;
const nativeFiles = await sourceFiles("src-tauri/src");
for (const file of [...(await sourceFiles("src")), ...nativeFiles]) {
  const text = await readFile(file, "utf8");
  assert(!forbiddenEverywhere.test(text), file);
  if (!carrierClientFiles.has(file)) {
    assert(!forbiddenOutsideClient.test(text), file);
  }
  // CD1 closure: the app never listens, binds or serves a carrier.
  if (file.startsWith("src-tauri/src/")) {
    assert(!/bind\(|TcpListener|UdpSocket|listen\(/.test(text), file);
    // std::env is permitted only in the cfg-gated dev_trace module.
    if (file !== "src-tauri/src/dev_trace.rs") {
      assert(!text.includes("std::env"), file);
    }
  }
}
const cargo = await readFile("src-tauri/Cargo.toml", "utf8");
assert(!/websocket/i.test(cargo));
for (const crate of [
  "tungstenite",
  "tokio-tungstenite",
  "axum",
  "hyper",
  "warp",
  "actix",
  "mdns",
  "zeroconf",
]) {
  assert(
    !new RegExp(`^\\s*${crate}\\s*=`, "m").test(cargo),
    `Cargo.toml must not depend on ${crate}`,
  );
}
// Every `mod dev_trace` declaration must sit directly behind the feature gate, and the module may
// not be declared anywhere but lib.rs.
{
  const lib = await readFile("src-tauri/src/lib.rs", "utf8");
  const declarations = [...lib.matchAll(/mod\s+dev_trace\s*;/g)];
  const gated = [
    ...lib.matchAll(/#\[cfg\(feature = "treehouse-dev-trace"\)\]\s*mod\s+dev_trace\s*;/g),
  ];
  assert.equal(declarations.length, gated.length, "dev_trace must be cfg-gated");
  if (nativeFiles.includes("src-tauri/src/dev_trace.rs")) {
    assert.equal(gated.length, 1, "dev_trace.rs requires one gated declaration");
  }
}
const registration = await readFile("src-tauri/src/lib.rs", "utf8");
assert.deepEqual(
  [...registration.matchAll(/#\[tauri::command\]\s*fn (\w+)/g)]
    .map((m) => m[1])
    .sort(),
  [
    "treehouse_commit",
    "treehouse_initialize_identity",
    "treehouse_load_draft",
    "treehouse_open",
    "treehouse_save_draft",
    "treehouse_sign_carrier",
  ].sort(),
);
const previewCommands = ["treehouse_open", "treehouse_initialize_identity", "treehouse_commit", "treehouse_load_draft", "treehouse_save_draft", "treehouse_sign_carrier"];
const witnessCommands = ["treehouse_witness_public_identity", "treehouse_witness_prepare_creation", "treehouse_witness_generate", "treehouse_witness_prove_binding", "treehouse_witness_cancel"];
const build = await readFile("src-tauri/build.rs", "utf8");
assert.deepEqual([...build.matchAll(/"(treehouse_\w+)"/g)].map(m => m[1]).sort(), [...previewCommands, ...witnessCommands].sort());
const previewCapability = JSON.parse(await readFile("src-tauri/capabilities/default.json", "utf8"));
const witnessCapability = JSON.parse(await readFile("src-tauri/capabilities/witness.json", "utf8"));
const permission = command => "allow-" + command.replaceAll("_", "-");
assert.deepEqual(previewCapability.permissions.slice().sort(), ["core:default", ...previewCommands.map(permission)].sort());
assert.deepEqual(witnessCapability.permissions.slice().sort(), witnessCommands.map(permission).sort());
assert.deepEqual(witnessCapability.webviews, ["main"]);
assert.equal(witnessCapability.windows, undefined);
assert.equal(witnessCapability.remote, undefined);
assert.equal(witnessCapability.local, true);
assert(registration.includes("witness_commands::recognizes_command"));
assert(registration.includes("witness_commands::handle(invoke)"));
assert(!registration.includes("std::env"));
console.log(
  "PASS isolated offline product, fixed key service and six preview commands plus five closed witness commands",
);
