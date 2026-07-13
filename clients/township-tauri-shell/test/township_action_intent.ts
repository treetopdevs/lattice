import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTownshipActionIntentDeepLink } from "../src/township_action_intent";

interface PostActionIntentFixture {
  payload: {
    v: 1;
    id: string;
    replica: string;
    command: { command: "post"; text: string };
  };
  url: string;
}

interface StatusActionIntentFixture {
  payload: {
    v: 2;
    id: string;
    replica: string;
    command: { command: "close_matter" | "reopen_matter" };
  };
  url: string;
}

console.log("\n▸ Township action-intent contract");

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "township_action_intent_v1.json"), "utf8"),
) as PostActionIntentFixture;
const statusFixture = JSON.parse(
  readFileSync(join(here, "fixtures", "township_status_action_intent_v2.json"), "utf8"),
) as StatusActionIntentFixture;

assert.deepEqual(parseTownshipActionIntentDeepLink(fixture.url), {
  ok: true,
  intent: fixture.payload,
});
assert.deepEqual(parseTownshipActionIntentDeepLink(statusFixture.url), {
  ok: true,
  intent: statusFixture.payload,
});

const reopenPayload: StatusActionIntentFixture["payload"] = {
  ...statusFixture.payload,
  command: { command: "reopen_matter" },
};
assert.deepEqual(parseTownshipActionIntentDeepLink(actionUrl(reopenPayload)), {
  ok: true,
  intent: reopenPayload,
});

for (const text of ["\uFEFFresident update\uFEFF", "\u0085resident update\u0085"]) {
  const unicodePayload = {
    ...fixture.payload,
    replica: `replica${text[0]}`,
    command: { ...fixture.payload.command, text },
  };
  assert.deepEqual(parseTownshipActionIntentDeepLink(actionUrl(unicodePayload)), {
    ok: true,
    intent: unicodePayload,
  });
}

for (const invalid of [
  "https://township.example/action?intent=x",
  `township://pairing?intent=${encodeURIComponent(encoded(fixture.payload))}`,
  `township://action/path?intent=${encodeURIComponent(encoded(fixture.payload))}`,
  `township://action?intent=${encodeURIComponent(encoded(fixture.payload))}&extra=1`,
  "township://action",
  "township://action?intent=not-base64url!",
]) {
  assert.equal(parseTownshipActionIntentDeepLink(invalid).ok, false, invalid);
}

assert.deepEqual(
  parseTownshipActionIntentDeepLink(
    `township://action?intent=${Buffer.from("{", "utf8").toString("base64url")}`,
  ),
  {
    ok: false,
    reason: "invalid_action_payload",
    message: "Township action request invalid: payload could not be accepted.",
  },
);

assert.deepEqual(parseTownshipActionIntentDeepLink(actionUrl({ ...fixture.payload, v: 3 })), {
  ok: false,
  reason: "unsupported_action_version",
  message: "Township action request invalid: unsupported version.",
});
assert.deepEqual(
  parseTownshipActionIntentDeepLink(
    actionUrl({
      ...statusFixture.payload,
      command: { ...statusFixture.payload.command, text: "smuggled" },
    }),
  ),
  {
    ok: false,
    reason: "invalid_action_payload",
    message: "Township action request invalid: payload could not be accepted.",
  },
);
assert.deepEqual(parseTownshipActionIntentDeepLink(actionUrl({ ...statusFixture.payload, command: null })), {
  ok: false,
  reason: "invalid_action_payload",
  message: "Township action request invalid: payload could not be accepted.",
});

for (const payload of [
  { ...fixture.payload, v: 1, command: { command: "close_matter" } },
  { ...statusFixture.payload, command: { command: "post" } },
  { ...statusFixture.payload, command: { command: "admit" } },
  { ...statusFixture.payload, command: { ...statusFixture.payload.command, member: "smuggled" } },
  { ...statusFixture.payload, command: { ...statusFixture.payload.command, cap: "smuggled" } },
  { ...statusFixture.payload, extra: "smuggled" },
  { ...statusFixture.payload, id: "not-an-id" },
  { ...statusFixture.payload, replica: " " },
  { ...fixture.payload, extra: "smuggled" },
  { ...fixture.payload, id: "not-an-id" },
  { ...fixture.payload, replica: " " },
  { ...fixture.payload, command: { ...fixture.payload.command, command: "set_summary" } },
  { ...fixture.payload, command: { ...fixture.payload.command, text: " " } },
  { ...fixture.payload, command: { ...fixture.payload.command, text: "x".repeat(4_097) } },
  { ...fixture.payload, command: { ...fixture.payload.command, cap: "smuggled" } },
]) {
  assert.equal(parseTownshipActionIntentDeepLink(actionUrl(payload)).ok, false, JSON.stringify(payload));
}

console.log("\x1b[32m✓ Township action-intent contract checks passed\x1b[0m");

function actionUrl(payload: unknown): string {
  return `township://action?intent=${encoded(payload)}`;
}

function encoded(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
