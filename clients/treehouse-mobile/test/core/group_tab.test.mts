import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// M1b.7 Group tab (04 Group tab: Relay, Safety, My key, Verify & audit, Export). Grant states and not-counted
// reasons come from the judge: a grant's state is lattice-client's treehouseDelegationStates answer (usable,
// revoked, lapsed; not_usable when the judge never honored it); a not-counted op carries the judge's raw
// quarantine reason. The references are signed posts citing each grant, judged by lattice-client's
// observeTreehouse over the frames the phone holds. src/ui/group_view.ts only puts facts into words.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

test("the audit lists the revoked grant and a not-counted op with the judge's reason", async () => {
  const { openPhone } = await import("../support/command_session");
  const { buildGroup, heads } = await import("../support/group_fixture");
  const { revokeThreadGrant } = await import("../support/authoring");
  const { authorTreehouseCommand, carrierOpsToSemanticOps, liveTreehouseDelegations, memberCapability, observeTreehouse, treehouseCommandDecoders } = await import(
    "@treetopdevs/lattice-client"
  );
  const { auditSections } = await import("../../src/ui/group_view");
  const { audit: auditCopy } = await import("../../src/ui/strings");
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const thread = group.thread.replica;
  const grant = memberCapability(group.thread.frames, member.pubkey, thread, { product: "Treehouse.Thread", command: "post" })!;
  // The admin revokes concurrently with the member's post: neither saw the other.
  const revoke = await revokeThreadGrant(group, member, group.thread.frames, heads(group.thread.frames));

  const phone = await openPhone({ group, as: () => member });
  try {
    const before = phone.session.read().audit.replicas.find((r) => r.replica === thread)!;
    assert.equal(before.grants.find((g) => g.id === grant.id)?.state, "usable", "the member's post grant is usable before the revoke");
    // Reference, independent of the projection: the judge honors a post citing that grant at this point.
    {
      const held = phone.threadProfile().frames;
      const probe = await authorTreehouseCommand({ product: "Treehouse.Thread", replica: thread, deps: heads(held), signer: member.signer, capId: grant.id, command: { command: "post", text: "probe" } });
      const judgedBefore = observeTreehouse("Treehouse.Thread", carrierOpsToSemanticOps([...held, probe], {}, treehouseCommandDecoders("Treehouse.Thread")));
      assert.equal(judgedBefore.quarantineReasons.has(probe.id), false, "the judge honors a post citing the usable grant");
    }

    const posted = await phone.session.postMessage(thread, "said while the revoke was on its way");
    assert.ok(posted.ok);
    await phone.deliver(thread, [revoke]);

    // References: lattice-client's judge and live-delegation projection over the frames this phone holds.
    const frames = phone.threadProfile().frames;
    const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Thread"));
    const judged = observeTreehouse("Treehouse.Thread", ops);
    const live = new Set(liveTreehouseDelegations("Treehouse.Thread", frames, thread).map((d) => d.id));
    assert.equal(judged.quarantineReasons.get(posted.value.id), "revoked_capability");
    assert.equal(live.has(grant.id), false, "lattice-client no longer lists the revoked grant as live");

    const models = phone.session.read();
    const entry = models.audit.replicas.find((r) => r.replica === thread)!;
    assert.equal(entry.grants.find((g) => g.id === grant.id)?.state, "revoked");
    assert.deepEqual(
      Object.fromEntries(entry.quarantined.map((q) => [q.id, q.reason])),
      Object.fromEntries(judged.quarantineReasons),
      "every not-counted op with the judge's raw reason",
    );

    const sections = auditSections(models.audit, {
      spaceReplica: group.space.replica,
      threads: models.threads,
      name: (key) => (key === member.pubkey ? "You" : "Key check"),
    });
    const section = sections.find((s) => s.replica === thread)!;
    assert.equal(section.title, models.threads.threads.find((t) => t.replica === thread)!.title);
    const row = section.grants.find((g) => g.id === grant.id)!;
    assert.equal(row.stateLabel, auditCopy.grantState.revoked);
    assert.match(row.text, /You/);
    assert.match(row.text, /post/);
    const notCounted = section.notCounted.find((q) => q.id === posted.value.id)!;
    assert.equal(notCounted.reason, "revoked_capability", "protocol words are allowed in Verify: the raw reason");
    assert.ok(notCounted.text.includes("revoked_capability"));
    assert.equal(sections[0]!.replica, group.space.replica, "the Group comes first");
    assert.equal(sections[0]!.title, auditCopy.groupSection);
    for (const s of sections) for (const f of s.facts) assert.ok(f.value.length > 0, `${s.title} ${f.label} has a value`);
  } finally {
    await phone.close();
  }
});

