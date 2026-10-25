import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
/** Common strict Ed25519 profile, including the uncofactored equation.
 * Noble's zip215:false alone still checks a cofactored equation. All point and
 * scalar arithmetic here uses Noble; no secret material enters verification.
 */
export function verifyEd25519(signature, message, publicKey) {
    try {
        if (publicKey.length !== 32 || signature.length !== 64)
            return false;
        const A = ed25519.Point.fromBytes(publicKey, false);
        const R = ed25519.Point.fromBytes(signature.subarray(0, 32), false);
        if (A.isSmallOrder() || R.isSmallOrder())
            return false;
        const scalar = (bytes) => {
            let value = 0n;
            for (let i = bytes.length - 1; i >= 0; i--)
                value = value * 256n + BigInt(bytes[i]);
            return value;
        };
        const s = scalar(signature.subarray(32));
        const order = ed25519.Point.Fn.ORDER;
        if (s >= order)
            return false;
        const challenge = new Uint8Array(64 + message.length);
        challenge.set(signature.subarray(0, 32));
        challenge.set(publicKey, 32);
        challenge.set(message, 64);
        const k = scalar(sha512(challenge)) % order;
        return ed25519.Point.BASE.multiplyUnsafe(s).equals(R.add(A.multiplyUnsafe(k)));
    }
    catch {
        return false;
    }
}
