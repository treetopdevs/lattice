import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { canonicalBytesForCarrierTerm, canonicalCarrierTerm, carrierTermFromCanonicalBytes, } from "../src/index";
// Row 237: canonicalCarrierTerm must reproduce the exact JSON term BEAM's
// Lattice.Carrier.Wire emits. BEAM-generated vectors are the oracle; ts_* files are
// TypeScript-produced and excluded so the roundtrip is not circular.
const here = dirname(fileURLToPath(import.meta.url));
const vectorDirectory = join(here, "vectors");
let failures = 0;
function check(name, got, want) {
    const ok = isDeepStrictEqual(got, want);
    if (!ok)
        failures++;
    const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(`  ${tag} ${name}`);
    if (!ok) {
        console.log(`       got : ${JSON.stringify(got)}`);
        console.log(`       want: ${JSON.stringify(want)}`);
    }
}
function rejects(name, input) {
    let error = null;
    try {
        carrierTermFromCanonicalBytes(input);
    }
    catch (caught) {
        error = caught;
    }
    check(`rejects ${name}`, error instanceof Error, true);
}
// Frames that are not `Wire.encode_op` output, so they are not a BEAM JSON oracle:
// - wireCases: hand-mutated wire inputs that exercise BEAM decode admission/refusal;
// - member_continuity_claim_shape/beam.json: frames authored by the TS test
//   (TREEHOUSE_CONTINUITY_SHAPE_EXPORT); BEAM only judges them;
// - catalog/cutoff_default_pre_member_continuity.json: the committed baseline of the
//   TS writer test/support/export_treehouse_catalog_cutoff.ts.
const nonOraclePaths = [
    /\.wireCases\[/,
    /^member_continuity_claim_shape\/beam\.json/,
    /^catalog\/cutoff_default_pre_member_continuity\.json/,
];
function vectorFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory())
            return vectorFiles(path);
        return entry.name.endsWith(".json") && !entry.name.startsWith("ts_") ? [path] : [];
    });
}
function isFrame(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    return ["body", "cap", "kind", "sig"].every((key) => key in value);
}
function collectFrames(value, path, out) {
    if (nonOraclePaths.some((pattern) => pattern.test(path)))
        return;
    if (isFrame(value)) {
        out.push({ path, frame: value });
    }
    else if (Array.isArray(value)) {
        value.forEach((item, index) => collectFrames(item, `${path}[${index}]`, out));
    }
    else if (typeof value === "object" && value !== null) {
        for (const [key, item] of Object.entries(value))
            collectFrames(item, `${path}.${key}`, out);
    }
}
function findTerm(term, predicate) {
    if (predicate(term))
        return true;
    switch (term[0]) {
        case "list":
        case "tuple":
        case "mapset":
            return term[1].some((item) => findTerm(item, predicate));
        case "map":
            return term[1].some(([key, value]) => findTerm(key, predicate) || findTerm(value, predicate));
        default:
            return false;
    }
}
/** Reverse every map/mapset/delegation-name order, duplicate delegation names, stringify ints. */
function perturb(term) {
    switch (term[0]) {
        case "int":
            return typeof term[1] === "number" ? ["int", String(term[1])] : term;
        case "list":
            return ["list", term[1].map(perturb)];
        case "tuple":
            return ["tuple", term[1].map(perturb)];
        case "mapset":
            return ["mapset", term[1].map(perturb).reverse()];
        case "map":
            return [
                "map",
                term[1].map(([key, value]) => [perturb(key), perturb(value)]).reverse(),
            ];
        case "delegation": {
            const delegation = {
                ...term[1],
                ops: [...term[1].ops, ...term[1].ops].reverse(),
                roles: [...term[1].roles, ...term[1].roles].reverse(),
            };
            return ["delegation", delegation];
        }
        default:
            return term;
    }
}
// ── (a) every BEAM frame's body/cap is already the canonical JSON term ──────────
console.log("\nCanonical carrier term — BEAM vector roundtrip");
const found = [];
for (const file of vectorFiles(vectorDirectory)) {
    collectFrames(JSON.parse(readFileSync(file, "utf8")), relative(vectorDirectory, file), found);
}
let roundtrips = 0;
let mismatches = 0;
for (const { path, frame } of found) {
    for (const field of ["body", "cap"]) {
        const term = frame[field];
        let got;
        try {
            got = canonicalCarrierTerm(term);
        }
        catch (error) {
            got = `threw: ${error.message}`;
        }
        roundtrips++;
        if (!isDeepStrictEqual(got, term)) {
            mismatches++;
            console.log(`       ${path}.${field}`);
            console.log(`         got : ${JSON.stringify(got)}`);
            console.log(`         want: ${JSON.stringify(term)}`);
        }
    }
}
check(`${roundtrips} body/cap terms from ${found.length} BEAM frames roundtrip verbatim`, mismatches, 0);
check("vectors include a leased delegation", found.some(({ frame }) => findTerm(frame.body, (term) => term[0] === "delegation" && term[1].expires_epoch !== undefined)), true);
check("vectors include a BEAM string int", found.some(({ frame }) => findTerm(frame.body, (term) => term[0] === "int" && typeof term[1] === "string")), true);
// ── (b) perturbed BEAM terms normalize back to the BEAM term verbatim ──────────
console.log("\nCanonical carrier term — perturbation back to the BEAM oracle");
const mapFrame = found.find(({ frame }) => findTerm(frame.body, (term) => term[0] === "map" && term[1].length > 1) &&
    findTerm(frame.body, (term) => term[0] === "int" && typeof term[1] === "number" && term[1] < 24));
