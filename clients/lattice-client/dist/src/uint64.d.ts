export declare function canonicalUint64Text(value: unknown): value is string;
export declare function canonicalUint64Scalar(value: unknown): value is number | string;
export declare function parseCanonicalUint64(value: unknown): bigint;
export declare function canonicalHighUint64Text(value: unknown): value is string;
/** Complete portable wire admission: small values use JSON numbers. */
export declare function portableUint64Scalar(value: unknown): value is number | string;
