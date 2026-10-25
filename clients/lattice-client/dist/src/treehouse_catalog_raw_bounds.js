// Raw observation is wider than wire admission (64 generic composites), so a
// signed depth-65 refusal can still be authenticated. Neither result is authority.
const MAX_NODES = 64 * 1024 * 1024;
const MAX_STRING_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 65;
// A map uses term-array, pairs-array and pair-array wrappers; a flat
// delegation leaf adds array/object/names-array beneath the frame object.
const MAX_JSON_DEPTH = MAX_DEPTH * 3 + 4;
const encoder = new TextEncoder();
function* fields(value) {
    for (const key of Object.keys(value)) {
        yield key;
        yield Reflect.get(value, key);
    }
}
function* pairs(value) {
    for (const pair of value) {
        if (!Array.isArray(pair) || pair.length !== 2)
            throw new Error("malformed raw map");
        yield pair[0];
        yield pair[1];
    }
}
function withinJsonBounds(frame, maxDepth) {
    try {
        let nodes = 0, bytes = 0;
        const pending = [{ values: [frame].values() }];
        const active = new WeakSet();
        while (pending.length > 0) {
            const current = pending[pending.length - 1], next = current.values.next();
            if (next.done) {
                if (current.owner !== undefined)
                    active.delete(current.owner);
                pending.pop();
                continue;
            }
            if (++nodes > MAX_NODES)
                return false;
            const value = next.value;
            if (typeof value === "string") {
                if (/[\uD800-\uDFFF]/u.test(value) || value.length > MAX_STRING_BYTES - bytes)
                    return false;
                bytes += encoder.encode(value).length;
                if (bytes > MAX_STRING_BYTES)
                    return false;
            }
            else if (value !== null && typeof value === "object") {
                if (pending.length > maxDepth || active.has(value))
                    return false;
                active.add(value);
                pending.push({ values: Array.isArray(value) ? value.values() : fields(value), owner: value });
            }
            else if (value !== null && typeof value !== "number" && typeof value !== "boolean")
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
// Histories are public JSON-shaped values. Three wrappers precede accepted
// frames; rejected records add one more. Count every occurrence, including
// repeated/shared frames, before any cryptographic replay.
export function withinCatalogRawHistoriesBounds(histories) {
    return withinJsonBounds(histories, MAX_JSON_DEPTH + 4);
}
// A proof-history adds page/list/proof/history/rejected/record wrappers.
export function withinCatalogRawEvidenceBounds(value) {
    return withinJsonBounds(value, MAX_JSON_DEPTH + 6);
}
export function withinCatalogRawObservationBounds(frame) {
    if (!withinJsonBounds(frame, MAX_JSON_DEPTH))
        return false;
    try {
        const raw = frame;
        const terms = [{ values: [raw.body, raw.cap].values(), depth: MAX_DEPTH }];
        while (terms.length > 0) {
            const current = terms[terms.length - 1], next = current.values.next();
            if (next.done) {
                terms.pop();
                continue;
            }
            if (!Array.isArray(next.value))
                return false;
            const [tag, values] = next.value;
            if (next.value.length !== (tag === "nil" ? 1 : 2))
                return false;
            if (tag === "int") {
                if (typeof values === "number") {
                    if (!Number.isSafeInteger(values) || values < 0)
                        return false;
                }
                else if (typeof values !== "string" || values.length === 0 || values.length > 20 || /[^0-9]/.test(values) ||
                    (values.length > 1 && values[0] === "0") || (values.length === 20 && values > "18446744073709551615"))
                    return false;
            }
            if (tag === "delegation") {
                if (values === null || typeof values !== "object" || Array.isArray(values))
                    return false;
                const d = values;
                const required = ["id", "replica", "issuer", "audience", "sig", "parent_id", "live", "ops", "roles"];
                if (!required.every(key => Object.hasOwn(d, key)) || Object.keys(d).some(key => !required.includes(key) && key !== "expires_epoch"))
                    return false;
                if (!["id", "replica", "issuer", "audience", "sig"].every(key => typeof d[key] === "string") ||
                    (d.parent_id !== null && typeof d.parent_id !== "string") || typeof d.live !== "boolean" ||
                    !Array.isArray(d.ops) || !d.ops.every(v => typeof v === "string") || !Array.isArray(d.roles) || !d.roles.every(v => typeof v === "string"))
                    return false;
                if (d.expires_epoch !== undefined && d.expires_epoch !== null &&
                    (typeof d.expires_epoch !== "number" || !Number.isSafeInteger(d.expires_epoch) || d.expires_epoch < 0))
                    return false;
            }
            if (tag === "bool" && typeof values !== "boolean")
                return false;
            if ((tag === "atom" || tag === "bin") && typeof values !== "string")
                return false;
            if (["list", "tuple", "mapset", "map"].includes(tag)) {
                if (current.depth === 0 || !Array.isArray(values))
                    return false;
                terms.push({ values: tag === "map" ? pairs(values) : values.values(), depth: current.depth - 1 });
            }
        }
        return true;
    }
    catch {
        return false;
    }
}
