import assert from "node:assert/strict";
import { test } from "node:test";

// M1a.4 Roster: petnames from the local store, my own relay access from the Space route, a removal
// still waiting to send, and the per-replica moderator check (03, "Moderator authority is held per replica").

test("roster shows petnames, my relay access and a removal that is still waiting to send", async () => {
  const { viewReplica } = await import("../../src/session/projections/replica_view");
  const { projectRoster } = await import("../../src/session/projections/roster");
  const { buildGroup } = await import("../support/group_fixture");
  const { authorAs, rootCap } = await import("../support/authoring");

  const group = await buildGroup({ members: 2 });
  const [alice, bob] = group.members as [typeof group.members[0], typeof group.members[0]];
  const removal = await authorAs(group.admin, "Treehouse.Space", group.space.frames, { command: "remove_member", recipient: bob.pubkey }, rootCap(group.space.frames));
  const space = viewReplica(group.space.replica, "Treehouse.Space", [...group.space.frames, removal]);
  const thread = viewReplica(group.thread.replica, "Treehouse.Thread", group.thread.frames);
  const route = { replica: group.space.replica, connection: "live" as const, pending: 1, acked: 0, generation: 1, matchesRelay: true, refused: [], submitStopped: null, message: "" };

  const roster = projectRoster({
    space,
    threads: [thread],
    myKey: group.admin.pubkey,
    petname: (key) => (key === alice.pubkey ? "Alice" : null),
    spaceRoute: route,
    waitingIds: new Set([removal.id]),
  });
  const entry = (key: string) => roster.members.find((m) => m.pubkey === key);
  assert.equal(entry(alice.pubkey)?.petname, "Alice");
  assert.equal(entry(group.admin.pubkey)?.relayAccess, "admitted", "my own relay access comes from the Space route");
  assert.equal(entry(alice.pubkey)?.relayAccess, null, "other members' relay access is unknown");
  assert.equal(entry(bob.pubkey)?.removalPending, true, "a removed member stays listed while the removal waits to send");
  assert.equal(entry(alice.pubkey)?.removalPending, false);
  assert.equal(roster.moderatorMismatch, false, "the Space and Thread moderators are both the root");
  const unpulled = viewReplica("replica:treehouse:thread:unpulled", "Treehouse.Thread", []);
  const beforeFirstPull = projectRoster({ space, threads: [thread, unpulled], myKey: group.admin.pubkey, petname: () => null, spaceRoute: route, waitingIds: new Set() });
  assert.equal(beforeFirstPull.moderatorMismatch, false, "an adopted Thread with no frames yet is not a moderator conflict");

  const acked = projectRoster({ space, threads: [thread], myKey: group.admin.pubkey, petname: () => null, spaceRoute: route, waitingIds: new Set() });
  assert.equal(acked.members.find((m) => m.pubkey === bob.pubkey), undefined, "once on the relay the removal is final");
});

test("roster reports a moderator mismatch when the Space and a Thread disagree", async () => {
  const { viewReplica } = await import("../../src/session/projections/replica_view");
  const { projectRoster } = await import("../../src/session/projections/roster");
  const { buildGroup } = await import("../support/group_fixture");
  const { loadTreehouseVector } = await import("../support/vectors");
  const group = await buildGroup({ members: 1 });
  // The archive vector's Thread has a different root, so its moderator differs from this Space's.
  const vector = loadTreehouseVector("treehouse_thread_archive");
  const roster = projectRoster({
    space: viewReplica(group.space.replica, "Treehouse.Space", group.space.frames),
    threads: [viewReplica(vector.replica, "Treehouse.Thread", vector.frames)],
    myKey: null,
    petname: () => null,
    spaceRoute: null,
    waitingIds: new Set(),
  });
  assert.equal(roster.moderatorMismatch, true);
});
