import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// M1a.5 strings. The word lists are read from their owners, so the test follows them: Plan 178's
// prohibited phrases (the code spans after "Prohibited phrases") and 01's "Words the app never uses"
// (its bold terms). The one approved hosting sentence is read from 01 too.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = join(ROOT, "../..");

function plan178Phrases(): string[] {
  const text = readFileSync(join(REPO, "plans/178-treehouse-contract-correction.md"), "utf8");
  const start = text.indexOf("Prohibited phrases (");
  assert.ok(start >= 0, "Plan 178 lists its prohibited phrases");
  const block = text.slice(start, text.indexOf("\n\n", start));
  const phrases = [...block.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.toLowerCase());
  assert.ok(phrases.length >= 10, "Plan 178's list parsed");
  return phrases;
}

const ONE = () => readFileSync(join(REPO, "docs/treehouse-mobile/01-ubiquitous-language.md"), "utf8");

function neverUsed(): string[] {
  const text = ONE();
  const start = text.indexOf("## Words the app never uses");
  const block = text.slice(start, text.indexOf("\n## ", start + 1));
  const words = [...block.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]!.toLowerCase());
  // "Sent at 14:02" names a pattern: any "sent at" followed by a time.
  const terms = words.map((w) => (w.startsWith("sent at") ? "sent at" : w));
  assert.ok(terms.includes("delivered") && terms.includes("online") && terms.includes("password"), "01's list parsed");
  return terms;
}

function approvedHostingSentence(): string {
  const text = ONE();
  const start = text.indexOf("## Hosting sentence");
  const quote = text
    .slice(start)
    .split("\n")
    .filter((line) => line.startsWith("> "))
    .map((line) => line.slice(2).trim());
  return quote.join(" ");
}

/** Every string reachable from the strings module's exports, with its path. */
function collect(value: unknown, path: string, out: [string, string][]): [string, string][] {
  if (typeof value === "string") out.push([path, value]);
  else if (typeof value === "function") {
    for (const sample of [0, 1, 3]) collect((value as (n: number) => unknown)(sample), `${path}(${sample})`, out);
  } else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) collect(v, `${path}.${k}`, out);
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("strings contain none of the prohibited or never-used words", async () => {
  const strings = await import("../../src/ui/strings");
  const all = collect(strings, "strings", []);
  assert.ok(all.length > 40, "strings.ts holds the app's copy");
  const hosting = approvedHostingSentence();
  const prohibited = plan178Phrases();
  const never = neverUsed();
  for (const [path, value] of all) {
    const lower = value.toLowerCase();
    for (const phrase of prohibited) assert.ok(!lower.includes(phrase), `${path} uses Plan 178's "${phrase}": ${value}`);
    // The approved hosting sentence is the one place "read" is allowed: it says who can read the copy.
    if (value === hosting) continue;
    for (const word of never) {
      const pattern = new RegExp(`\\b${escape(word)}\\b`, "i");
      assert.ok(!pattern.test(value), `${path} uses the never-used "${word}": ${value}`);
    }
  }

  // Copy outside strings.ts (the M0 screen and the demo fence) still passes Plan 178's scan.
  const sources = [
    join(ROOT, "src/App.tsx"),
    ...readdirSync(join(ROOT, "src/ui")).map((f) => join(ROOT, "src/ui", f)),
    ...readdirSync(join(ROOT, "src/demo")).map((f) => join(ROOT, "src/demo", f)),
  ];
  for (const file of sources) {
    const lower = readFileSync(file, "utf8").toLowerCase();
    for (const phrase of prohibited) assert.ok(!lower.includes(phrase), `${file} uses Plan 178's "${phrase}"`);
  }
});

test("the hosting sentence names who can read and who can withhold", async () => {
  const { HOSTING_SENTENCE } = await import("../../src/ui/strings");
  const trustCard = await import("../../src/ui/trust_card");
  assert.equal(HOSTING_SENTENCE, approvedHostingSentence(), "the one approved form from 01");
  assert.equal(trustCard.HOSTING_SENTENCE, HOSTING_SENTENCE, "the trust card shows the same sentence");
  assert.match(HOSTING_SENTENCE, /operator can read it/, "names who can read");
  assert.match(HOSTING_SENTENCE, /can take the relay offline/, "names who can withhold");
  // No other string talks about the relay's copy in a weaker form.
  const strings = await import("../../src/ui/strings");
  for (const [path, value] of collect(strings, "strings", []))
    if (/readable copy|plaintext copy/i.test(value)) assert.equal(value, HOSTING_SENTENCE, `${path} restates hosting in another form`);
});

test("every refusal reason has exactly one line of copy", async () => {
  const { refusalCopy } = await import("../../src/ui/strings");
  const { APPLICATION_DENIALS, JUDGE_REASONS } = await import("../../src/session/outcomes");
  const reasons = [
    ...Object.values(APPLICATION_DENIALS),
    ...JUDGE_REASONS,
    "quarantined",
    "identity_unavailable",
    "no_capability",
    "empty_text",
    "text_too_long",
    "malformed_text",
    "storage_failed",
    "history_invalid",
    "not_holder",
  ];
  for (const reason of reasons) {
    const copy = (refusalCopy as Record<string, string>)[reason];
    assert.ok(typeof copy === "string" && copy.trim().length > 0 && !copy.includes("\n"), `${reason} has one line of copy`);
  }
});
