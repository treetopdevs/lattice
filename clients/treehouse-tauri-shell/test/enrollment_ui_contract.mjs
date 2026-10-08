import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "@vue/compiler-sfc";
import { NodeTypes, ElementTypes } from "@vue/compiler-core";

// Plan 181 S2c: the enrollment panel exists only in the VITE_TREEHOUSE_ENROLLMENT=1 build. This test
// builds the ordinary bundle and the enrollment bundle for real and scans both, and it reads the
// component sources structurally. It needs no Tauri runtime.

const DISCLOSURE =
  "The relay operator, and anyone with its host, backups or admitted peers, can read this group's plaintext log, and the host can withhold availability. The relay cannot decide who may act in the group.";
const ENROLLMENT_FINE_PRINT =
  "Relay routes are hand-configured by an operator and are not signed by any catalog. Recovery comes later.";
const OLD_FINE_PRINT =
  "There are no members or connections yet. Inviting others and recovery come later.";
const REMOTE_ACK_OLD =
  "No operation has a remote delivery acknowledgement.";
const LABELS = [
  "Sync",
  "Sync status",
  "Join a group",
  "Join request",
  "Copy join request",
  "Paste join request",
  "Joiner realm",
  "Issue invitation",
  "Offer",
  "Copy offer",
  "Paste offer",
  "Use offer",
  "Confirm routes",
  "Accept invitation",
  "Acceptance",
  "Copy acceptance",
  "Paste acceptance",
  "Admit and grant",
  "Paste route list",
  "Configure routes",
];
const RETAINED = [
  "Local preview",
  "Recovery is not set up",
  "Group name",
  "Create local group",
  "Thread title",
  "Create thread",
  "Write a post",
  "Edit post",
  "Save edit",
  "Archive thread",
  "This thread is archived.",
  OLD_FINE_PRINT,
];
const PROHIBITED = [
  "nothing hosted",
  "serverless",
  "no server to",
  "nothing to seize",
  "use-limited",
  "does not orphan",
  "zero server dependency",
  "guaranteed availability",
  "there is no landlord",
  "uncapturable",
  "ttl'd",
  "no registry to scrape",
  "cannot be deleted, paywalled",
  "decentralized",
  "centerless",
  "host mode",
  "self-hosted by members",
  "provisioned",
  "two devices",
  "two packaged apps",
  "separately packaged",
  "native-custody identity",
  "survive founder loss",
  "recover your",
];

