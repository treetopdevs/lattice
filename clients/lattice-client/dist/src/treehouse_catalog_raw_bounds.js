// Raw observation is wider than wire admission (64 generic composites), so a
// signed depth-65 refusal can still be authenticated. Neither result is authority.
const MAX_NODES = 64 * 1024 * 1024;
const MAX_STRING_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 65;
const MAX_JSON_DEPTH = 136;
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
export function withinCatalogRawObservationBounds(frame) {
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
                if (value.length > MAX_STRING_BYTES - bytes)
                    return false;
                bytes += encoder.encode(value).length;
                if (bytes > MAX_STRING_BYTES)
                    return false;
            }
            else if (value !== null && typeof value === "object") {
                if (pending.length > MAX_JSON_DEPTH || active.has(value))
                    return false;
                active.add(value);
                pending.push({ values: Array.isArray(value) ? value.values() : fields(value), owner: value });
            }
            else if (value !== null && typeof value !== "number" && typeof value !== "boolean")
                return false;
        }
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
