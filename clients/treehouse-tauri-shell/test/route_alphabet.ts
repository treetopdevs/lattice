import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import alphabet from "../route_alphabet.json";
import { validRouteUrl, validateLocalRealm } from "../src/treehouse_routes";
import { CASES_PATH, generateCases, serializeCases } from "./support/route_alphabet_cases";
import type { AlphabetCase } from "./support/route_alphabet_cases";

// Plan 198: the TS half of the route/realm alphabet check. The Rust half (src-tauri/tests/route_alphabet.rs)
// replays the same committed cases through preview.rs.

const realmOk = (value: string): boolean => {
  try {
    validateLocalRealm(value);
    return true;
  } catch {
    return false;
  }
};

// The edge set is exactly Rust's White_Space plus U+FEFF, spelled out here independently of the table.
{
  const expected = new Set<number>([0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);
  for (let point = 0x09; point <= 0x0d; point += 1) expected.add(point);
  for (let point = 0x2000; point <= 0x200a; point += 1) expected.add(point);
  assert.equal(expected.size, 26);
  const actual = alphabet.realm.edgeWhitespace.map((point) => {
    assert.match(point, /^U\+[0-9A-F]{4}$/, point);
    return parseInt(point.slice(2), 16);
  });
  assert.equal(new Set(actual).size, actual.length, "edge list has duplicates");
  assert.deepEqual([...actual].sort((a, b) => a - b), [...expected].sort((a, b) => a - b));
  // The two runtimes' trim sets differ at exactly these two points; the table must cover both.
  assert.ok(actual.includes(0x85) && actual.includes(0xfeff));
}

// Named expectations, independent of the generator.
assert.equal(realmOk("﻿x"), false, "U+FEFF at the front (JavaScript-only trim)");
assert.equal(realmOk("x\u0085"), false, "U+0085 at the end (Rust-only trim)");
assert.equal(realmOk("x​y"), true, "interior zero-width space");
assert.equal(realmOk("​x"), true, "U+200B is not edge whitespace");
assert.equal(realmOk("x\u0085y"), true, "edge whitespace is allowed inside");
assert.equal(realmOk(""), false);
assert.equal(realmOk("a\ud800b"), false, "a lone surrogate cannot reach the native store");
assert.equal(realmOk("a\udc00"), false);
assert.equal(realmOk("a\ud83d\ude00b"), true, "a paired surrogate is one code point");
assert.equal(realmOk("\u{1d800}"), true, "a supplementary scalar is not a surrogate (review: bit mask)");
assert.equal(realmOk("x\u{2d800}"), true);
assert.equal(realmOk("a".repeat(256)), true);
assert.equal(realmOk("a".repeat(257)), false);
assert.equal(realmOk("é".repeat(128)), true);
assert.equal(realmOk("é".repeat(129)), false);
assert.equal(realmOk("\u{1f600}".repeat(64)), true);
assert.equal(validRouteUrl("ws://[::1]:9"), false, "the one form removed");
assert.equal(validRouteUrl("ws://[::1]:"), false);
assert.equal(validRouteUrl("ws://localhost:1"), true);
assert.equal(validRouteUrl("ws://127.0.0.1:8080"), true);
assert.equal(validRouteUrl("wss://[2001:db8::1]:443"), true);
assert.equal(validRouteUrl("wss://[::A]"), true, "uppercase canonical IPv6 literal under wss");
assert.equal(validRouteUrl("ws://example.com:8080"), false);

// The committed cases are current and every recorded verdict is what the live validators say.
const committed = readFileSync(CASES_PATH, "utf8");
const regenerated = generateCases();
assert.equal(committed, serializeCases(regenerated), "test/route_alphabet_cases.json is stale: npm run route-alphabet:cases");
const cases = JSON.parse(committed) as AlphabetCase[];
assert.deepEqual(cases, regenerated);
const counts = { realm: 0, url: 0 };
for (const c of cases) {
  counts[c.kind] += 1;
  const live = c.kind === "realm" ? realmOk(c.value) : validRouteUrl(c.value);
  assert.equal(live, c.valid, `${c.kind} ${JSON.stringify(c.value)}`);
}
assert.ok(counts.realm >= 1000 && counts.url >= 1000, JSON.stringify(counts));
// Both verdicts occur in each kind, so a validator that always answers one way cannot pass.
for (const kind of ["realm", "url"] as const) {
  assert.ok(cases.some((c) => c.kind === kind && c.valid), `${kind} has no accepted case`);
  assert.ok(cases.some((c) => c.kind === kind && !c.valid), `${kind} has no refused case`);
}
// Every URL literal in the two hand-written lists (test/storage.ts, src-tauri/tests/native_commands.rs) is in the
// differential set, so a URL added to either list later cannot escape the cross-runtime check.
{
  const unescape = (text: string): string =>
    text.replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(.))/g, (_m, brace, four, two, other) =>
      brace || four || two
        ? String.fromCodePoint(parseInt(brace ?? four ?? two, 16))
        : ({ n: "\n", t: "\t", r: "\r", "0": "\0" } as Record<string, string>)[other as string] ?? (other as string),
    );
  const have = new Set(cases.filter((c) => c.kind === "url").map((c) => c.value));
  let scraped = 0;
  for (const file of ["storage.ts", "../src-tauri/tests/native_commands.rs"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const match of source.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
      const value = unescape(match[1]!);
      if (!/^\s*(?:wss?|http):\/\//i.test(value)) continue;
      scraped += 1;
      assert.ok(have.has(value), `${file} has a route URL missing from the cases: ${JSON.stringify(value)}`);
    }
  }
  assert.ok(scraped >= 40, `scraped only ${scraped} URL literals`);
}
// The 2048-character cap is exercised on both sides of the boundary.
{
  const lengths = new Set(cases.filter((c) => c.kind === "url").map((c) => c.value.length));
  for (const length of [alphabet.routeUrl.maxLength - 1, alphabet.routeUrl.maxLength, alphabet.routeUrl.maxLength + 1])
    assert.ok(lengths.has(length), `no url case of length ${length}`);
  assert.equal(validRouteUrl(`wss://example.com/${"a".repeat(alphabet.routeUrl.maxLength - 18)}`), true);
  assert.equal(validRouteUrl(`wss://example.com/${"a".repeat(alphabet.routeUrl.maxLength - 17)}`), false);
}
// Review regressions, independent of the generator.
for (const url of ["wss:example.com?://example.com", "wss:example.com/://example.com", "wss://x#", "wss://x/#", "wss://xn--a", "wss://xn--"])
  assert.equal(validRouteUrl(url), false, url);
for (const url of ["wss://[::ffff:102:304]", "wss://foo_bar.com", "wss://a-b.com", "wss://a.1..", "wss://x.."])
  assert.equal(validRouteUrl(url), true, url);
console.log(`PASS route alphabet: ${counts.realm} realm and ${counts.url} url cases agree with the live validators`);