function build(enrollment) {
  const out = mkdtempSync(join(tmpdir(), "treehouse-ui-"));
  try {
    const env = { ...process.env };
    delete env.VITE_TREEHOUSE_ENROLLMENT;
    if (enrollment) env.VITE_TREEHOUSE_ENROLLMENT = "1";
    execFileSync(
      "node_modules/.bin/vite",
      ["build", "--outDir", out, "--emptyOutDir", "--logLevel", "error"],
      { env, stdio: ["ignore", "inherit", "inherit"] },
    );
    const assets = join(out, "assets");
    return readdirSync(assets)
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(join(assets, f), "utf8"))
      .join("\n");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

// A label counts as present only as a whole string literal, so "Offer" does not match a longer word.
const hasLiteral = (bundle, text) =>
  ['"', "'", "`"].some((q) => bundle.includes(`${q}${text}${q}`));
const ordinary = build(false);
const enrolled = build(true);

for (const literal of RETAINED)
  assert(ordinary.includes(literal), `ordinary build lost literal: ${literal}`);
for (const literal of [...LABELS, DISCLOSURE, ENROLLMENT_FINE_PRINT])
  assert(
    !hasLiteral(ordinary, literal) && !(literal.length > 30 && ordinary.includes(literal)),
    `ordinary build leaked enrollment text: ${literal}`,
  );
assert(!ordinary.includes("subscribeAvailability"));
assert(!ordinary.includes("carrier hello"), "ordinary build leaked the relay client");
for (const label of LABELS)
  assert(hasLiteral(enrolled, label), `enrollment build lacks label: ${label}`);
assert(
  enrolled.includes("subscribeAvailability"),
  "enrollment build lacks the relay feed wiring",
);
assert(
  !enrolled.includes(REMOTE_ACK_OLD),
  "enrollment build still claims no remote acknowledgement exists",
);
assert(ordinary.includes(REMOTE_ACK_OLD), "ordinary build lost its audit sentence");
assert(enrolled.includes("Relay preview"), "enrollment build lacks its masthead tag");
assert(enrolled.includes(DISCLOSURE), "enrollment build lacks the disclosure");
assert(
  enrolled.includes(ENROLLMENT_FINE_PRINT),
  "enrollment build lacks its fine print",
);
// Every packaged-preview literal the existing harness drives stays present.
for (const literal of RETAINED.filter(
  (l) => l !== "Local preview" && l !== OLD_FINE_PRINT,
))
  assert(enrolled.includes(literal), `enrollment build lost literal: ${literal}`);

// Structural reading of the sources: stable accessible labels, one action per button.
const sources = ["src/App.vue", "src/EnrollmentPanel.vue"].map((path) => ({
  path,
  sfc: parse(readFileSync(path, "utf8"), { filename: path }).descriptor,
}));
const walk = (node, visit) => {
  visit(node);
  for (const child of node.children ?? []) if (typeof child === "object") walk(child, visit);
};
const textOf = (node) => {
  let text = "";
  walk(node, (n) => {
    if (n.type === NodeTypes.TEXT) text += n.content;
    if (n.type === NodeTypes.INTERPOLATION) text += " ";
  });
  return text.replace(/\s+/g, " ").trim();
};
const labelsFound = new Set();
const buttons = [];
const staticText = [];
for (const { sfc } of sources) {
  if (!sfc.template) continue;
  walk(sfc.template.ast, (node) => {
    if (node.type === NodeTypes.TEXT) staticText.push(node.content);
    if (node.type !== NodeTypes.ELEMENT) return;
    for (const prop of node.props) {
      if (prop.type === NodeTypes.ATTRIBUTE && prop.name === "aria-label" && prop.value)
        labelsFound.add(prop.value.content);
      if (prop.type === NodeTypes.ATTRIBUTE && prop.value) staticText.push(prop.value.content);
    }
    if (node.tag === "button") {
      const aria = node.props.find((p) => p.type === NodeTypes.ATTRIBUTE && p.name === "aria-label");
      const click = node.props.find(
        (p) => p.type === NodeTypes.DIRECTIVE && p.name === "on" && p.arg?.content === "click",
      );
      buttons.push({
        label: aria?.value?.content ?? textOf(node),
        handler: click?.exp?.loc.source ?? null,
      });
    }
  });
}
for (const label of LABELS)
  assert(labelsFound.has(label), `no aria-label="${label}" in the sources`);

// No button combines Sign and Sync: no button label names both, and the Sign handlers never reach a
// sync call.
for (const button of buttons)
  assert(
    !(/sign|accept|admit|post/i.test(button.label) && /\bsync/i.test(button.label)),
    `button combines Sign and Sync: ${button.label}`,
  );
const script = sources.map(({ sfc }) => sfc.scriptSetup?.content ?? "").join("\n");
for (const name of ["acceptInvitation", "admitAndGrant", "post", "issueInvitation"]) {
  const body = new RegExp(`async function ${name}\\(\\)[^]*?\\n\\}`).exec(script);
  assert(body, `no handler ${name}`);
  assert(!/\bsync/i.test(body[0]), `Sign handler ${name} reaches Sync`);
}
// Sync is its own button, it is the only one whose handler reaches the network, and the status panel
// carries the pinned disclosure.
const syncButtons = buttons.filter((b) => b.handler?.includes("syncRelay"));
assert.equal(syncButtons.length, 1, "exactly one button runs Sync");
assert.equal(syncButtons[0].label, "Sync");
for (const name of ["confirmRoutes", "configureRoutes", "useOffer", "joinGroup"]) {
  const body = new RegExp(`async function ${name}\\(\\)[^]*?\\n\\}`).exec(script);
  assert(body, `no handler ${name}`);
  assert(!/syncRelay|relayLink\.sync\(/.test(body[0]), `${name} reaches Sync`);
}
{
  const panel = sources.find((s) => s.path.endsWith("EnrollmentPanel.vue"));
  let status = null;
  walk(panel.sfc.template.ast, (node) => {
    if (
      node.type === NodeTypes.ELEMENT &&
      node.props.some(
        (p) => p.type === NodeTypes.ATTRIBUTE && p.name === "aria-label" && p.value?.content === "Sync status",
      )
    )
      status = node;
  });
  assert(status, "no Sync status section");
  let interpolations = "";
  walk(status, (n) => {
    if (n.type === NodeTypes.INTERPOLATION) interpolations += n.content.loc.source + "\n";
  });
  assert(interpolations.includes("DISCLOSURE"), "Sync status lacks the disclosure");
  assert(/pending/.test(interpolations) && /acked/.test(interpolations), "Sync status lacks counts");
}
// Each moderator action is gated on its own operation, never on another one's capability.
{
  const app = sources.find((s) => s.path === "src/App.vue");
  const disabledOf = (predicate) => {
    let found = null;
    walk(app.sfc.template.ast, (node) => {
      if (node.type !== NodeTypes.ELEMENT || node.tag !== "button" || !predicate(node)) return;
      found = node.props.find((p) => p.type === NodeTypes.DIRECTIVE && p.name === "bind" && p.arg?.content === "disabled")
        ?.exp?.loc.source ?? null;
    });
    return found;
  };
  const aria = (node) => node.props.find((p) => p.type === NodeTypes.DIRECTIVE && p.name === "bind" && p.arg?.content === "aria-label")
    ?.exp?.loc.source ?? "";
  assert.equal(disabledOf((n) => textOf(n) === "Archive thread"), "!canArchive");
  assert.match(disabledOf((n) => textOf(n) === "Create thread"), /^!canCreateThread \|\|/);
  assert.equal(disabledOf((n) => aria(n).includes("as moderator")), "!canHideAsModerator");
  const appScript = app.sfc.scriptSetup.content;
  assert(/canArchive = computed\(\(\) => canModerate\("archive_thread"\)\)/.test(appScript));
  assert(/canHideAsModerator = computed\(\(\) => canModerate\("moderator_tombstone"\)\)/.test(appScript));
}
const shown = ["Use offer", "Accept invitation", "Admit and grant", "Issue invitation"];
for (const label of shown)
  assert(buttons.some((b) => b.label === label && b.handler), `${label} is not a button`);

// Prohibited phrases never appear in the enrollment copy.
const copy = [enrolled, ...staticText].join("\n").toLowerCase();
for (const phrase of PROHIBITED)
  assert(!copy.includes(phrase), `prohibited phrase in enrollment copy: ${phrase}`);
const emDash = String.fromCharCode(0x2014);
for (const path of ["src/EnrollmentPanel.vue", "test/enrollment_ui_contract.mjs"])
  assert(!readFileSync(path, "utf8").includes(emDash), `em dash in ${path}`);
console.log(
  "PASS enrollment UI contract: labels, disclosure, ordinary build unchanged, one action per button",
);
