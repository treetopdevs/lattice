import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// M1a.6 (covers M0.2 and the rest of M0.3): the demo fence, the trust card and the no relay access
// state. References: the import graph for the fence, the approved hosting sentence in 01 for the trust
// card, and the local BEAM relay's own admission for the refused route (it refuses any key it was not
// told to admit, as the demo relay refused the device key in M0.3).

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = join(APP, "src");
const DEMO = join(SRC, "demo");
const DOCS = resolve(APP, "../../docs/treehouse-mobile");

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts)$/.test(name) ? [path] : [];
  });
}

/** Runtime module specifiers: `import ... from` (not `import type`), side-effect imports, import() and require(). */
function runtimeSpecifiers(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bimport\s+(?!type\b)[^'";]*?\bfrom\s*["']([^"']+)["']/g,
    /\bexport\s+(?!type\b)[^'";]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.push(match[1]!);
  return found;
}

function allSpecifiers(text: string): string[] {
  const found = runtimeSpecifiers(text);
  for (const match of text.matchAll(/\b(?:import|export)\s+type\b[^'";]*?\bfrom\s*["']([^"']+)["']/g)) found.push(match[1]!);
  return found;
}

const intoDemo = (file: string, spec: string) => spec.startsWith(".") && resolve(dirname(file), spec).startsWith(DEMO);

test("session and ui import nothing from src/demo", () => {
  // Every layer except the composition root (App.tsx until M1a.7) and the demo itself. Type-only imports
  // count too: a session or ui type that names a demo type ties the layer to the demo.
  const layers = ["session", "ui", "lib", "native", "local", "app"].flatMap((dir) => sourceFiles(join(SRC, dir)));
  const files = [...layers, join(SRC, "polyfills.ts"), join(APP, "index.ts")].filter(existsSync);
  assert.ok(files.some((f) => f.includes(`${join("src", "session")}`)), "src/session has files to scan");
  const offenders = files.flatMap((file) =>
    allSpecifiers(readFileSync(file, "utf8"))
      .filter((spec) => intoDemo(file, spec))
      .map((spec) => `${relative(APP, file)} -> ${spec}`),
  );
  assert.deepEqual(offenders, []);
});

test("the composition root reaches src/demo only behind __DEV__ or EXPO_PUBLIC_TREEHOUSE_DEMO=1", () => {
  const file = join(SRC, "App.tsx");
  const text = readFileSync(file, "utf8");
  // The gate itself: the flag must be read by dot notation so Metro inlines it (SDK 58 env-var guide).
  assert.match(text, /const DEMO_ENABLED = __DEV__ \|\| process\.env\.EXPO_PUBLIC_TREEHOUSE_DEMO === "1";/);
  // No static runtime import of the demo: a release bundle without the flag never evaluates it.
  const staticImports = [...text.matchAll(/\bimport\s+(?!type\b)[^'";]*?\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]!);
  assert.deepEqual(staticImports.filter((spec) => intoDemo(file, spec)), []);
  const demoRequires = [...text.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)].filter((m) => intoDemo(file, m[1]!));
  assert.ok(demoRequires.length > 0, "the demo is wired through a guarded require");
  // Every demo require sits inside the one `DEMO_ENABLED ? { ... } : null` expression.
  const guard = /DEMO_ENABLED\s*\?\s*\{([\s\S]*?)\}\s*:\s*null/.exec(text);
  assert.ok(guard, "the demo modules are loaded by `DEMO_ENABLED ? { ... } : null`");
  const start = guard.index;
  const end = guard.index + guard[0].length;
  for (const m of demoRequires) assert.ok(m.index! > start && m.index! < end, `require(${m[1]}) is inside the guard`);
});

test("the demo bar states that demo keys are public, so anyone can post as them", async () => {
  const { DEMO_KEYS_PUBLIC, DEMO_ROLES } = await import("../../src/demo/identities");
  assert.match(DEMO_KEYS_PUBLIC, /public/i);
  assert.match(DEMO_KEYS_PUBLIC, /anyone can post as/i);
  assert.ok(readFileSync(join(DEMO, "DemoBar.tsx"), "utf8").includes("DEMO_KEYS_PUBLIC"), "DemoBar renders the notice");
  // The Keychain mode is gone from the switcher: only the public demo identities remain.
  assert.deepEqual([...DEMO_ROLES], ["founder", "neighbor"]);
  assert.ok(!/Keychain/.test(readFileSync(join(DEMO, "DemoBar.tsx"), "utf8")));
  assert.ok(!/Keychain/.test(readFileSync(join(SRC, "App.tsx"), "utf8")));
});

test("trust card text equals the approved hosting sentence", async () => {
  const { HOSTING_SENTENCE } = await import("../../src/ui/trust_card");
  // The reference is 01's "Hosting sentence (the one approved form)" block quote, not the app's copy.
  const doc = readFileSync(join(DOCS, "01-ubiquitous-language.md"), "utf8");
  const section = doc.split("## Hosting sentence (the one approved form)")[1]!;
  const quote = section
    .split("\n")
    .filter((line) => line.startsWith(">"))
    .map((line) => line.replace(/^>\s?/, "").trim())
    .join(" ")
    .trim();
  assert.ok(quote.length > 0, "01 has the approved block quote");
  assert.equal(HOSTING_SENTENCE, quote);
  // The M0 card omitted the reader; the App must render the approved constant and drop the old copy.
  const app = readFileSync(join(SRC, "App.tsx"), "utf8");
  assert.ok(app.includes("HOSTING_SENTENCE"), "App renders the approved sentence");
  assert.ok(!app.includes("holds a plaintext copy"), "the M0 trust-card copy is gone");
});

test("a refused space route yields the no relay access status", async (t) => {
  const { relayAccess, NO_RELAY_ACCESS } = await import("../../src/ui/trust_card");
  const { createTreehouseSession, createFeedRelayLink } = await import("../../src/session/session");
  const { MemoryReplicaStore, MemoryReplicaDisk } = await import("../../src/session/memory/replica_store");
  const { MemoryKeyCustody } = await import("../../src/session/memory/key_custody");
  const { ManualClock } = await import("../../src/session/memory/clock");
  const { buildGroup, testIdentity } = await import("../support/group_fixture");
  const { startLocalRelay } = await import("../support/local_relay");

  const group = await buildGroup({ members: 1 });
  const relay = await startLocalRelay(group, [group.admin]);
  t.after(() => relay.kill());

  async function sessionFor(identity: { realm: string; signer: Parameters<typeof MemoryKeyCustody.holding>[0] }) {
    const store = new MemoryReplicaStore(new MemoryReplicaDisk(), new ManualClock(1_000));
    await store.open();
    await store.adopt(group.space.replica, "Treehouse.Space");
    await store.adopt(group.thread.replica, "Treehouse.Thread");
    let link: ReturnType<typeof createFeedRelayLink> | null = null;
    const session = createTreehouseSession({
      custody: MemoryKeyCustody.holding(identity.signer),
      store,
      clock: new ManualClock(2_000),
      link: (host) => (link = createFeedRelayLink(host, { pollMs: 0 })),
    });
    await session.open();
    t.after(() => session.close());
    await link!.configure({ localRealm: identity.realm, routes: relay.routes });
    await link!.start();
    await link!.syncNow();
    return session;
  }

  // Before any dial the status is not a refusal.
  assert.notEqual(relayAccess({ configured: false, routes: [] }, group.space.replica), "no_relay_access");

  // A key the relay was not told to admit (as the device key in M0.3): the relay refuses its hello.
  const stranger = await sessionFor(testIdentity("mobile-device"));
  const strangerLink = stranger.read().link;
  assert.equal(strangerLink.routes.find((r) => r.replica === group.space.replica)?.connection, "refused");
  assert.equal(relayAccess(strangerLink, group.space.replica), "no_relay_access");
  assert.match(NO_RELAY_ACCESS, /relay does not know this phone yet/i);

  // The admitted admin on the same relay is not refused, so the status follows the relay, not the app.
  const admin = await sessionFor(group.admin);
  assert.equal(relayAccess(admin.read().link, group.space.replica), "admitted");
});

test("a launch whose held history fails verification shows history_invalid and does not go online", async () => {
  const { HISTORY_INVALID } = await import("../../src/ui/trust_card");
  // The reference is 04's error table row for history_invalid.
  const row = readFileSync(join(DOCS, "04-screens-and-flows.md"), "utf8")
    .split("\n")
    .find((line) => line.startsWith("| `history_invalid` |"))!;
  assert.ok(row.includes(`"${HISTORY_INVALID}"`), "the notice is 04's wording");
  // App.tsx reads the verify-on-open result after session.open() and returns before host.goOnline().
  const app = readFileSync(join(SRC, "App.tsx"), "utf8");
  const connect = app.slice(app.indexOf("await session.open();"));
  const check = connect.indexOf("session.read().history");
  const online = connect.indexOf("await host.goOnline();");
  assert.ok(check > 0 && check < online, "history is checked before going online");
  assert.match(connect.slice(check, online), /HISTORY_INVALID[\s\S]*return;/);
  // The manual toggle may not go online over history that failed, and the pill is inert without a group.
  assert.match(app, /!host\.isOnline\(\) && sessionRef\.current\?\.read\(\)\.history\.ok === false\) return;/);
  assert.match(app, /disabled=\{!demo\}/);
});
