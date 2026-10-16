/**
 * Plan 190: the TypeScript vector writers call this on everything they are about to write.
 * It finds every carrier frame (an object with array `body` and `cap`), wherever it sits,
 * and refuses the write if one names an atom outside the closed wire vocabulary.
 */
export declare function assertVectorFrames(value: unknown): number;
