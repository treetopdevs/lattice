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
for (const file of [
  ...(await sourceFiles("src")),
  ...(await sourceFiles("src-tauri/src")),
]) {
  const text = await readFile(file, "utf8");
  assert(
    !/insert_seeded_dev_key|import_seed|DEV_SEED|SEED_PHRASE|governance-test-presence|NativeCarrierPeer|discovery|websocket/i.test(
      text,
    ),
    file,
  );
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
assert(!registration.includes("std::env"));
console.log(
  "PASS isolated offline product, fixed key service and exact six public native commands",
);
