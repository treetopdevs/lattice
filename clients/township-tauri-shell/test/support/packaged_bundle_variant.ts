import { readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Static packaged-bundle variant preflight.
 *
 * Every packaged smoke consumes one shared Township.app path, and no-build
 * smokes trust whatever variant a previous step left there. The deterministic
 * test-presence provider is compiled in only under the
 * `township-governance-test-presence` feature, whose trace literal is
 * runtime-reachable and therefore survives release optimization; the carrier
 * keyring service string is unconditional in every Township build. Classifying
 * the declared CFBundleExecutable's bytes against those two markers lets a
 * smoke fail fast on the wrong variant instead of silently consuming it.
 */
export type PackagedBundleVariant = "test_presence" | "dev_trace_only";

export const TOWNSHIP_BUNDLE_CONTROL_MARKER = "dev.treetop.lattice.township.carrier";
export const TOWNSHIP_BUNDLE_TEST_PRESENCE_MARKER = "governance-test-presence:authorized";

const FAT_MACHO_MAGICS = [
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
  Buffer.from([0xbe, 0xba, 0xfe, 0xca]),
  Buffer.from([0xca, 0xfe, 0xba, 0xbf]),
  Buffer.from([0xbf, 0xba, 0xfe, 0xca]),
];

export function classifyPackagedBundleVariant(appBundlePath: string): PackagedBundleVariant {
  const infoPlistPath = join(appBundlePath, "Contents", "Info.plist");
  let plist: string;
  try {
    plist = readFileSync(infoPlistPath, "utf8");
  } catch {
    throw new Error(`missing packaged Info.plist at ${infoPlistPath}`);
  }

  const declared = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
  if (declared === undefined || declared.length === 0) {
    throw new Error(`missing CFBundleExecutable declaration in ${infoPlistPath}`);
  }
  if (
    declared.includes("/") ||
    declared.includes("\\") ||
    declared === "." ||
    declared === ".." ||
    declared.includes("\0")
  ) {
    throw new Error(`unsafe CFBundleExecutable ${JSON.stringify(declared)} in ${infoPlistPath}`);
  }

  const bundleRoot = realpathSync(appBundlePath);
  const declaredPath = join(bundleRoot, "Contents", "MacOS", declared);
  let executablePath: string;
  try {
    executablePath = realpathSync(declaredPath);
  } catch {
    throw new Error(`missing packaged executable at ${declaredPath}`);
  }
  if (!executablePath.startsWith(bundleRoot + sep)) {
    throw new Error(
      `packaged executable ${declaredPath} resolves outside the packaged bundle: ${executablePath}`,
    );
  }

  const bytes = readFileSync(executablePath);
  if (FAT_MACHO_MAGICS.some((magic) => bytes.subarray(0, 4).equals(magic))) {
    throw new Error(
      `packaged executable ${declaredPath} is a universal (fat) Mach-O; per-slice classification is not supported`,
    );
  }

  if (!bytes.includes(Buffer.from(TOWNSHIP_BUNDLE_CONTROL_MARKER, "utf8"))) {
    throw new Error(
      `${declaredPath} is not a recognizable Township executable: carrier keyring marker absent`,
    );
  }

  return bytes.includes(Buffer.from(TOWNSHIP_BUNDLE_TEST_PRESENCE_MARKER, "utf8"))
    ? "test_presence"
    : "dev_trace_only";
}

export function assertPackagedBundleVariant(
  appBundlePath: string,
  expected: PackagedBundleVariant,
): void {
  const actual = classifyPackagedBundleVariant(appBundlePath);
  if (actual !== expected) {
    throw new Error(
      `Township.app at ${appBundlePath} is built as ${actual}, expected ${expected}; ` +
        `rebuild the required feature variant before running a no-build smoke against it`,
    );
  }
}
