import assert from "node:assert/strict";
import { test } from "node:test";

// M1a.4 GroupSummary and Roster against the Sim Space vectors. Sim names holders by realm; the test maps
// realms to keys with the vector's own realmByPubkey, never inside a projection.

test("group summary, roster and roles equal Sim for treehouse_space_membership and treehouse_space_roles", async () => {
  const { viewReplica } = await import("../../src/session/projections/replica_view");
  const { projectGroupSummary } = await import("../../src/session/projections/group_summary");
  const { projectRoster } = await import("../../src/session/projections/roster");
  const { loadTreehouseVector } = await import("../support/vectors");

  for (const name of ["treehouse_space_membership", "treehouse_space_roles"]) {
    const vector = loadTreehouseVector(name);
    const state = vector.expected.state as {
      name: string;
      members: string[];
      threads: { replica: string }[];
      admin: string;
      moderator: string;
    };
    const keyOf = (realm: string) => Object.entries(vector.realmByPubkey).find(([, r]) => r === realm)![0];
    const adminKey = keyOf(state.admin);
    const moderatorKey = keyOf(state.moderator);
    const rootKey = keyOf("root");
    const space = viewReplica(vector.replica, "Treehouse.Space", vector.frames);

    for (const me of [...Object.keys(vector.realmByPubkey), null]) {
      const summary = projectGroupSummary({ space, myKey: me })!;
      assert.equal(summary.name, state.name, `${name}: name`);
      assert.equal(summary.admin, adminKey, `${name}: admin holder`);
      assert.equal(summary.moderator, moderatorKey, `${name}: moderator holder`);
      assert.equal(summary.threadSlots.used, state.threads.length, `${name}: slots used`);
      const expectedRoles = [
        ...(me === adminKey ? ["admin"] : []),
        ...(me === moderatorKey ? ["moderator"] : []),
        ...(me !== null && state.members.includes(me) ? ["member"] : []),
      ];
      assert.deepEqual(summary.myRoles, expectedRoles, `${name}: my roles as ${me === null ? "no key" : vector.realmByPubkey[me]}`);

      const roster = projectRoster({ space, threads: [], myKey: me, petname: () => null, spaceRoute: null, waitingIds: new Set() });
      const expectedKeys = new Set([rootKey, adminKey, moderatorKey, ...state.members]);
      assert.deepEqual(new Set(roster.members.map((m) => m.pubkey)), expectedKeys, `${name}: roster keys`);
      assert.equal(summary.memberCount, expectedKeys.size, `${name}: member count`);
      for (const entry of roster.members) {
        assert.equal(entry.isRoot, entry.pubkey === rootKey, `${name}: is-root`);
        assert.deepEqual(
          entry.roles,
          [...(entry.pubkey === adminKey ? ["admin"] : []), ...(entry.pubkey === moderatorKey ? ["moderator"] : [])],
          `${name}: roles of ${vector.realmByPubkey[entry.pubkey]}`,
        );
        assert.equal(entry.isMe, entry.pubkey === me);
      }
    }
  }
});

test("group summary counts thread slots against the lite cap and reports initialization", async () => {
  const { viewReplica } = await import("../../src/session/projections/replica_view");
  const { projectGroupSummary } = await import("../../src/session/projections/group_summary");
  const { buildGroup } = await import("../support/group_fixture");
  const { TREEHOUSE_LITE_THREAD_CAP } = await import("@treetopdevs/lattice-client");
  const group = await buildGroup({ members: 1 });
  const summary = projectGroupSummary({ space: viewReplica(group.space.replica, "Treehouse.Space", group.space.frames), myKey: group.admin.pubkey })!;
  assert.equal(summary.name, "Canopy");
  assert.deepEqual(summary.threadSlots, { used: 1, total: 12 }, "slots are the contract's 12 Threads per Space");
  assert.equal(summary.inviteScopeCap, TREEHOUSE_LITE_THREAD_CAP, "the invitation scope cap is reported separately");
  assert.equal(summary.initialization, "ready");
  assert.equal(projectGroupSummary({ space: null, myKey: null }), null);
});
