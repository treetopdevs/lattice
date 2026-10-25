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
import { carrierOpsToSemanticOps, observeTreehouse, treehouseCommandDecoders, treehouseCatalogBootstrapsFromFrames } from "@treetopdevs/lattice-client";
import { assertPackagedBundleVariant } from "./support/packaged_bundle_variant";

// Host-level isolation only, no app seam or seeded key. Refuse real user accounts.
assert(process.platform === "darwin" && process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted",
  "This gate changes disposable runner Keychain preferences and refuses local/self-hosted accounts");
const root = realpathSync(mkdtempSync(join(tmpdir(), "treehouse-ordinary-offline-"))); chmodSync(root, 0o700);
const evidence = process.env.TREEHOUSE_EVIDENCE_DIR ?? join(root, "public-evidence"); mkdirSync(evidence, { recursive: true });
const bundle = resolve("src-tauri/target/release/bundle/macos/Treehouse.app"); assertPackagedBundleVariant(bundle, "ordinary");
const binary = join(bundle, "Contents/MacOS/treehouse-tauri-shell");
const helper = join(root, "accessibility"); execFileSync("swiftc", [PACKAGED_ACCESSIBILITY_SWIFT, "-o", helper]);
const platformEnv = (home: string): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, CFFIXED_USER_HOME: home });
const securityAt = (home: string, ...args: string[]) => {
  try { return execFileSync("security", args, { env: platformEnv(home), encoding: "utf8" }).trim(); }
  catch { throw new Error(`OS Keychain operation failed: ${args[0]}`); }
};
const security = (...args: string[]) => securityAt(homedir(), ...args);
const quotedPaths = (text: string) => [...text.matchAll(/"([^"]+)"/g)].map(match => match[1]!);
const priorDefault = quotedPaths(security("default-keychain", "-d", "user"))[0]!;
const priorSearch = quotedPaths(security("list-keychains", "-d", "user")); assert(priorDefault && priorSearch.length);
const joinHome = join(root, "joiner-home"); mkdirSync(joinHome, { mode: 0o700 }); mkdirSync(join(joinHome, "Downloads"));
mkdirSync(join(joinHome, "Library/Preferences"), { recursive: true, mode: 0o700 });
mkdirSync(join(joinHome, "Library/Keychains"), { recursive: true, mode: 0o700 });
const joinSecurity = (...args: string[]) => securityAt(joinHome, ...args);
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
  const env = platformEnv(home);
  for (const key of Object.keys(env)) if (key.startsWith("TREEHOUSE_DEV_")) delete env[key];
  child = spawn(binary, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", data => logs.push(String(data))); child.stderr!.on("data", data => logs.push(String(data)));
  ax = createAxDriver({ attempts: 150, exec: (args, input) => execFileSync(helper, [String(child!.pid), ...args], { input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }) });
}
async function waitText(text: string) {
  await driver().waitFor(text, nodes => nodes.some(node => [node.value, node.title, node.description].some(value => value.includes(text))));
}
async function save(name: string, outputName: string, action: string) {
  const path = join(homedir(), "Downloads", outputName);
  assert(!existsSync(path), "a packaged export must create a fresh file, never reuse prior evidence");
  await driver().put(name, outputName); await driver().press(action);
  await waitText(path);
  assert(existsSync(path)); return path;
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
  joinSecurity("create-keychain", "-p", password, joinKeychain);
  joinSecurity("unlock-keychain", "-p", password, joinKeychain);
  joinSecurity("set-keychain-settings", "-lut", "21600", joinKeychain);
  joinSecurity("list-keychains", "-d", "user", "-s", joinKeychain);
  joinSecurity("default-keychain", "-d", "user", "-s", joinKeychain);
  assert.deepEqual(quotedPaths(joinSecurity("default-keychain", "-d", "user")), [joinKeychain], "app and security CLI use the same isolated-home preference domain");
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
  const displayedFingerprint = await driver().readWhenPresent("Group fingerprint to share");
  assert.equal(displayedFingerprint, expectedFingerprint, "founder's displayed code matches independent retained history");
  await driver().press("I compared this key with the person through a separate channel."); await driver().press("Sign invitation");
  const invitationPath = await save("Invitation file name", `th-${tag}-offline-invitation.json`, "Save invitation file");
  const invitation = readFileSync(invitationPath, "utf8"); writeFileSync(join(evidence, "invitation.json"), invitation);
  await stop();
  joinSecurity("list-keychains", "-d", "user", "-s", joinKeychain); joinSecurity("default-keychain", "-d", "user", "-s", joinKeychain);
  await launch(joinHome); assert.equal(state(joinHome).publicKey, joiner.publicKey, "ordinary restart retains its Keychain identity");
  await driver().press("Open invitation file");
  await driver().waitFor("native Open panel", nodes => nodes.some(node => node.role === "AXWindow" && node.title === "Open"));
  execFileSync(helper, [String(child!.pid), "choose-file", invitationPath]);
  await driver().press("Open");
  await driver().waitFor("group review", nodes => nodes.some(node => node.title === "Review offline invitation" || node.description === "Review offline invitation"));
  await driver().press("Cancel"); assert.equal(state(joinHome).profiles.length, 0);
  await driver().press("Open invitation file");
  await driver().waitFor("native Open panel", nodes => nodes.some(node => node.role === "AXWindow" && node.title === "Open"));
  execFileSync(helper, [String(child!.pid), "choose-file", invitationPath]);
  await driver().press("Open");
  const beforeWrongCode = JSON.stringify(state(joinHome));
  const wrongCode = (displayedFingerprint[0] === "0" ? "1" : "0") + displayedFingerprint.slice(1);
  await driver().put("Fingerprint received from the founder", wrongCode); await driver().press("Sign acceptance");
  await waitText("That fingerprint does not match this group.");
  assert.equal(JSON.stringify(state(joinHome)), beforeWrongCode);
  assert(!(await driver().dump()).some(node => node.title === "Signed acceptance" || node.description === "Signed acceptance"));
  await driver().put("Fingerprint received from the founder", displayedFingerprint); await driver().press("Sign acceptance");
  const acceptance = await driver().readWhenPresent("Signed acceptance");
  assert.equal(state(joinHome).profiles.length, 0); assert.equal(state(joinHome).relay, null); await stop();
  security("list-keychains", "-d", "user", "-s", ...priorSearch); security("default-keychain", "-d", "user", "-s", priorDefault);
  await launch(homedir()); assert.equal(state(homedir()).publicKey, founder.publicKey);
  await driver().put("Person's signed acceptance", acceptance); await driver().press("Admit and grant Thread access");
  await waitText("Admission and Thread permissions saved together.");
  const afterAdmission = state(homedir());
  const admittedSpace = afterAdmission.profiles.find(profile => profile.product === "Treehouse.Space")!;
  const members = observeTreehouse("Treehouse.Space", carrierOpsToSemanticOps(admittedSpace.frames, {}, treehouseCommandDecoders("Treehouse.Space"))).state.members as string[];
  assert.deepEqual([...members].sort(), [founder.publicKey, joiner.publicKey].sort());
  const childGrants = (frames: typeof space.frames) => carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Thread")).filter(op => op.authority?.type === "grant").length;
  assert.equal(childGrants(afterAdmission.profiles.find(profile => profile.product === "Treehouse.Thread")!.frames),
    childGrants(founder.profiles.find(profile => profile.product === "Treehouse.Thread")!.frames) + 1);
  const path = await save("Operator bundle file name", `th-${tag}-initial.json`, "Save initial operator bundle");
  const bytes = readFileSync(path, "utf8"); writeFileSync(join(evidence, "initial-bundle.json"), bytes);
  const doc = JSON.parse(bytes); assert.equal(doc.format, "treehouse-initial-provisioning-v1");
  const before = JSON.stringify(state(homedir())); await driver().press("Admit and grant Thread access");
  await waitText("This acceptance is already admitted with its Thread permissions.");
  assert.equal(JSON.stringify(state(homedir())), before, "acceptance replay does not add operations");
  await stop(); await launch(homedir()); assert.equal(state(homedir()).publicKey, founder.publicKey);
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ status: "PASS", variant: "ordinary", founder: founder.publicKey, joiner: joiner.publicKey,
    identitySource: "independent OS Keychain contexts; no injected seeds", profilesInstalledOnJoiner: 0, relayConfigured: false }, null, 2));
} catch (error) {
  // Capture observed UI before stopping the app; never guess an AX label or replace native state.
  const currentProcess = (() : ChildProcess | null => child)();
  if (ax && currentProcess && currentProcess.exitCode === null && currentProcess.signalCode === null) {
    try { writeFileSync(join(evidence, "failed-ui.json"), JSON.stringify(await driver().dump(), null, 2)); } catch {}
  }
  const summaries = [homedir(), joinHome].map(home => {
    try {
      const saved = state(home);
      return { home, publicKey: saved.publicKey, profiles: saved.profiles.map(profile => ({ product: profile.product, replica: profile.replica, frames: profile.frames.length })),
        intent: saved.intent?.kind ?? null, relayConfigured: saved.relay !== null };
    } catch { return { home, readableSavedHistory: false }; }
  });
  writeFileSync(join(evidence, "failure-summary.json"), JSON.stringify(summaries, null, 2));
  throw error;
} finally {
  const failures: unknown[] = [];
  for (const cleanup of [
    async () => stop(),
    async () => { security("list-keychains", "-d", "user", "-s", ...priorSearch); },
    async () => { security("default-keychain", "-d", "user", "-s", priorDefault); },
    async () => { if (existsSync(joinKeychain)) joinSecurity("delete-keychain", joinKeychain); },
    async () => { writeFileSync(join(evidence, "app.log"), logs.join("")); },
  ]) { try { await cleanup(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, "Packaged-test cleanup failed; every restoration was attempted");
}
