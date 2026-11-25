import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// M1a.1: the dependency rule from 03. The session layer runs in plain Node and under Hermes, so it
// imports no React, React Native, Expo or native adapter; screens reach lattice-client only through
// the session. A static scan of every import and require specifier.

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = join(APP, "src");

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts)$/.test(name) ? [path] : [];
  });
}

/** Every module specifier in `import ... from`, `export ... from`, `import(...)` and `require(...)`. */
function specifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];
  const patterns = [
    /\b(?:import|export)\s[^'";]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.push(match[1]!);
  return found;
}

test("session layer imports no react, react-native, expo or native modules", () => {
  const files = sourceFiles(join(SRC, "session"));
  assert.ok(files.length > 0, "src/session has source files to scan");
  const native = join(SRC, "native");
  const offenders: string[] = [];
  for (const file of files)
    for (const spec of specifiers(file)) {
      const framework = /^(react|react-native|expo)($|[/-])/.test(spec) || spec.startsWith("@expo/");
      const intoNative = spec.startsWith(".") && resolve(dirname(file), spec).startsWith(native);
      const nodeOnly = spec.startsWith("node:");
      if (framework || intoNative || nodeOnly) offenders.push(`${relative(APP, file)} -> ${spec}`);
    }
  assert.deepEqual(offenders, []);
});

test("ui and route layers do not import lattice-client", () => {
  // src/App.tsx is the M0 screen until Expo Router lands (M1a.7); it is the ui layer today.
  const files = [...sourceFiles(join(SRC, "app")), ...sourceFiles(join(SRC, "ui")), join(SRC, "App.tsx")].filter(existsSync);
  assert.ok(files.length > 0, "there is a ui layer to scan");
  const offenders = files.flatMap((file) =>
    specifiers(file)
      .filter((spec) => spec === "@treetopdevs/lattice-client" || spec.startsWith("@treetopdevs/lattice-client/"))
      .map((spec) => `${relative(APP, file)} -> ${spec}`),
  );
  assert.deepEqual(offenders, []);
});
