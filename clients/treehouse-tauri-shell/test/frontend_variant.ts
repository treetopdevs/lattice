import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertFrontendDistVariant,
  classifyFrontendDist,
  FRONTEND_VARIANT_FOR_BUNDLE,
  TREEHOUSE_ENROLLMENT_FRONTEND_MARKER,
} from "./support/frontend_variant";

console.log("\n▸ Treehouse frontend variant classifier and flag gate");

const tempRoot = mkdtempSync(join(tmpdir(), "treehouse-frontend-variant-"));
const FLAGS = ["VITE_TREEHOUSE_ENROLLMENT", "VITE_TREEHOUSE_DEV_TRACE"] as const;

function synthetic(name: string, files: Record<string, string>): string {
  const dir = join(tempRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

function viteBuild(name: string, flags: Partial<Record<(typeof FLAGS)[number], string>>) {
  const outDir = join(tempRoot, name);
  const env = { ...process.env };
  for (const flag of FLAGS) delete env[flag];
  Object.assign(env, flags);
  const result = spawnSync(
    "node_modules/.bin/vite",
    ["build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"],
    { env, encoding: "utf8" },
  );
  return { outDir, status: result.status, output: `${result.stdout}${result.stderr}` };
}

try {
  // 1. Classifier over synthetic dists.
  const plain = synthetic("plain", { "index.html": "<html></html>", "assets/app.js": "console.log(1)" });
  const marked = synthetic("marked", {
    "index.html": "<html></html>",
    "assets/panel-abc.js": `x("${TREEHOUSE_ENROLLMENT_FRONTEND_MARKER}")`,
  });
  assert.equal(classifyFrontendDist(plain), "ordinary");
  assert.equal(classifyFrontendDist(marked), "enrollment");
  assertFrontendDistVariant(plain, "ordinary");
  assertFrontendDistVariant(marked, "enrollment");
  assert.throws(() => assertFrontendDistVariant(plain, "enrollment"), /classifies as ordinary, expected enrollment/);
  assert.throws(() => assertFrontendDistVariant(marked, "ordinary"), /classifies as enrollment, expected ordinary/);
  assert.equal(FRONTEND_VARIANT_FOR_BUNDLE.ordinary, "ordinary");
  assert.equal(FRONTEND_VARIANT_FOR_BUNDLE.dev_trace, "enrollment");

  assert.throws(() => classifyFrontendDist(join(tempRoot, "absent")), /missing/);
  mkdirSync(join(tempRoot, "empty"));
  assert.throws(() => classifyFrontendDist(join(tempRoot, "empty")), /empty/);
  const noIndex = synthetic("no-index", { "assets/app.js": "1" });
  assert.throws(() => classifyFrontendDist(noIndex), /no index\.html/);

  const outside = synthetic("outside", { "secret.js": TREEHOUSE_ENROLLMENT_FRONTEND_MARKER });
  const escaping = synthetic("escaping", { "index.html": "<html></html>" });
  symlinkSync(join(outside, "secret.js"), join(escaping, "link.js"));
  assert.throws(() => classifyFrontendDist(escaping), /symlink escaping/);

  // 2. Real Vite builds in both variants.
  const ordinary = viteBuild("real-ordinary", {});
  assert.equal(ordinary.status, 0, ordinary.output);
  assert.equal(classifyFrontendDist(ordinary.outDir), "ordinary");
  const enrollment = viteBuild("real-enrollment", { VITE_TREEHOUSE_ENROLLMENT: "1", VITE_TREEHOUSE_DEV_TRACE: "1" });
  assert.equal(enrollment.status, 0, enrollment.output);
  assert.equal(classifyFrontendDist(enrollment.outDir), "enrollment");

  // 3. Mismatched or non-"1" flags refuse the build and name both flags.
  const refused: Array<[string, Partial<Record<(typeof FLAGS)[number], string>>]> = [
    ["only-enrollment", { VITE_TREEHOUSE_ENROLLMENT: "1" }],
    ["only-dev-trace", { VITE_TREEHOUSE_DEV_TRACE: "1" }],
    ["true-enrollment", { VITE_TREEHOUSE_ENROLLMENT: "true", VITE_TREEHOUSE_DEV_TRACE: "1" }],
    ["true-dev-trace", { VITE_TREEHOUSE_ENROLLMENT: "1", VITE_TREEHOUSE_DEV_TRACE: "true" }],
    ["zero-both", { VITE_TREEHOUSE_ENROLLMENT: "0", VITE_TREEHOUSE_DEV_TRACE: "0" }],
    ["empty-one", { VITE_TREEHOUSE_ENROLLMENT: "" }],
  ];
  for (const [name, flags] of refused) {
    const result = viteBuild(`refused-${name}`, flags);
    assert.notEqual(result.status, 0, `${name}: build should have been refused`);
    for (const flag of FLAGS) assert.ok(result.output.includes(flag), `${name}: message must name ${flag}`);
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("✓ Treehouse frontend variant checks passed");