const delegationFrame = found.find(({ frame }) => findTerm(frame.body, (term) => term[0] === "delegation" && term[1].ops.length > 1 && term[1].roles.length > 0));
check("found a BEAM body with a multi-pair map and a small int", mapFrame !== undefined, true);
check("found a BEAM body with a multi-op delegation", delegationFrame !== undefined, true);
for (const [label, entry, field] of [
    ["map body", mapFrame, "body"],
    ["delegation body", delegationFrame, "body"],
]) {
    if (entry === undefined)
        continue;
    const original = entry.frame[field];
    const perturbed = perturb(original);
    check(`${label} perturbation differs from the vector (${entry.path})`, isDeepStrictEqual(perturbed, original), false);
    check(`${label} normalizes to the BEAM term`, canonicalCarrierTerm(perturbed), original);
}
check("[\"int\",\"7\"] normalizes to [\"int\",7]", canonicalCarrierTerm(["int", "7"]), ["int", 7]);
// BEAM literal (no vector carries a mapset), captured once with
// Lattice.Carrier.Wire.encode_value/1 and Lattice.Canonical.term/1 over
// %{elements: MapSet.new([:post, 300, <<1, 2>>, {:a, 7}, 9_007_199_254_740_992, nil, true, [1]]),
//   counts: %{"b" => 1, :z => 2, 5 => [3]}}
const beamMapsetTerm = JSON.parse('["map",[[["atom","counts"],["map",[[["int",5],["list",[["int",3]]]],[["bin","Yg=="],["int",1]],[["atom","z"],["int",2]]]]],[["atom","elements"],["mapset",[["int",300],["int","9007199254740992"],["bin","AQI="],["list",[["int",1]]],["atom","post"],["tuple",[["atom","a"],["int",7]]],["bool",true],["nil"]]]]]]');
const beamMapsetBytes = Buffer.from("otnqYEZjb3VudHOjBYEDQWIB2epgQXoC2epgSGVsZW1lbnRz2epiiBkBLBsAIAAAAAAAAEIBAoEB2epgRHBvc3TZ6mGC2epgQWEH9fY=", "base64");
check("BEAM mapset literal encodes to BEAM canonical bytes", Buffer.from(canonicalBytesForCarrierTerm(beamMapsetTerm)).equals(beamMapsetBytes), true);
check("BEAM canonical bytes decode to the BEAM mapset literal", carrierTermFromCanonicalBytes(beamMapsetBytes), beamMapsetTerm);
check("perturbed mapset literal normalizes to the BEAM term", canonicalCarrierTerm(perturb(beamMapsetTerm)), beamMapsetTerm);
// ── (c) integers past 2^53-1 take the decimal-string form ──────────────────────
console.log("\nCanonical carrier term — integer representation");
check("2^53-1 stays a number", canonicalCarrierTerm(["int", "9007199254740991"]), ["int", 9007199254740991]);
check("2^53 becomes a decimal string", canonicalCarrierTerm(["int", "9007199254740992"]), ["int", "9007199254740992"]);
check("uint64 max decodes as a decimal string", carrierTermFromCanonicalBytes(Uint8Array.of(0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)), ["int", "18446744073709551615"]);
// ── (d) strict decoder refusals ────────────────────────────────────────────────
console.log("\nCanonical carrier term — strict decoder refusals");
rejects("trailing bytes", Uint8Array.of(0x07, 0x00));
rejects("non-shortest uint (0x18 0x05)", Uint8Array.of(0x18, 0x05));
rejects("non-shortest uint (0x19 0x00 0xff)", Uint8Array.of(0x19, 0x00, 0xff));
rejects("non-shortest uint (0x1b < 2^32)", Uint8Array.of(0x1b, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff));
rejects("unsorted map keys", Uint8Array.of(0xa2, 0x02, 0xf6, 0x01, 0xf6));
rejects("duplicate map keys", Uint8Array.of(0xa2, 0x01, 0xf6, 0x01, 0xf6));
rejects("duplicate mapset element", Uint8Array.of(0xd9, 0xea, 0x62, 0x82, 0x01, 0x01));
rejects("unsorted mapset elements", Uint8Array.of(0xd9, 0xea, 0x62, 0x82, 0x02, 0x01));
rejects("indefinite-length array", Uint8Array.of(0x9f, 0x01, 0xff));
rejects("unknown tag 60004", Uint8Array.of(0xd9, 0xea, 0x64, 0x80));
rejects("text string (major 3)", Uint8Array.of(0x61, 0x61));
rejects("negative integer (major 1)", Uint8Array.of(0x20));
rejects("float", Uint8Array.of(0xf9, 0x00, 0x00));
rejects("truncated byte string", Uint8Array.of(0x42, 0x01));
rejects("head over uint64", Uint8Array.of(0x1c));
rejects("invalid UTF-8 atom name", Uint8Array.of(0xd9, 0xea, 0x60, 0x41, 0xff));
check("a leading BOM in an atom name survives the roundtrip", Buffer.from(canonicalBytesForCarrierTerm(carrierTermFromCanonicalBytes(Uint8Array.of(0xd9, 0xea, 0x60, 0x43, 0xef, 0xbb, 0xbf)))).toString("hex"), "d9ea6043efbbbf");
rejects("container nesting past the BEAM depth budget", Uint8Array.from([...Array(65).fill(0x81), 0xf6]));
check("container nesting at the BEAM depth budget decodes", carrierTermFromCanonicalBytes(Uint8Array.from([...Array(64).fill(0x81), 0xf6]))[0], "list");
// An empty mapset is still a container: Wire charges it one level before its elements.
const emptyMapset = [0xd9, 0xea, 0x62, 0x80];
rejects("an empty mapset past the BEAM depth budget", Uint8Array.from([...Array(64).fill(0x81), ...emptyMapset]));
check("an empty mapset at the BEAM depth budget decodes", carrierTermFromCanonicalBytes(Uint8Array.from([...Array(63).fill(0x81), ...emptyMapset]))[0], "list");
{
    let nested = ["mapset", []];
    for (let i = 0; i < 64; i++)
        nested = ["list", [nested]];
    let refused = false;
    try {
        canonicalCarrierTerm(nested);
    }
    catch {
        refused = true;
    }
    check("canonicalCarrierTerm refuses an empty mapset under 64 lists", refused, true);
}
// A lease epoch past 2^53-1 is a deliberate fail-closed bound: Wire admits it, but the JSON
// number the term carries could not hold it exactly.
const leased = found.map(({ frame }) => frame.body).flatMap((body) => {
    const out = [];
    findTerm(body, (term) => (term[0] === "delegation" && term[1].expires_epoch !== undefined && out.push(term[1]), false));
    return out;
})[0];
if (leased !== undefined) {
    const atZero = canonicalBytesForCarrierTerm(["delegation", { ...leased, expires_epoch: 0 }]);
    check("precondition: the lease epoch is the delegation's last byte", atZero[atZero.length - 1], 0);
    const withEpoch = (head) => Uint8Array.from([...atZero.subarray(0, atZero.length - 1), ...head]);
    const decoded = carrierTermFromCanonicalBytes(withEpoch([0x1b, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    check("a 2^53-1 lease epoch decodes", decoded[0] === "delegation" && decoded[1].expires_epoch, Number.MAX_SAFE_INTEGER);
    rejects("a 2^53 lease epoch", withEpoch([0x1b, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
    rejects("a uint64-max lease epoch", withEpoch([0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
}
console.log(`\n${basename(fileURLToPath(import.meta.url))}: ${failures === 0 ? "all passed" : `${failures} failed`}`);
if (failures > 0)
    process.exit(1);
