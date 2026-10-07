import { readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Static packaged-bundle variant preflight (Plan 181 5b), modeled on the Township classifier.
 *
 * The dev-trace seam (fixed test key, isolated store directory, command trace) is compiled in only
 * under the `treehouse-dev-trace` cargo feature. Its three environment variable names are read at
 * runtime, so their literals survive release optimization and are absent from the ordinary build.
 * The carrier keyring service string is unconditional in every Treehouse build. Classifying the
 * declared CFBundleExecutable's bytes lets a harness fail fast on the wrong variant instead of
 * silently consuming a stale or ordinary bundle, and lets the ordinary CI job prove the seam is
 * compiled out.
 */
export type PackagedBundleVariant = "ordinary" | "dev_trace";

export const TREEHOUSE_BUNDLE_CONTROL_MARKER = "dev.treetop.lattice.treehouse.carrier";
export const TREEHOUSE_DEV_TRACE_MARKERS = [
  "TREEHOUSE_DEV_DATA_DIR",
  "TREEHOUSE_DEV_CARRIER_SEED",
  "TREEHOUSE_DEV_TRACE_FILE",
] as const;

const FAT_MACHO_MAGICS = [
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
  Buffer.from([0xbe, 0xba, 0xfe, 0xca]),
  Buffer.from([0xca, 0xfe, 0xba, 0xbf]),
  Buffer.from([0xbf, 0xba, 0xfe, 0xca]),
];

/** Classify raw executable bytes. Throws on anything that is not a recognizable Treehouse binary. */
export function classifyExecutableBytes(bytes: Buffer, label = "executable"): PackagedBundleVariant {
  if (FAT_MACHO_MAGICS.some((magic) => bytes.subarray(0, 4).equals(magic))) {
    throw new Error(
      `${label} is a universal (fat) Mach-O; per-slice classification is not supported`,
    );
  }
  if (!bytes.includes(Buffer.from(TREEHOUSE_BUNDLE_CONTROL_MARKER, "utf8"))) {
    throw new Error(`${label} is not a recognizable Treehouse executable: carrier keyring marker absent`);
  }
  const present = TREEHOUSE_DEV_TRACE_MARKERS.filter((marker) =>
    bytes.includes(Buffer.from(marker, "utf8")),
  );
  if (present.length === 0) return "ordinary";
  if (present.length === TREEHOUSE_DEV_TRACE_MARKERS.length) return "dev_trace";
  throw new Error(`${label} carries partial dev-trace markers (${present.join(", ")}); refusing to classify`);
}

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
  return classifyExecutableBytes(readFileSync(executablePath), `packaged executable ${declaredPath}`);
}

export function assertPackagedBundleVariant(
  appBundlePath: string,
  expected: PackagedBundleVariant,
): void {
  const actual = classifyPackagedBundleVariant(appBundlePath);
  if (actual !== expected) {
    throw new Error(
      `Treehouse.app at ${appBundlePath} is built as ${actual}, expected ${expected}; ` +
        `rebuild the required variant before running a no-build smoke against it`,
    );
  }
}
