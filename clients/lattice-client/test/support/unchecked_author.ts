import {
  canonicalBytesForCarrierOp,
  canonicalHash,
  type AuthorCarrierOpInput,
  type CarrierOpFrame,
} from "../../src/index";

/**
 * Test-only twin of `authorCarrierOp` that skips the plan 190 vocabulary refusal, so
 * adversarial fixtures can sign frames that name atoms outside `WIRE_VOCABULARY`. It is
 * built on the exported canonical encoders and is deliberately not exported from `src/`.
 */
export async function authorCarrierOpUnchecked(input: AuthorCarrierOpInput): Promise<CarrierOpFrame> {
  const unsignedFrame: CarrierOpFrame = {
    v: 1,
    id: "",
    replica: input.replica,
    author: Buffer.from(input.signer.publicKey).toString("base64"),
    deps: [...new Set(input.deps)].sort(),
    kind: input.kind,
    body: input.body,
    cap: input.cap,
    sig: "",
  };
  const canonicalBytes = canonicalBytesForCarrierOp(unsignedFrame);
  const id = await canonicalHash(canonicalBytes);
  const signature = await input.signer.sign(canonicalBytes);

  return { ...unsignedFrame, id, sig: Buffer.from(signature).toString("base64") };
}
