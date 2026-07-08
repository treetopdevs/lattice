export type Author = string;
export interface Signer {
    /** The public author id this signer speaks for. */
    author(): Author;
    /** Sign canonical op bytes; returns the signature (raw 64 bytes). */
    sign(canonicalBytes: Uint8Array): Promise<Uint8Array>;
}
export interface Verifier {
    verify(author: Author, canonicalBytes: Uint8Array, sig: Uint8Array): Promise<boolean>;
}