test("audit facts say 'not compared yet' before a sync and give the relay's generation after one", async () => {
  const { viewReplica } = await import("../../src/session/projections/replica_view");
  const { projectAuditView } = await import("../../src/session/projections/audit_view");
  const { auditSections } = await import("../../src/ui/group_view");
  const { audit: auditCopy } = await import("../../src/ui/strings");
  const { loadTreehouseVector } = await import("../support/vectors");
  const vector = loadTreehouseVector("treehouse_space_membership");
  const view = viewReplica(vector.replica, vector.product, vector.frames);
  const none = projectAuditView({ views: [view], feed: { configured: false, routes: [] } });
  const facts = (a: typeof none) =>
    Object.fromEntries(auditSections(a, { spaceReplica: vector.replica, threads: null, name: () => "Key check" })[0]!.facts.map((f) => [f.key, f.value]));
  assert.equal(facts(none).matchesRelay, auditCopy.notCompared);
  assert.equal(facts(none).generation, auditCopy.notCompared);
  assert.equal(facts(none).ops, String(vector.frames.length));
  const route = { replica: vector.replica, connection: "live" as const, pending: 0, acked: 0, generation: 9, matchesRelay: false, refused: [], submitStopped: null, message: "" };
  const synced = projectAuditView({ views: [view], feed: { configured: true, routes: [route] } });
  assert.equal(facts(synced).generation, "9");
  assert.equal(facts(synced).matchesRelay, auditCopy.no);
});

test("the relay section: address, connection and waiting per thread, and the pause switch follows the setting", async () => {
  const { relayOrigins } = await import("../../src/native/app_session");
  const { projectLinkStatus } = await import("../../src/session/projections/link_status");
  const { relayRows, syncSwitch } = await import("../../src/ui/group_view");
  const { relay: relayCopy } = await import("../../src/ui/strings");

  assert.deepEqual(
    relayOrigins([
      { url: "ws://127.0.0.1:4101/carrier/space?x=1" },
      { url: "ws://127.0.0.1:4101/carrier/thread" },
      { url: "wss://relay.example/carrier" },
    ]),
    ["ws://127.0.0.1:4101", "wss://relay.example"],
    "distinct origins only, no path or query",
  );

  const routes = [
    { replica: "space", connection: "live" as const, pending: 0, acked: 3, generation: 4, matchesRelay: true, refused: [], submitStopped: null, message: "" },
    { replica: "t1", connection: "reconnecting" as const, pending: 2, acked: 0, generation: null, matchesRelay: null, refused: [], submitStopped: null, message: "" },
  ];
  const feed = { configured: true, routes };
  const on = projectLinkStatus({ feed, space: "space", syncEnabled: true, waiting: 2, lastSyncMs: null });
  assert.equal(on.syncEnabled, true);
  const off = projectLinkStatus({ feed, space: "space", syncEnabled: false, waiting: 2, lastSyncMs: null });
  assert.equal(off.syncEnabled, false);
  // Every route idle also gives the Offline pill, but that is not the person's switch.
  const idle = projectLinkStatus({ feed: { configured: true, routes: routes.map((r) => ({ ...r, connection: "idle" as const })) }, space: "space", syncEnabled: true, waiting: 0, lastSyncMs: null });
  assert.equal(idle.pill, "offline");
  assert.equal(syncSwitch(idle).paused, false, "an idle link is not a paused one");
  assert.equal(syncSwitch(off).paused, true);
  assert.equal(syncSwitch(off).label, relayCopy.pauseSync);

  const threads = { threads: [{ replica: "t1", title: "Garden" } as never] };
  const rows = relayRows(on, threads, "space");
  assert.deepEqual(
    rows.map((r) => [r.label, r.connection, r.waiting]),
    [
      [relayCopy.groupRoute, relayCopy.connection.live, 0],
      ["Garden", relayCopy.connection.reconnecting, 2],
    ],
  );
  for (const r of rows) assert.ok(r.accessibilityLabel.includes(r.label) && r.accessibilityLabel.includes(r.connection));
  assert.match(rows[1]!.text, /2 waiting/);
});

