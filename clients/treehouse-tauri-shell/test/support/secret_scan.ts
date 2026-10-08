import assert from "node:assert/strict";

// A Treehouse-local copy of the idea behind Township's KV secret scan (no import across shells).
// Two checks: no JSON field name looks like secret material, and no planted needle (a seed in hex or
// base64, say) appears anywhere in the raw text. Post text is public content, so callers pass it as a
// needle only for the surfaces that must not carry it (the trace and the uploaded evidence).

const SECRET_FIELD = /seed|secret|priv|passw|token|bearer|mnemonic|credential|signing|apikey|api_key/i;

export function secretFieldNames(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => secretFieldNames(item, `${path}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => [
    ...(SECRET_FIELD.test(key) ? [`${path}.${key}`] : []),
    ...secretFieldNames(item, `${path}.${key}`),
  ]);
}

export function findNeedles(text: string, needles: readonly string[]): string[] {
  return needles.filter((needle) => needle.length > 0 && text.includes(needle));
}

/** Throws when `text` carries a secret-looking JSON field name or any needle. Non-JSON text gets the needle check only. */
export function assertNoSecrets(label: string, text: string, needles: readonly string[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  assert.deepEqual(secretFieldNames(parsed), [], `${label}: secret-looking field names`);
  // Needles are reported by position in the list, never by value, so a failure cannot leak a secret.
  const found = findNeedles(text, needles).map((needle) => needles.indexOf(needle));
  assert.deepEqual(found, [], `${label}: planted or secret needle indexes found`);
}

/** Positive control: the scanner must detect a planted needle and a planted secret-looking field. */
export function assertScannerDetects(needle: string): void {
  assert.throws(() => assertNoSecrets("planted needle", JSON.stringify({ note: `x${needle}y` }), [needle]), /needle/);
  assert.throws(() => assertNoSecrets("planted field", JSON.stringify({ nested: { signingKey: "k" } }), []), /field names/);
  assertNoSecrets("clean", JSON.stringify({ publicKey: "k", frames: [] }), [needle]);
}
