import { type AuthorCarrierOpInput, type CarrierOpFrame } from "../../src/index";
/**
 * Test-only twin of `authorCarrierOp` that skips the plan 190 vocabulary refusal and the
 * row 286 encode depth cap, so adversarial fixtures can sign frames that name atoms outside
 * `WIRE_VOCABULARY` or nest past 64 containers. It is
 * built on the exported canonical encoders and is deliberately not exported from `src/`.
 */
export declare function authorCarrierOpUnchecked(input: AuthorCarrierOpInput): Promise<CarrierOpFrame>;
