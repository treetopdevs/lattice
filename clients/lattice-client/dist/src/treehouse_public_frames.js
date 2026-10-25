import { assertWireVocabularyTerm, canonicalCarrierTerm } from "./codec";
// Space frames export (v1): a Space's public signed carrier frames, for the catalog ceremony operator.
// Not a backup: it carries no keys, outbox, acknowledgements, routes, drafts or state, only the frames.
export const SPACE_EXPORT_FORMAT = "lattice-space-frames-export-v1";
export const SPACE_EXPORT_MAX_FRAMES = 4000;
export const SPACE_EXPORT_MAX_BYTES = 16 * 1024 * 1024;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.json$/;
/** The only file names the native writer accepts: one plain `.json` segment, never a path. */
export const isExportFileName = (name) => FILE_NAME.test(name) && !name.includes("..");
/** A default file name from the tail of the Space id, sanitized. */
export function suggestExportFileName(replica) {
    const id = replica.split("#")[0].split(":").pop() ?? "";
    const tail = id.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "space";
    return `treehouse-space-${tail}.frames.json`;
}
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Compact JSON with object keys sorted in code-unit order at every level. */
const sortedJson = (value) => JSON.stringify(value, (_key, v) => v !== null && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => byCodeUnit(a, b)))
    : v);
const bad = () => {
    throw new Error("export_invalid_frame");
};
const str = (v) => (typeof v === "string" ? v : bad());
const strs = (v) => (Array.isArray(v) ? v.map(str) : bad());
/**
 * The term exactly as the BEAM re-encodes it (Lattice.Carrier.Wire.encode_op): the library decodes the term's own
 * canonical bytes, so map and mapset order, set members and integer spelling all come from those bytes and nothing
 * but the closed grammar survives. Any term the codec refuses, or a name outside the closed wire vocabulary (which
 * Lattice.Carrier.Wire.decode_op refuses), is an invalid frame.
 */
const beamTerm = (term) => {
    try {
        const canonical = canonicalCarrierTerm(term);
        assertWireVocabularyTerm(canonical);
        return canonical;
    }
    catch {
        return bad();
    }
};
export async function buildSpaceFramesExport(input) {
    const { space, rootPublicKey, frames, verify } = input;
    if (!frames.length)
        throw new Error("export_empty");
    if (frames.length > SPACE_EXPORT_MAX_FRAMES)
        throw new Error("export_too_large");
    const ids = new Set();
    const copies = [];
    for (const frame of frames) {
        if (frame.replica !== space)
            throw new Error("export_wrong_replica");
        if (ids.has(frame.id))
            throw new Error("export_duplicate_frame");
        ids.add(frame.id);
        // A malformed frame makes the verifier throw; either way the frame is refused.
        if (!(await verify(frame).catch(() => false)))
            throw new Error("export_invalid_frame");
        // Rebuilt field by field, terms from their canonical bytes: a retained object may carry nothing else into the file, at any depth.
        copies.push({
            v: frame.v,
            id: frame.id,
            replica: frame.replica,
            author: frame.author,
            deps: strs(frame.deps),
            kind: frame.kind,
            body: beamTerm(frame.body),
            cap: beamTerm(frame.cap),
            sig: frame.sig,
        });
    }
    copies.sort((a, b) => byCodeUnit(a.id, b.id));
    const text = sortedJson({ format: SPACE_EXPORT_FORMAT, space, root: rootPublicKey, frames: copies });
    if (new TextEncoder().encode(text).length > SPACE_EXPORT_MAX_BYTES)
        throw new Error("export_too_large");
    return text;
}
