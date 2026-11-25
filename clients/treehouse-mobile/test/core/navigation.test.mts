import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// M1a.7: the Expo Router skeleton. The reference is 07's file list and the SDK 58 Expo Router manual-install
// guide (custom entry: side effects first, `expo-router/entry` last; routes under src/app).

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = join(APP, "src");

test("the routes 07 lists exist and the M0 screen is gone", () => {
  for (const route of [
    "app/_layout.tsx",
    "app/(tabs)/_layout.tsx",
    "app/(tabs)/threads.tsx",
    "app/(tabs)/people.tsx",
    "app/(tabs)/group.tsx",
    "app/thread/[replica].tsx",
    "ui/SessionProvider.tsx",
    "ui/useReadModel.ts",
    "native/lifecycle.ts",
  ])
    assert.ok(existsSync(join(SRC, route)), `${route} exists`);
  assert.equal(existsSync(join(SRC, "App.tsx")), false, "src/App.tsx is deleted");
});

test("the entry installs the polyfills before Expo Router and package.json points at it", () => {
  const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as { main: string; dependencies: Record<string, string> };
  assert.equal(pkg.main, "index.ts");
  assert.ok(pkg.dependencies["expo-router"], "expo-router is a dependency");
  const entry = readFileSync(join(APP, "index.ts"), "utf8");
  const polyfills = entry.indexOf('import "./src/polyfills";');
  const router = entry.indexOf('import "expo-router/entry";');
  assert.ok(polyfills >= 0 && router > polyfills, "polyfills first, expo-router/entry last");
  assert.ok(!/registerRootComponent|src\/App/.test(entry), "no hand-registered root component");
});

test("useReadModel reads through useSyncExternalStore over the read model source", () => {
  const hook = readFileSync(join(SRC, "ui", "useReadModel.ts"), "utf8");
  assert.match(hook, /useSyncExternalStore/);
  assert.match(hook, /readModelSource/);
});

test("the dev self-check and the replica store check stay reachable, behind __DEV__", () => {
  const group = readFileSync(join(SRC, "app", "(tabs)", "group.tsx"), "utf8");
  assert.match(group, /Run Self-check/);
  assert.match(group, /Run replica store check/);
  assert.match(group, /__DEV__/);
  // The device check module is required only behind __DEV__ (Metro folds it out of a release bundle).
  assert.match(group, /__DEV__\s*\?\s*require\("\.\.\/\.\.\/native\/replica_store_device_check"\)/);
});

// Simulator stage 3 (iOS 26.5): with no header background set, the SDK 58 native stack uses the Liquid Glass
// system bar, which is translucent, so the thread screen drew its banner under the bar and the status bar. An
// explicit `headerTransparent: false` keeps the opaque-header top inset (react-native-screens 4.30
// `getSafeAreaEdges`). The back button read "(tabs)", the group's route name; it now names the Threads tab.
test("the thread screen sits below an opaque stack header and its back button names the Threads tab", () => {
  const root = readFileSync(join(SRC, "app", "_layout.tsx"), "utf8");
  assert.match(root, /<Stack\s+screenOptions=\{\{[^}]*headerTransparent:\s*false/);
  assert.match(root, /name="thread\/\[replica\]"[^>]*headerBackTitle:\s*tabs\.threads/);
});
