import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createAxDriver, PACKAGED_ACCESSIBILITY_SWIFT, readKv } from "@treetopdevs/lattice-shell-kit/testing/packaged";
import type { AxDriver } from "@treetopdevs/lattice-shell-kit/testing/packaged";
import { parseState } from "../src/treehouse_state";
import { treehouseCatalogBootstrapsFromFrames } from "@treetopdevs/lattice-client";
import { assertPackagedBundleVariant } from "./support/packaged_bundle_variant";

// Host-level isolation only, no app seam or seeded key. Refuse real user accounts.
assert(process.platform === "darwin" && process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted",
  "This gate changes disposable runner Keychain preferences and refuses local/self-hosted accounts");
const root = realpathSync(mkdtempSync(join(tmpdir(), "treehouse-ordinary-offline-"))); chmodSync(root, 0o700);
const evidence = process.env.TREEHOUSE_EVIDENCE_DIR ?? join(root, "public-evidence"); mkdirSync(evidence, { recursive: true });
const bundle = resolve("src-tauri/target/release/bundle/macos/Treehouse.app"); assertPackagedBundleVariant(bundle, "ordinary");
const binary = join(bundle, "Contents/MacOS/treehouse-tauri-shell");
const helper = join(root, "accessibility"); execFileSync("swiftc", [PACKAGED_ACCESSIBILITY_SWIFT, "-o", helper]);
const security = (...args: string[]) => {
  try { return execFileSync("security", args, { encoding: "utf8" }).trim(); }
  catch { throw new Error(`OS Keychain operation failed: ${args[0]}`); }
};
const quotedPaths = (text: string) => [...text.matchAll(/"([^"]+)"/g)].map(match => match[1]!);
const priorDefault = quotedPaths(security("default-keychain", "-d", "user"))[0]!;
const priorSearch = quotedPaths(security("list-keychains", "-d", "user")); assert(priorDefault && priorSearch.length);
const joinHome = join(root, "joiner-home"); mkdirSync(joinHome, { mode: 0o700 }); mkdirSync(join(joinHome, "Downloads"));
const joinKeychain = join(root, "joiner.keychain-db"); const password = randomBytes(32).toString("base64");
let child: ChildProcess | null = null; let ax: AxDriver | null = null;
const driver = () => { assert(ax, "app must be launched before UI actions"); return ax; };
const logs: string[] = [];
const database = (home: string) => join(home, "Library/Application Support/dev.treetop.lattice.treehouse/treehouse-v1.sqlite3");
const state = (home: string) => {
  const record = readKv(database(home)).find(row => row.key === "treehouse:preview:history")?.value;
  assert(record); return parseState(record);
};
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const proc = child; const done = new Promise<void>(resolve => proc.once("exit", () => resolve()));
  proc.kill("SIGTERM"); const timer = setTimeout(() => proc.kill("SIGKILL"), 10000); await done; clearTimeout(timer); child = null;
}
async function launch(home: string) {
  await stop();
  const env = { ...process.env, HOME: home, CFFIXED_USER_HOME: home };
  for (const key of Object.keys(env)) if (key.startsWith("TREEHOUSE_DEV_")) delete env[key as keyof typeof env];
  child = spawn(binary, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", data => logs.push(String(data))); child.stderr!.on("data", data => logs.push(String(data)));
  ax = createAxDriver({ attempts: 150, exec: (args, input) => execFileSync(helper, [String(child!.pid), ...args], { input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }) });
}
async function save(name: string, outputName: string, action: string) {
  const path = join(homedir(), "Downloads", outputName);
  assert(!existsSync(path), "a packaged export must create a fresh file, never reuse prior evidence");
  await driver().put(name, outputName); await driver().press(action);
  await driver().waitFor(`file ${outputName}`, () => existsSync(path)); return path;
}
const tag = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
try {
  const founder = state(homedir()); assert(founder.publicKey && founder.profiles.length === 2);
  assert.equal(founder.relay, null);
  const space = founder.profiles.find(profile => profile.product === "Treehouse.Space")!;
  const bootstraps = await treehouseCatalogBootstrapsFromFrames({ replica: space.replica, frames: space.frames });
  assert(bootstraps.ok && bootstraps.bootstraps.length === 1);
  const expectedFingerprint = createHash("sha256").update(JSON.stringify([
    "treehouse-offline-group-fingerprint-v1", space.replica, founder.publicKey, bootstraps.bootstraps[0]!.id,
  ])).digest("hex").match(/.{4}/g)!.join(" ");
  security("create-keychain", "-p", password, joinKeychain);
  security("unlock-keychain", "-p", password, joinKeychain);
  security("set-keychain-settings", "-lut", "21600", joinKeychain);
  security("list-keychains", "-d", "user", "-s", joinKeychain);
  security("default-keychain", "-d", "user", "-s", joinKeychain);
  assert(!existsSync(database(joinHome)), "joiner must start without injected history");
  await launch(joinHome); await driver().press("I want this app to join an existing group."); await driver().press("Prepare join request");
  const request = await driver().readWhenPresent("Your join request");
  const joiner = state(joinHome); assert(joiner.publicKey && joiner.publicKey !== founder.publicKey);
  assert.equal(joiner.profiles.length, 0); await stop();
  security("list-keychains", "-d", "user", "-s", ...priorSearch);
  security("default-keychain", "-d", "user", "-s", priorDefault);
  await launch(homedir());
  await driver().put("Person's join request", request); await driver().press("Review recipient key");
  await driver().waitFor("recipient key", nodes => nodes.some(node => node.value.includes(joiner.publicKey!) || node.title.includes(joiner.publicKey!)));
  await driver().press("I compared this key with the person through a separate channel."); await driver().press("Sign invitation");
  const invitationPath = await save("Invitation file name", `th-${tag}-offline-invitation.json`, "Save invitation file");
  const invitation = readFileSync(invitationPath, "utf8"); writeFileSync(join(evidence, "invitation.json"), invitation);
  await stop();
  security("list-keychains", "-d", "user", "-s", joinKeychain); security("default-keychain", "-d", "user", "-s", joinKeychain);
  await launch(joinHome); assert.equal(state(joinHome).publicKey, joiner.publicKey, "ordinary restart retains its Keychain identity");
  await driver().press("Open invitation file"); execFileSync(helper, [String(child!.pid), "choose-file", invitationPath]);
  await driver().waitFor("group review", nodes => nodes.some(node => node.title === "Review offline invitation" || node.description === "Review offline invitation"));
  await driver().press("Cancel"); assert.equal(state(joinHome).profiles.length, 0);
  await driver().press("Open invitation file"); execFileSync(helper, [String(child!.pid), "choose-file", invitationPath]);
  await driver().waitFor("fingerprint matches independent founder history", nodes => nodes.some(node => [node.value, node.title, node.description].some(text => text.includes(expectedFingerprint))));
  await driver().put("Fingerprint received from the founder", expectedFingerprint); await driver().press("Sign acceptance");
  const acceptance = await driver().readWhenPresent("Signed acceptance");
  assert.equal(state(joinHome).profiles.length, 0); assert.equal(state(joinHome).relay, null); await stop();
  security("list-keychains", "-d", "user", "-s", ...priorSearch); security("default-keychain", "-d", "user", "-s", priorDefault);
  await launch(homedir()); assert.equal(state(homedir()).publicKey, founder.publicKey);
  await driver().put("Person's signed acceptance", acceptance); await driver().press("Admit and grant Thread access");
  const path = await save("Operator bundle file name", `th-${tag}-initial.json`, "Save initial operator bundle");
  const bytes = readFileSync(path, "utf8"); writeFileSync(join(evidence, "initial-bundle.json"), bytes);
  const doc = JSON.parse(bytes); assert.equal(doc.format, "treehouse-initial-provisioning-v1");
  const before = JSON.stringify(state(homedir())); await driver().press("Admit and grant Thread access");
  assert.equal(JSON.stringify(state(homedir())), before, "acceptance replay does not add operations");
  await stop(); await launch(homedir()); assert.equal(state(homedir()).publicKey, founder.publicKey);
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ status: "PASS", variant: "ordinary", founder: founder.publicKey, joiner: joiner.publicKey,
    identitySource: "independent OS Keychain contexts; no injected seeds", profilesInstalledOnJoiner: 0, relayConfigured: false }, null, 2));
} finally {
  await stop(); security("list-keychains", "-d", "user", "-s", ...priorSearch); security("default-keychain", "-d", "user", "-s", priorDefault);
  if (existsSync(joinKeychain)) security("delete-keychain", joinKeychain);
  writeFileSync(join(evidence, "app.log"), logs.join(""));
}
