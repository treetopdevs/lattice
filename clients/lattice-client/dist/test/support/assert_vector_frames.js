import { assertWireVocabulary } from "../../src/carrier";
/**
 * Plan 190: the TypeScript vector writers call this on everything they are about to write.
 * It finds every carrier frame (an object with array `body` and `cap`), wherever it sits,
 * and refuses the write if one names an atom outside the closed wire vocabulary.
 */
export function assertVectorFrames(value) {
    let frames = 0;
    const visit = (node) => {
        if (Array.isArray(node))
            return node.forEach(visit);
        if (typeof node !== "object" || node === null || ArrayBuffer.isView(node))
            return;
        if (Array.isArray(Reflect.get(node, "body")) && Array.isArray(Reflect.get(node, "cap"))) {
            assertWireVocabulary(node);
            frames++;
        }
        Object.values(node).forEach(visit);
    };
    visit(value);
    return frames;
}
