import { resolve } from "node:path";
import {
  assertPackagedBundleVariant,
  type PackagedBundleVariant,
} from "./support/packaged_bundle_variant";

// CI entrypoint for the packaged bundle classifier (Plan 181 5c2). The ordinary packaged_macos job runs it
// on the real ordinary Treehouse bundle to prove the dev-trace seam is compiled out of it:
//   tsx test/assert_bundle_variant.ts <path/to/Treehouse.app> ordinary|dev_trace
const [bundle, expected] = process.argv.slice(2);
if (!bundle || (expected !== "ordinary" && expected !== "dev_trace")) {
  console.error("usage: assert_bundle_variant.ts <Treehouse.app> ordinary|dev_trace");
  process.exit(2);
}
try {
  assertPackagedBundleVariant(resolve(bundle), expected as PackagedBundleVariant);
  console.log(`PASS ${bundle} classifies as the ${expected} variant`);
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
