import { createBundleVariantClassifier } from "@treetopdevs/lattice-shell-kit/testing/packaged";
import type { PackagedBundleVariant } from "@treetopdevs/lattice-shell-kit/testing/packaged";

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
export type { PackagedBundleVariant };

export const TREEHOUSE_BUNDLE_CONTROL_MARKER = "dev.treetop.lattice.treehouse.carrier";
export const TREEHOUSE_DEV_TRACE_MARKERS = [
  "TREEHOUSE_DEV_DATA_DIR",
  "TREEHOUSE_DEV_CARRIER_SEED",
  "TREEHOUSE_DEV_TRACE_FILE",
] as const;

const classifier = createBundleVariantClassifier({
  productName: "Treehouse",
  controlMarker: TREEHOUSE_BUNDLE_CONTROL_MARKER,
  controlMarkerName: "carrier keyring marker",
  devTraceMarkers: TREEHOUSE_DEV_TRACE_MARKERS,
});

/** Classify raw executable bytes. Throws on anything that is not a recognizable Treehouse binary. */
export function classifyExecutableBytes(bytes: Buffer, label?: string): PackagedBundleVariant {
  return classifier.classifyExecutableBytes(bytes, label);
}

export function classifyPackagedBundleVariant(appBundlePath: string): PackagedBundleVariant {
  return classifier.classifyPackagedBundleVariant(appBundlePath);
}

export function assertPackagedBundleVariant(appBundlePath: string, expected: PackagedBundleVariant): void {
  classifier.assertPackagedBundleVariant(appBundlePath, expected);
}
