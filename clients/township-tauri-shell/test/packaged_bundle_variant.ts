import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPackagedBundleVariant,
  classifyPackagedBundleVariant,
  TOWNSHIP_BUNDLE_CONTROL_MARKER,
  TOWNSHIP_BUNDLE_TEST_PRESENCE_MARKER,
} from "./support/packaged_bundle_variant";

console.log("\n▸ Township packaged bundle variant classifier");

const tempRoot = mkdtempSync(join(tmpdir(), "township-bundle-variant-"));

interface SyntheticBundleOptions {
  declaredExecutable?: string | null;
  executables?: Record<string, Buffer>;
  omitInfoPlist?: boolean;
  omitMacosDir?: boolean;
}

function markerBinary(markers: string[]): Buffer {
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
      declared === null ? "" : `  <key>CFBundleExecutable</key>\n  <string>${declared ?? "township-tauri-shell"}</string>\n`;
    writeFileSync(
      join(contentsDir, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${executableEntry}  <key>CFBundleIdentifier</key>\n  <string>dev.treetop.lattice.township</string>\n</dict>\n</plist>\n`,
    );
  }

  for (const [executable, bytes] of Object.entries(options.executables ?? {})) {
    writeFileSync(join(macosDir, executable), bytes);
  }

  return bundlePath;
}

try {
  assert.equal(TOWNSHIP_BUNDLE_CONTROL_MARKER, "dev.treetop.lattice.township.carrier");
  assert.equal(TOWNSHIP_BUNDLE_TEST_PRESENCE_MARKER, "governance-test-presence:authorized");

  const testPresenceBundle = syntheticBundle("test-presence", {
    executables: {
      "township-tauri-shell": markerBinary([
        TOWNSHIP_BUNDLE_CONTROL_MARKER,
        TOWNSHIP_BUNDLE_TEST_PRESENCE_MARKER,
      ]),
    },
  });
  assert.equal(classifyPackagedBundleVariant(testPresenceBundle), "test_presence");

  const devTraceBundle = syntheticBundle("dev-trace", {
    executables: { "township-tauri-shell": markerBinary([TOWNSHIP_BUNDLE_CONTROL_MARKER]) },
  });
  assert.equal(classifyPackagedBundleVariant(devTraceBundle), "dev_trace_only");

  const helperBundle = syntheticBundle("helper-noise", {
    executables: {
      "township-tauri-shell": markerBinary([TOWNSHIP_BUNDLE_CONTROL_MARKER]),
      helper: markerBinary([
        TOWNSHIP_BUNDLE_CONTROL_MARKER,
        TOWNSHIP_BUNDLE_TEST_PRESENCE_MARKER,
      ]),
    },
  });
  assert.equal(
    classifyPackagedBundleVariant(helperBundle),
    "dev_trace_only",
    "only the declared CFBundleExecutable decides the variant, never a helper binary",
  );

  const unrecognizableBundle = syntheticBundle("unrecognizable", {
    executables: {
      "township-tauri-shell": markerBinary([TOWNSHIP_BUNDLE_TEST_PRESENCE_MARKER]),
    },
  });
  assert.throws(
    () => classifyPackagedBundleVariant(unrecognizableBundle),
    /not a recognizable Township executable/,
    "a binary without the unconditional carrier marker must not be classified",
  );

  const emptyMarkerBundle = syntheticBundle("markerless", {
    executables: { "township-tauri-shell": markerBinary([]) },
  });
  assert.throws(
    () => classifyPackagedBundleVariant(emptyMarkerBundle),
    /not a recognizable Township executable/,
  );

  assert.throws(
    () => classifyPackagedBundleVariant(join(tempRoot, "absent.app")),
    /missing packaged Info\.plist/,
    "a missing bundle must fail closed",
  );

  const plistlessBundle = syntheticBundle("plistless", {
    omitInfoPlist: true,
    executables: { "township-tauri-shell": markerBinary([TOWNSHIP_BUNDLE_CONTROL_MARKER]) },
  });
  assert.throws(() => classifyPackagedBundleVariant(plistlessBundle), /missing packaged Info\.plist/);

  const undeclaredBundle = syntheticBundle("undeclared", {
    declaredExecutable: null,
    executables: { "township-tauri-shell": markerBinary([TOWNSHIP_BUNDLE_CONTROL_MARKER]) },
  });
  assert.throws(
    () => classifyPackagedBundleVariant(undeclaredBundle),
    /missing CFBundleExecutable/,
    "an Info.plist without a declared executable must fail closed",
  );

  const traversalBundle = syntheticBundle("traversal", {
    declaredExecutable: "../outside",
    executables: { "township-tauri-shell": markerBinary([TOWNSHIP_BUNDLE_CONTROL_MARKER]) },
  });
  assert.throws(
    () => classifyPackagedBundleVariant(traversalBundle),
    /unsafe CFBundleExecutable/,
    "separators or traversal in the declared executable must fail closed",
  );

  const missingExecutableBundle = syntheticBundle("missing-exe", {
    declaredExecutable: "township-tauri-shell",
    executables: {},
  });
  assert.throws(
    () => classifyPackagedBundleVariant(missingExecutableBundle),
    /missing packaged executable/,
    "a declared but absent executable must fail closed",
  );

  const fatHeader = Buffer.concat([
    Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    markerBinary([TOWNSHIP_BUNDLE_CONTROL_MARKER, TOWNSHIP_BUNDLE_TEST_PRESENCE_MARKER]),
  ]);
  const fatBundle = syntheticBundle("fat", {
    executables: { "township-tauri-shell": fatHeader },
  });
  assert.throws(
    () => classifyPackagedBundleVariant(fatBundle),
    /universal \(fat\) Mach-O/,
    "fat binaries must fail closed until per-slice classification exists",
  );

  const bundleSymlink = join(tempRoot, "linked.app");
  symlinkSync(testPresenceBundle, bundleSymlink);
  assert.equal(
    classifyPackagedBundleVariant(bundleSymlink),
    "test_presence",
    "a symlinked bundle path is accepted after canonical resolution",
  );

  const outsideTarget = join(tempRoot, "outside-binary");
  writeFileSync(
    outsideTarget,
    markerBinary([TOWNSHIP_BUNDLE_CONTROL_MARKER, TOWNSHIP_BUNDLE_TEST_PRESENCE_MARKER]),
  );
  const escapeBundle = syntheticBundle("escape", { executables: {} });
  symlinkSync(outsideTarget, join(escapeBundle, "Contents", "MacOS", "township-tauri-shell"));
  assert.throws(
    () => classifyPackagedBundleVariant(escapeBundle),
    /resolves outside the packaged bundle/,
    "an executable symlink escaping the bundle must fail closed",
  );

  assertPackagedBundleVariant(testPresenceBundle, "test_presence");
  assert.throws(
    () => assertPackagedBundleVariant(testPresenceBundle, "dev_trace_only"),
    /built as test_presence/,
    "a variant mismatch must name the actual variant",
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("✓ Township packaged bundle variant classifier checks passed");
