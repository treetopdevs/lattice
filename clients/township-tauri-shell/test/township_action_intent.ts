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

interface FieldActionIntentFixture {
  payload: {
    v: 3;
    id: string;
    replica: string;
    command: { command: "set_summary"; text: string };
  };
  url: string;
}

interface TitleActionIntentFixture {
  payload: {
    v: 3;
    id: string;
    replica: string;
    command: { command: "set_title"; text: string };
  };
  url: string;
}

interface RemoveMemberActionIntentFixture {
  payload: {
    v: 4;
    id: string;
    replica: string;
    command: { command: "remove_member"; member: string };
  };
  url: string;
}

interface AdmitActionIntentFixture {
  payload: {
    v: 4;
    id: string;
    replica: string;
    command: { command: "admit"; member: string };
  };
  url: string;
}

interface GrantActionIntentFixture {
  payload: {
    v: 5;
    id: string;
    replica: string;
    authority: {
      action: "grant";
      audience: string;
      ops: ["admit", "post", "set_summary", "set_title"];
      roles: [];
      live: false;
    };
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
const fieldFixture = JSON.parse(
  readFileSync(join(here, "fixtures", "township_field_action_intent_v3.json"), "utf8"),
) as FieldActionIntentFixture;
const titleFixture = JSON.parse(
  readFileSync(join(here, "fixtures", "township_title_action_intent_v3.json"), "utf8"),
) as TitleActionIntentFixture;
const removeMemberFixture = JSON.parse(
  readFileSync(join(here, "fixtures", "township_remove_member_action_intent_v4.json"), "utf8"),
) as RemoveMemberActionIntentFixture;
const admitFixture = JSON.parse(
  readFileSync(join(here, "fixtures", "township_admit_action_intent_v4.json"), "utf8"),
) as AdmitActionIntentFixture;
const grantFixture = JSON.parse(
  readFileSync(join(here, "fixtures", "township_grant_action_intent_v5.json"), "utf8"),
) as GrantActionIntentFixture;

assert.deepEqual(parseTownshipActionIntentDeepLink(fixture.url), {
  ok: true,
  intent: fixture.payload,
});
assert.deepEqual(parseTownshipActionIntentDeepLink(statusFixture.url), {
  ok: true,
  intent: statusFixture.payload,
});
assert.deepEqual(parseTownshipActionIntentDeepLink(fieldFixture.url), {
  ok: true,
  intent: fieldFixture.payload,
});
assert.deepEqual(parseTownshipActionIntentDeepLink(titleFixture.url), {
  ok: true,
  intent: titleFixture.payload,
});
assert.deepEqual(parseTownshipActionIntentDeepLink(removeMemberFixture.url), {
  ok: true,
  intent: removeMemberFixture.payload,
});
assert.deepEqual(parseTownshipActionIntentDeepLink(admitFixture.url), {
  ok: true,
  intent: admitFixture.payload,
});

const grantAudience = grantFixture.payload.authority.audience;

for (const audience of [
  ` ${grantAudience}`,
  `${grantAudience} `,
  "",
  "not-base64!",
  grantAudience.slice(0, -1),
  `${grantAudience.slice(0, -2)}F=`,
  Buffer.alloc(31, 0x41).toString("base64"),
  Buffer.alloc(33, 0x41).toString("base64"),
  Buffer.alloc(32, 0xff).toString("base64").replaceAll("/", "_"),
  "A".repeat(4_097),
  42,
  null,
]) {
  assertInvalidPayload({
    ...grantFixture.payload,
    authority: { ...grantFixture.payload.authority, audience },
  });
}

for (const authority of [
  { ...grantFixture.payload.authority, action: "revoke" },
  { ...grantFixture.payload.authority, ops: ["post", "admit", "set_summary", "set_title"] },
  { ...grantFixture.payload.authority, ops: ["admit", "post", "set_summary"] },
  { ...grantFixture.payload.authority, roles: ["resident"] },
  { ...grantFixture.payload.authority, live: true },
  { ...grantFixture.payload.authority, cap: "smuggled" },
]) {
  assertInvalidPayload({ ...grantFixture.payload, authority });
}

for (const payload of [
  { ...grantFixture.payload, command: { command: "post", text: "smuggled" } },
  { ...grantFixture.payload, text: "smuggled" },
  { ...grantFixture.payload, member: "smuggled" },
  { ...grantFixture.payload, cap: "smuggled" },
  { ...grantFixture.payload, deps: [] },
  { ...grantFixture.payload, author: "smuggled" },
  { ...grantFixture.payload, signature: "smuggled" },
  { ...grantFixture.payload, private_key: "smuggled" },
  { ...grantFixture.payload, extra: "smuggled" },
  { ...grantFixture.payload, id: "not-an-id" },
  { ...grantFixture.payload, replica: " " },
  {
    v: 1,
    id: fixture.payload.id,
    replica: fixture.payload.replica,
    authority: grantFixture.payload.authority,
  },
]) {
  assertInvalidPayload(payload);
}

assert.deepEqual(parseTownshipActionIntentDeepLink(grantFixture.url), {
  ok: true,
  intent: grantFixture.payload,
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

assert.deepEqual(parseTownshipActionIntentDeepLink(actionUrl({ ...fixture.payload, v: 6 })), {
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
  { ...fixture.payload, v: 3 },
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
  { ...fieldFixture.payload, command: { ...fieldFixture.payload.command, command: "post" } },
  { ...fieldFixture.payload, command: { ...fieldFixture.payload.command, text: " " } },
  { ...fieldFixture.payload, command: { ...fieldFixture.payload.command, text: "x".repeat(4_097) } },
  { ...fieldFixture.payload, command: { ...fieldFixture.payload.command, member: "smuggled" } },
  { ...fieldFixture.payload, extra: "smuggled" },
  { ...fixture.payload, v: 4 },
]) {
  assert.equal(parseTownshipActionIntentDeepLink(actionUrl(payload)).ok, false, JSON.stringify(payload));
}

for (const member of [" ", " resident:alice ", "x".repeat(4_097), 42, null]) {
  assertInvalidPayload({
    ...removeMemberFixture.payload,
    command: { ...removeMemberFixture.payload.command, member },
  });
}

for (const payload of [
  {
    ...removeMemberFixture.payload,
    command: { ...removeMemberFixture.payload.command, text: "smuggled" },
  },
  {
    ...removeMemberFixture.payload,
    command: { ...removeMemberFixture.payload.command, cap: "smuggled" },
  },
  {
    ...removeMemberFixture.payload,
    command: { command: "post", member: "resident:alice" },
  },
  { ...removeMemberFixture.payload, v: 3 },
  { ...removeMemberFixture.payload, extra: "smuggled" },
]) {
  assertInvalidPayload(payload);
}

for (const member of ["\uFEFFresident:alice\uFEFF", "\u0085resident:alice\u0085", "x".repeat(4_096)]) {
  const payload = {
    ...removeMemberFixture.payload,
    command: { ...removeMemberFixture.payload.command, member },
  };
  assert.deepEqual(parseTownshipActionIntentDeepLink(actionUrl(payload)), {
    ok: true,
    intent: payload,
  });
}

console.log("\x1b[32m✓ Township action-intent contract checks passed\x1b[0m");

function actionUrl(payload: unknown): string {
  return `township://action?intent=${encoded(payload)}`;
}

function encoded(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function assertInvalidPayload(payload: unknown): void {
  assert.deepEqual(parseTownshipActionIntentDeepLink(actionUrl(payload)), {
    ok: false,
    reason: "invalid_action_payload",
    message: "Township action request invalid: payload could not be accepted.",
  });
}
