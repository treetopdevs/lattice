import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import alphabet from "../../route_alphabet.json";
import { validRouteUrl, validateLocalRealm } from "../../src/treehouse_routes";

// Plan 198: the differential case set. src-tauri/tests/route_alphabet.rs replays this file through preview.rs,
// so both validators must give the verdict recorded here. The verdicts come from the live TS validators;
// this generator is the only writer of the file (`npm run route-alphabet:cases`).

export type AlphabetCase = { kind: "realm" | "url"; value: string; valid: boolean };

export const CASES_PATH = fileURLToPath(new URL("../route_alphabet_cases.json", import.meta.url));

/** Fixed-seed xorshift32: no Math.random and no Date, so the output never varies. */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

const edgePoints = alphabet.realm.edgeWhitespace.map((point) => parseInt(point.slice(2), 16));
// Neighbours of the edge set that must stay interior-legal: controls, format characters, a replacement char.
// Supplementary scalars whose low 16 bits look like a surrogate (plan 198 review: a bit mask misread them).
const neighbourPoints = [0x0000, 0x0001, 0x007f, 0x00ad, 0x180e, 0x200b, 0x2060, 0xfffd, 0x1d800, 0x2d800];

// Both hand-written lists (test/storage.ts and src-tauri/tests/native_commands.rs), merged. The verdicts are
// recomputed below, so a list entry that moves between valid and refused needs no edit here.
const HAND_URLS = [
  "wss://relay.example.com:443/carrier",
  "ws://localhost:1",
  "ws://LocalHost:1",
  "ws://[::1]:9",
  "wss://[::A]",
  "wss://service.0xcorp",
  "wss://x:443",
  "wss://[2001:db8::1]:443",
  "wss://10.0.0.1",
  "wss://x:",
  "ws://[::1]:",
  "WSS://x",
  "http://127.0.0.1:8080",
  "ws://example.com:8080",
  "wss://user@example.com",
  "wss://example.com/#frag",
  "ws://127.0.0.1:99999",
  "ws://127.0.0.1:8a",
  " wss://example.com",
  "wss://[not-an-ip]",
  "wss://[fe80::1%25en0]",
  "wss://1.2.3.999",
  "wss://exämple.com",
  "ws://[::2]:9",
  "ws://[0:0:0:0:0:0:0:1]:9",
  "ws://127.1",
  "wss://[::ffff:1.2.3.4]",
  "wss://010.0.0.1",
  "wss://ex%61mple.com",
  "wss://a.0x1f",
  "wss://x:000443",
  "wss://x:0443",
  "wss://x:0",
  "wss://foo!bar",
  "wss://foo$bar",
  "wss://foo+bar;x",
  "wss://example.com/é",
  "wss://example.com/\u0001",
  "ws://127.0.0.1:8080",
  "ws://127.0.0.1",
  "ws://127.0.0.1:9090",
  "wss://relay.example",
  "wss://example.com",
  "ws://x",
  // Plan 198 review: the scheme must be followed by "://" itself, a bare "#" is a fragment, and the 2048 cap.
  "wss:example.com?://example.com",
  "wss:example.com/://example.com",
  "ws:\\\\localhost?://localhost",
  "wss:example.com",
  "wss://x#",
  "wss://x/#",
  "wss://x?#",
  "ws://localhost#",
  "wss://[::ffff:102:304]",
  "wss://[::ffff:7f00:1]",
  "wss://[::ffff:0:0]",
  "wss://[::FFFF:a:b]",
  "wss://[::1.2.3.4]",
  "wss://xn--a",
  "wss://xn--",
  "wss://XN--a",
  "wss://a.xn--b",
  "wss://xn--nxasmq6b",
  "wss://xn--bcher-kva.example",
  "wss://a.1..",
  "wss://1..",
  "wss://x..",
  "wss://a.1.",
  "ws://localhost..",
  "wss://127.0.0.1.",
];

const SCHEMES = ["ws", "wss", "WS", "WSS", "http", "wss ", "https", "ws+x"];
const HOSTS = [
  "127.0.0.1",
  "localhost",
  "LocalHost",
  "[::1]",
  "[::A]",
  "[2001:db8::1]",
  "example.com",
  "127.1",
  "0x7f.1",
  "10.0.0.1",
  "service.0xcorp",
  "a.0x1f",
  "foo!bar",
  "ex%61mple.com",
  "exämple.com",
  "010.0.0.1",
  // Host-alphabet edges: `-` and `_` are legal, `~`, `*`, quotes and a doubled dot are not (or are only a name).
  "foo_bar.com",
  "a-b.com",
  "-a",
  "_a",
  "a..b",
  "foo~bar",
  "foo*bar",
  "foo'bar",
  'foo"bar',
  "foo(bar)",
  "xn--a",
  "a.xn--b",
  "xn--nxasmq6b",
  "[::ffff:102:304]",
  "[::102:304]",
  "[64:ff9b::1]",
  "[::]",
  "[1:0:0:2:0:0:0:3]",
  "[1:0:0:2:0:0:3:4]",
  "[0:0:1:0:0:0:0:1]",
  "[2001:0db8::1]",
  "a.1..",
  "x..",
];
const PORTS = ["", ":", ":1", ":0", ":80", ":443", ":65535", ":65536", ":0443", ":8a"];
const SUFFIXES = ["", "/", "/carrier", "/a/b?c=d", "?q", "#f", "/p#f", "#", "/#", "?#", "?://x", "/://x", "user@", "user:pw@", "/é"];
// Inserted at a random position: controls, space, DEL, NBSP, a Latin letter and a zero-width space.
const STRAY = ["\u0000", "\u0001", "\t", "\n", " ", "\u007f", " ", "é", "​"];

