import { resolve } from "node:path";
import {
  assertPackagedBundleVariant,
  type PackagedBundleVariant,
} from "./support/packaged_bundle_variant";
import { assertFrontendDistVariant, FRONTEND_VARIANT_FOR_BUNDLE } from "./support/frontend_variant";

// CI entrypoint for the packaged bundle classifier (Plan 181 5c2, row 201). It asserts both the executable
// variant and the paired frontend dist variant:
//   tsx test/assert_bundle_variant.ts <path/to/Treehouse.app> ordinary|dev_trace <distDir>
const [bundle, expected, dist] = process.argv.slice(2);
if (!bundle || (expected !== "ordinary" && expected !== "dev_trace") || !dist) {
  console.error("usage: assert_bundle_variant.ts <Treehouse.app> ordinary|dev_trace <distDir>");
  process.exit(2);
}
try {
  assertPackagedBundleVariant(resolve(bundle), expected as PackagedBundleVariant);
  console.log(`PASS ${bundle} classifies as the ${expected} variant`);
  const frontend = FRONTEND_VARIANT_FOR_BUNDLE[expected as PackagedBundleVariant];
  assertFrontendDistVariant(resolve(dist), frontend);
  console.log(`PASS ${dist} classifies as the ${frontend} frontend variant`);
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