test("the Safety card says what is and is not protected, without claims the app cannot keep", async () => {
  const { safetyLines, keyLines } = await import("../../src/ui/group_view");
  const { HOSTING_SENTENCE } = await import("../../src/ui/strings");
  const plain = safetyLines(null);
  const text = plain.join(" ");
  assert.match(text, /readable by the relay operator/i, "04: readable by the relay operator");
  assert.match(text, /no recovery if this phone is lost/i, "04: no recovery if this phone is lost");
  assert.match(text, /text only/i, "04: text only");
  // Plan 178 Founder loss: not survived today; manual admin transfer is the only handoff.
  assert.match(text, /admin's phone is lost, the group does not survive that today/i);
  assert.match(text, /only handoff/i);
  for (const line of plain) {
    assert.doesNotMatch(line, /encrypt|end-to-end|e2ee|secure/i, `no encryption claim: ${line}`);
    assert.doesNotMatch(line, /(deleted|removed|erased|wiped) from (their|other|everyone)/i, `no claim of deletion from others' phones: ${line}`);
    assert.doesNotMatch(line, /always available|guarantee|never (goes )?(down|offline)|uptime/i, `no availability claim: ${line}`);
    assert.notEqual(line, HOSTING_SENTENCE, "the Relay card holds the hosting sentence; Safety does not restate it");
  }
  const demo = safetyLines("Demo keys are public.");
  assert.equal(demo.length, plain.length + 1);
  assert.equal(demo.at(-1), "Demo keys are public.", "the demo line comes from the demo fence, last");

  const keychain = keyLines({ fingerprint: "ab12", source: "keychain" }).join(" ");
  assert.match(keychain, /ab12/);
  assert.match(keychain, /Keychain/);
  assert.match(keychain, /can't be moved to another phone/);
  assert.doesNotMatch(keyLines({ fingerprint: "ab12", source: "demo-seed" }).join(" "), /Kept in this phone's Keychain/);
});

test("the Group tab, audit route and file export are wired through the session and the UI helpers", () => {
  for (const f of ["src/ui/RelayCard.tsx", "src/ui/SafetyCard.tsx", "src/app/audit.tsx", "src/native/export_file.ts"]) assert.ok(existsSync(join(ROOT, f)), f);
  const layout = read("src/app/_layout.tsx");
  assert.match(layout, /name="audit"/);
  const group = read("src/app/(tabs)/group.tsx");
  assert.match(group, /<RelayCard/);
  assert.match(group, /<SafetyCard/);
  assert.match(group, /pathname: "\/audit"|href="\/audit"|push\("\/audit"\)/);
  assert.match(group, /exportHeld\(/);
  assert.doesNotMatch(group, /lattice-client/);
  const audit = read("src/app/audit.tsx");
  assert.match(audit, /auditSections\(/);
  assert.doesNotMatch(audit, /lattice-client/, "no protocol code in the route");
  // Export writes the D-31 text to a file first and shares the file; the text share stays as the fallback.
  const exporter = read("src/native/export_file.ts");
  assert.match(exporter, /from "expo-file-system"/);
  assert.match(exporter, /new File\(Paths\.document/);
  const provider = read("src/ui/SessionProvider.tsx");
  assert.match(provider, /writeExportFile\(/);
  // iOS shares the file's URL (Share's `url` is iOS only); Android shares the text; a failed write is said.
  assert.match(provider, /Platform\.OS === "ios" \? \{ url: written\.uri/);
  assert.match(provider, /setError\(exportFile\.writeFailed\)/);
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  assert.ok(pkg.dependencies["expo-file-system"], "expo-file-system is declared");
});

test("grant states and the post refusal follow the judge for lapsed and never-honored grants", async () => {
  // Review round (Codex and Neon): a grant the judge never honored must read not_usable in the audit and give
  // no refusal reason, even when its parent is later revoked; a lapsed lease reads lapsed and lease_expired.
  // References: lattice-client's observeTreehouse over a signed post citing each grant, never the projection.
  const { buildGroup, heads, testIdentity } = await import("../support/group_fixture");
  const { revokeThreadGrant, rootCap } = await import("../support/authoring");
  const { authorCarrierOp, authorTownshipDelegation, authorTreehouseCommand, carrierDelegationsFromFrames, carrierOpsToSemanticOps, memberCapability, observeTreehouse, treehouseCommandDecoders } = await import(
    "@treetopdevs/lattice-client"
  );
  const { viewReplica } = await import("../../src/session/projections/replica_view");
  const { projectAuditView } = await import("../../src/session/projections/audit_view");
  const { grantRefusal } = await import("../../src/session/projections/abilities");
  type Frame = Parameters<typeof heads>[0][number];

  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const replica = group.thread.replica;
  const judge = (frames: readonly Frame[]) =>
    observeTreehouse("Treehouse.Thread", carrierOpsToSemanticOps([...frames], {}, treehouseCommandDecoders("Treehouse.Thread"))).quarantineReasons;
  const idOf = (frame: Frame) => carrierDelegationsFromFrames([frame])[0]!.id;
  const postCiting = (who: ReturnType<typeof testIdentity>, frames: readonly Frame[], capId: string) =>
    authorTreehouseCommand({ product: "Treehouse.Thread", replica, deps: heads(frames), signer: who.signer, capId, command: { command: "post", text: "probe" } });
  let frames: Frame[] = [...group.thread.frames];

  // A leased grant to a key that holds no other grant, then a root beacon past its epoch.
  const leaseHolder = testIdentity("lease-holder");
  const leased = await authorTownshipDelegation({ replica, deps: heads(frames), audiencePubkey: leaseHolder.signer.publicKey, parentId: rootCap(frames), ops: ["post"], roles: [], live: false, expiresEpoch: 3, signer: group.admin.signer });
  frames = [...frames, leased];
  // A grant a stranger forges under the member's grant (an invalid record).
  const memberGrant = memberCapability(frames, member.pubkey, replica, { product: "Treehouse.Thread", command: "post" })!;
  const forgedHolder = testIdentity("forged-holder");
  const forged = await authorTownshipDelegation({ replica, deps: heads(frames), audiencePubkey: forgedHolder.signer.publicKey, parentId: memberGrant.id, ops: ["post"], roles: [], live: false, signer: testIdentity("stranger").signer });
  frames = [...frames, forged];
  const beacon = await authorCarrierOp({ replica, deps: heads(frames), kind: "authority", body: ["tuple", [["atom", "beacon"], ["int", 5]]], cap: ["nil"], signer: group.admin.signer });
  frames = [...frames, beacon];
  frames = [...frames, await revokeThreadGrant(group, member, frames, heads(frames))];

  // The judge, independently: what a post citing each grant now gets.
  assert.equal(judge(frames).has(beacon.id), false, "the beacon is valid");
  const verdict = async (who: ReturnType<typeof testIdentity>, frame: Frame) => judge([...frames, await postCiting(who, frames, idOf(frame))]).get((await postCiting(who, frames, idOf(frame))).id);
  assert.equal(await verdict(leaseHolder, leased), "lease_expired");
  const forgedVerdict = await verdict(forgedHolder, forged);
  assert.ok(forgedVerdict !== undefined, "the forged sub-grant cannot be cited");

  const view = viewReplica(replica, "Treehouse.Thread", frames);
  const states = Object.fromEntries(projectAuditView({ views: [view], feed: { configured: false, routes: [] } }).replicas[0]!.grants.map((g) => [g.id, g.state]));
  assert.equal(states[idOf(leased)], "lapsed");
  assert.equal(states[memberGrant.id], "revoked");
  assert.equal(grantRefusal(view, leaseHolder.pubkey, "post"), "lease_expired");
  assert.equal(grantRefusal(view, member.pubkey, "post"), "revoked_capability");
  // A grant the judge never honored (here an invalid record) was never usable: the revoke of its parent is
  // not a reason the admin took it away. A valid record introduced only by a refused frame is excluded by the
  // same lattice-client query (treehouseDelegationStates); no fixture builds one (authority grant frames are
  // not refused for who relays them), recorded in PROGRESS.
  assert.equal(states[idOf(forged)], "not_usable", `forged sub-grant (${forgedVerdict})`);
  assert.equal(grantRefusal(view, forgedHolder.pubkey, "post"), null);
});
