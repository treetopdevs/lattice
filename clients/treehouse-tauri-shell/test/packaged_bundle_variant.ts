import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPackagedBundleVariant,
  classifyExecutableBytes,
  classifyPackagedBundleVariant,
  TREEHOUSE_BUNDLE_CONTROL_MARKER,
  TREEHOUSE_DEV_TRACE_MARKERS,
} from "./support/packaged_bundle_variant";

console.log("\n▸ Treehouse packaged bundle variant classifier");

const tempRoot = mkdtempSync(join(tmpdir(), "treehouse-bundle-variant-"));

interface SyntheticBundleOptions {
  declaredExecutable?: string | null;
  executables?: Record<string, Buffer>;
  omitInfoPlist?: boolean;
  omitMacosDir?: boolean;
}

function markerBinary(markers: readonly string[]): Buffer {
  const filler = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0xed, 0xfa, 0xce, 0x00]);
  return Buffer.concat([filler, ...markers.map((marker) => Buffer.from(` ${marker} `, "utf8")), filler]);
}

function syntheticBundle(name: string, options: SyntheticBundleOptions): string {
  const bundlePath = join(tempRoot, `${name}.app`);
  const contentsDir = join(bundlePath, "Contents");
  const macosDir = join(contentsDir, "MacOS");
  mkdirSync(options.omitMacosDir ? contentsDir : macosDir, { recursive: true });
  if (!options.omitInfoPlist) {
    const declared = options.declaredExecutable;
    const executableEntry =
      declared === null ? "" : `  <key>CFBundleExecutable</key>\n  <string>${declared ?? "treehouse-tauri-shell"}</string>\n`;
    writeFileSync(
      join(contentsDir, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${executableEntry}  <key>CFBundleIdentifier</key>\n  <string>dev.treetop.lattice.treehouse</string>\n</dict>\n</plist>\n`,
    );
  }
  for (const [executable, bytes] of Object.entries(options.executables ?? {})) {
    writeFileSync(join(macosDir, executable), bytes);
  }
  return bundlePath;
}

try {
  assert.equal(TREEHOUSE_BUNDLE_CONTROL_MARKER, "dev.treetop.lattice.treehouse.carrier");
  assert.deepEqual([...TREEHOUSE_DEV_TRACE_MARKERS], [
    "TREEHOUSE_DEV_DATA_DIR",
    "TREEHOUSE_DEV_CARRIER_SEED",
    "TREEHOUSE_DEV_TRACE_FILE",
  ]);

  const ordinary = syntheticBundle("ordinary", {
    executables: { "treehouse-tauri-shell": markerBinary([TREEHOUSE_BUNDLE_CONTROL_MARKER]) },
  });
  assert.equal(classifyPackagedBundleVariant(ordinary), "ordinary");

  const variant = syntheticBundle("variant", {
    executables: {
      "treehouse-tauri-shell": markerBinary([TREEHOUSE_BUNDLE_CONTROL_MARKER, ...TREEHOUSE_DEV_TRACE_MARKERS]),
    },
  });
  assert.equal(classifyPackagedBundleVariant(variant), "dev_trace");

  // A partial marker set is neither variant: fail closed rather than guess.
  for (const marker of TREEHOUSE_DEV_TRACE_MARKERS) {
    const partial = syntheticBundle(`partial-${marker}`, {
      executables: { "treehouse-tauri-shell": markerBinary([TREEHOUSE_BUNDLE_CONTROL_MARKER, marker]) },
    });
    assert.throws(() => classifyPackagedBundleVariant(partial), /partial dev-trace markers/, marker);
  }

  // Only the declared executable decides the variant, never a helper.
  const helperNoise = syntheticBundle("helper-noise", {
    executables: {
      "treehouse-tauri-shell": markerBinary([TREEHOUSE_BUNDLE_CONTROL_MARKER]),
      helper: markerBinary([TREEHOUSE_BUNDLE_CONTROL_MARKER, ...TREEHOUSE_DEV_TRACE_MARKERS]),
    },
  });
  assert.equal(classifyPackagedBundleVariant(helperNoise), "ordinary");

  // A Township binary (or any binary without the Treehouse control marker) is not classified.
  const township = syntheticBundle("township", {
    executables: {
      "treehouse-tauri-shell": markerBinary(["dev.treetop.lattice.township.carrier", ...TREEHOUSE_DEV_TRACE_MARKERS]),
    },
  });
  assert.throws(() => classifyPackagedBundleVariant(township), /not a recognizable Treehouse executable/);
  const markerless = syntheticBundle("markerless", {
    executables: { "treehouse-tauri-shell": markerBinary([]) },
  });
  assert.throws(() => classifyPackagedBundleVariant(markerless), /not a recognizable Treehouse executable/);

  assert.throws(() => classifyPackagedBundleVariant(join(tempRoot, "absent.app")), /missing packaged Info\.plist/);
  const plistless = syntheticBundle("plistless", {
    omitInfoPlist: true,
    executables: { "treehouse-tauri-shell": markerBinary([TREEHOUSE_BUNDLE_CONTROL_MARKER]) },
  });
  assert.throws(() => classifyPackagedBundleVariant(plistless), /missing packaged Info\.plist/);
  const undeclared = syntheticBundle("undeclared", {
    declaredExecutable: null,
    executables: { "treehouse-tauri-shell": markerBinary([TREEHOUSE_BUNDLE_CONTROL_MARKER]) },
  });
  assert.throws(() => classifyPackagedBundleVariant(undeclared), /missing CFBundleExecutable/);
  const traversal = syntheticBundle("traversal", {
    declaredExecutable: "../outside",
    executables: { "treehouse-tauri-shell": markerBinary([TREEHOUSE_BUNDLE_CONTROL_MARKER]) },
  });
  assert.throws(() => classifyPackagedBundleVariant(traversal), /unsafe CFBundleExecutable/);
  const missingExecutable = syntheticBundle("missing-exe", { executables: {} });
  assert.throws(() => classifyPackagedBundleVariant(missingExecutable), /missing packaged executable/);

  const fat = syntheticBundle("fat", {
    executables: {
      "treehouse-tauri-shell": Buffer.concat([
        Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
        markerBinary([TREEHOUSE_BUNDLE_CONTROL_MARKER]),
      ]),
    },
  });
  assert.throws(() => classifyPackagedBundleVariant(fat), /universal \(fat\) Mach-O/);

  const outsideTarget = join(tempRoot, "outside-binary");
  writeFileSync(outsideTarget, markerBinary([TREEHOUSE_BUNDLE_CONTROL_MARKER, ...TREEHOUSE_DEV_TRACE_MARKERS]));
  const escape = syntheticBundle("escape", { executables: {} });
  symlinkSync(outsideTarget, join(escape, "Contents", "MacOS", "treehouse-tauri-shell"));
  assert.throws(() => classifyPackagedBundleVariant(escape), /resolves outside the packaged bundle/);

  const linked = join(tempRoot, "linked.app");
  symlinkSync(variant, linked);
  assert.equal(classifyPackagedBundleVariant(linked), "dev_trace", "a symlinked bundle path resolves first");

  // The byte classifier is what a raw cargo binary scan uses.
  assert.equal(classifyExecutableBytes(markerBinary([TREEHOUSE_BUNDLE_CONTROL_MARKER])), "ordinary");
  assert.equal(
    classifyExecutableBytes(markerBinary([TREEHOUSE_BUNDLE_CONTROL_MARKER, ...TREEHOUSE_DEV_TRACE_MARKERS])),
    "dev_trace",
  );

  assertPackagedBundleVariant(ordinary, "ordinary");
  assertPackagedBundleVariant(variant, "dev_trace");
  assert.throws(() => assertPackagedBundleVariant(ordinary, "dev_trace"), /built as ordinary, expected dev_trace/);
  assert.throws(() => assertPackagedBundleVariant(variant, "ordinary"), /built as dev_trace, expected ordinary/);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("✓ Treehouse packaged bundle variant classifier checks passed");
