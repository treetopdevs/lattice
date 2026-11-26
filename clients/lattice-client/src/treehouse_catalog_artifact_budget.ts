// TS twin of Treehouse.CatalogArtifactBudget (rows 355, 525): CatalogTrust's retained-artifact budgets for an authoring
// preflight. CatalogTrust refuses retained evidence as control_history_limit over 1,024 artifacts, one artifact's JSON over
// CATALOG_ARTIFACT_BYTES, or more than 16 MiB of JSON in total; a drift test pins these against treehouse_catalog_trust.ts.
// Sizes are the compact JSON of an envelope's carrier term, the length the operator distribution emits. Non-claim: that is
// a lower bound, so a distributor's copy padded with whitespace may still exceed a verifier's budget.
import { CATALOG_ARTIFACT_BYTES } from "./treehouse_catalog_json";
import { catalogEnvelopeToCarrierTerm, catalogRotationEnvelopeToCarrierTerm } from "./treehouse_catalog_codec";

export { CATALOG_ARTIFACT_BYTES };
export const TREEHOUSE_CATALOG_MAX_ARTIFACTS = 1024;
export const TREEHOUSE_CATALOG_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const encoder = new TextEncoder();

// An envelope the codec cannot encode measures over the per-artifact limit, so the check fails closed.
function measure(term: unknown): number {
  return term === null ? CATALOG_ARTIFACT_BYTES + 1 : encoder.encode(JSON.stringify(term)).length;
}

/** Compact JSON length of a catalog envelope's carrier term. */
export function catalogEnvelopeJsonBytes(envelope: unknown): number {
  return measure(catalogEnvelopeToCarrierTerm(envelope));
}

/** Compact JSON length of a rotation envelope's carrier term. */
export function catalogRotationEnvelopeJsonBytes(envelope: unknown): number {
  return measure(catalogRotationEnvelopeToCarrierTerm(envelope));
}

/** Refuses a size list CatalogTrust would refuse: count, per-artifact or total. */
export function checkCatalogArtifactBudget(sizes: readonly number[]): "control_history_limit" | null {
  if (sizes.length > TREEHOUSE_CATALOG_MAX_ARTIFACTS) return "control_history_limit";
  let total = 0;
  for (const size of sizes) {
    if (size > CATALOG_ARTIFACT_BYTES) return "control_history_limit";
    total += size;
  }
  return total > TREEHOUSE_CATALOG_MAX_TOTAL_BYTES ? "control_history_limit" : null;
}
