import assert from "node:assert/strict";
import test from "node:test";
import { parseCatalogArtifactJson as parse, CATALOG_ARTIFACT_BYTES as cap } from "../src/treehouse_catalog_json";
test("raw catalog numbers have one bounded spelling before JSON conversion", () => {
    for (const token of ["0", "1", "9007199254740991"])
        assert.equal(parse(`[${token}]`).ok, true, token);
    for (const token of ["-0", "-1", "1.0", "1e0", "1E+0", "01", "9007199254740992", "18446744073709551615", "1".repeat(100000)])
        assert.deepEqual(parse(`[${token}]`), { ok: false, reason: "malformed_catalog" }, token.slice(0, 30));
});
test("quoted numbers and escapes remain opaque to numeric preflight", () => {
    for (const value of ["-0 1.0 1e0", 'a"123', String.raw `\"-0`, "18446744073709551616"])
        assert.deepEqual(parse(JSON.stringify([value])), { ok: true, value: [value] });
    for (const value of ['[1,]', '["unterminated', '[true false]'])
        assert.equal(parse(value).ok, false);
});
test("artifact cap counts original UTF8 bytes", () => {
    const exact = '[0]' + " ".repeat(cap - 3);
    assert.equal(parse(exact).ok, true);
    assert.deepEqual(parse(exact + " "), { ok: false, reason: "control_history_limit" });
    assert.deepEqual(parse(JSON.stringify("é".repeat(cap / 2))), { ok: false, reason: "control_history_limit" });
});
test("oversized and noncanonical number tokens never reach JSON numeric conversion", () => {
    const original = JSON.parse;
    const calls = [];
    JSON.parse = (text, ...args) => { calls.push(text); return original(text, ...args); };
    try {
        assert.equal(parse("[0]").ok, true);
        for (const text of ["[" + "9".repeat(100000) + "]", "[-0]", "[1e0]", "[9007199254740992]"])
            assert.equal(parse(text).ok, false);
        assert.deepEqual(calls, ["[0]"]);
    }
    finally {
        JSON.parse = original;
    }
});