const realmVerdict = (value: string): boolean => {
  try {
    validateLocalRealm(value);
    return true;
  } catch {
    return false;
  }
};

export function generateCases(): AlphabetCase[] {
  const next = rng(0x9e3779b9);
  const pick = <T>(items: readonly T[]): T => items[next() % items.length]!;
  const seen = new Set<string>();
  const cases: AlphabetCase[] = [];
  const add = (kind: "realm" | "url", value: string) => {
    const key = `${kind}\u0000${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    cases.push({ kind, value, valid: kind === "realm" ? realmVerdict(value) : validRouteUrl(value) });
  };

  // Realm: every edge and neighbour code point in the four positions, then pairs of edges.
  for (const point of [...edgePoints, ...neighbourPoints]) {
    const c = String.fromCodePoint(point);
    for (const value of [`${c}x`, `x${c}`, `x${c}y`, c]) add("realm", value);
  }
  for (const a of [0x0085, 0xfeff, 0x0020, 0x200b]) {
    for (const b of [0x0085, 0xfeff, 0x0020, 0x200b]) {
      const [x, y] = [String.fromCodePoint(a), String.fromCodePoint(b)];
      add("realm", `${x}${y}x`);
      add("realm", `x${x}${y}`);
    }
  }
  // Byte boundaries.
  for (const value of [
    "a".repeat(256),
    "a".repeat(257),
    "é".repeat(128),
    "é".repeat(129),
    "\u{1f600}".repeat(64),
    "\u{1f600}".repeat(65),
    `${"a".repeat(255)}é`,
    "",
  ])
    add("realm", value);
  // Random strings (enough that the realm kind passes the 1000-case floor) over ASCII, the edge set and multibyte letters.
  const realmAlphabet = [
    ..."abcXYZ019_-. ",
    ...edgePoints.map((point) => String.fromCodePoint(point)),
    "é",
    "€",
    "\u{1f600}",
    "​",
    "­",
  ];
  for (let made = 0; made < 900; ) {
    const length = 1 + (next() % 12);
    let value = "";
    for (let i = 0; i < length; i += 1) value += pick(realmAlphabet);
    const before = cases.length;
    add("realm", value);
    if (cases.length > before) made += 1;
  }

  // URL: both hand lists, then every scheme x host x port, then random suffix/stray-byte variants.
  for (const url of HAND_URLS) add("url", url);
  // The 2048 cap: valid-shaped wss URLs of exactly 2047, 2048 and 2049 characters (a long path past the host).
  for (const length of [2047, 2048, 2049]) {
    const head = "wss://example.com/";
    add("url", head + "a".repeat(length - head.length));
  }
  // A long host as well, so the cap is judged on the whole text and not only on the path.
  add("url", `wss://${"a".repeat(2048 - 6)}`);
  add("url", `wss://${"a".repeat(2049 - 6)}`);
  for (const scheme of SCHEMES)
    for (const host of HOSTS) for (const port of PORTS) add("url", `${scheme}://${host}${port}`);
  for (let made = 0; made < 400; ) {
    const suffix = pick(SUFFIXES);
    const userinfo = suffix.endsWith("@");
    let value = `${pick(SCHEMES)}://${userinfo ? suffix : ""}${pick(HOSTS)}${pick(PORTS)}${userinfo ? "" : suffix}`;
    if (next() % 2 === 0) {
      const at = next() % (value.length + 1);
      value = value.slice(0, at) + pick(STRAY) + value.slice(at);
    }
    const before = cases.length;
    add("url", value);
    if (cases.length > before) made += 1;
  }
  return cases;
}

/** Two-space JSON with every non-ASCII or DEL character as a \uXXXX escape, so the file reads the same everywhere. */
export function serializeCases(cases: readonly AlphabetCase[]): string {
  const text = JSON.stringify(cases, null, 2).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `${text}\n`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--write")) {
    const cases = generateCases();
    writeFileSync(CASES_PATH, serializeCases(cases));
    const count = (kind: string) => cases.filter((c) => c.kind === kind).length;
    console.log(`wrote ${cases.length} cases (realm ${count("realm")}, url ${count("url")}) to ${CASES_PATH}`);
  } else {
    process.stdout.write(serializeCases(generateCases()));
  }
}
