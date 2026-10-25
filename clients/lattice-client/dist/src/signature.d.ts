/** Common strict Ed25519 profile, including the uncofactored equation.
 * Noble's zip215:false alone still checks a cofactored equation. All point and
 * scalar arithmetic here uses Noble; no secret material enters verification.
 */
export declare function verifyEd25519(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;
