import assert from "node:assert/strict";
import { test } from "node:test";

// M1a.4 AuditView: everything, unfiltered. Quarantine reasons are the judge's raw strings and must equal
// Sim's authorityQuarantine verbatim (the app's closed reason union would collapse some of them).

test("audit view lists every quarantined op with Sim's reason, and the grants and frontier", async () => {
  const { viewReplica } = await import("../../src/session/projections/replica_view");
  const { projectAuditView } = await import("../../src/session/projections/audit_view");
  const { loadTreehouseVector } = await import("../support/vectors");
  const { heads } = await import("../support/group_fixture");

  for (const name of ["treehouse_space_membership", "treehouse_space_roles", "treehouse_thread_conflicts", "treehouse_thread_archive"]) {
    const vector = loadTreehouseVector(name);
    const view = viewReplica(vector.replica, vector.product, vector.frames);
    const route = { replica: vector.replica, connection: "live" as const, pending: 0, acked: 0, generation: 7, matchesRelay: true, refused: [], submitStopped: null, message: "" };
    const audit = projectAuditView({ views: [view], feed: { configured: true, routes: [route] } });
    const entry = audit.replicas[0]!;
    assert.equal(entry.replica, vector.replica);
    assert.equal(entry.opCount, vector.frames.length, `${name}: op count`);
    assert.deepEqual(
      Object.fromEntries(entry.quarantined.map((q) => [q.id, q.reason])),
      vector.expected.quarantined,
      `${name}: quarantine equals Sim verbatim`,
    );
    assert.deepEqual(entry.frontier, heads(vector.frames), `${name}: frontier`);
    assert.equal(entry.generation, 7);
    assert.equal(entry.matchesRelay, true);
    assert.ok(entry.grants.length > 0, `${name}: grants listed`);
    for (const grant of entry.grants) assert.ok(["usable", "revoked", "lapsed", "not_usable"].includes(grant.state));
  }
});

test("audit view marks a revoked grant revoked (M1b.7; was not_live)", async () => {
  const { viewReplica } = await import("../../src/session/projections/replica_view");
  const { projectAuditView } = await import("../../src/session/projections/audit_view");
  const { buildGroup, heads } = await import("../support/group_fixture");
  const { revokeThreadGrant } = await import("../support/authoring");
  const { memberCapability } = await import("@treetopdevs/lattice-client");
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const grant = memberCapability(group.thread.frames, member.pubkey, group.thread.replica, { product: "Treehouse.Thread", command: "post" })!;
  const revoke = await revokeThreadGrant(group, member, group.thread.frames, heads(group.thread.frames));
  const audit = projectAuditView({
    views: [viewReplica(group.thread.replica, "Treehouse.Thread", [...group.thread.frames, revoke])],
    feed: { configured: false, routes: [] },
  });
  const entry = audit.replicas[0]!;
  assert.equal(entry.grants.find((g) => g.id === grant.id)?.state, "revoked");
  assert.equal(entry.generation, null);
  assert.equal(entry.matchesRelay, null);
});
