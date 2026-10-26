import { canonicalUint64Text, canonicalHighUint64Text } from "./uint64";
export const CATALOG_ARTIFACT_BYTES = 128 * 1024;
/** Check only numeric spelling before conversion; JSON.parse owns syntax.
 * Quoted content, including escaped quotes and numeric-looking text, is opaque.
 */
function integerTokens(json) {
    let quoted = false;
    for (let i = 0; i < json.length; i++) {
        const code = json.charCodeAt(i);
        if (quoted) {
            if (code === 92)
                i++; // Skip the escaped character, including a quote.
            else if (code === 34)
                quoted = false;
            continue;
        }
        if (code === 34) {
            quoted = true;
            continue;
        }
        if (code === 45)
            return false;
        if (code < 48 || code > 57)
            continue;
        const start = i;
        while (i < json.length && json.charCodeAt(i) >= 48 && json.charCodeAt(i) <= 57) {
            if (i - start >= 20)
                return false;
            i++;
        }
        const token = json.slice(start, i);
        if (!canonicalUint64Text(token) || canonicalHighUint64Text(token) ||
            json[i] === "." || json[i] === "e" || json[i] === "E")
            return false;
        i--;
    }
    return !quoted;
}
export function parseCatalogArtifactJson(json) {
    if (typeof json !== "string")
        return { ok: false, reason: "malformed_catalog" };
    if (json.length > CATALOG_ARTIFACT_BYTES || new TextEncoder().encode(json).length > CATALOG_ARTIFACT_BYTES)
        return { ok: false, reason: "control_history_limit" };
    if (!integerTokens(json))
        return { ok: false, reason: "malformed_catalog" };
    try {
        return { ok: true, value: JSON.parse(json) };
    }
    catch {
        return { ok: false, reason: "malformed_catalog" };
    }
}
