import assert from "node:assert/strict";
import { test } from "node:test";
import type { CarrierOpFrame, TreehouseCommand, TreehouseProduct } from "@treetopdevs/lattice-client";

// M1a.4 Abilities. The reference is the judge, reached independently of the projection: the test signs each
// command for each key with that key's real signer, citing every delegation the replica holds (and none),
// and asks lattice-client's materialize whether any of them would be honored. A Sim anchor then checks the
// projection against every command op in the Sim vectors, over that op's own causal past.

/** Reasons that depend on a command's arguments or target, which a per-command ability does not judge. */
const ARGUMENT_REASONS = new Set([
  "malformed_command",
  "application_invalid_invitation",
  "application_wrong_author",
  "application_target_not_visible",
  "application_target_quarantined",
  "application_wrong_target",
  "application_already_tombstoned",
]);

test("abilities match the judge: every allowed command is honored when authored, every refused one is not", async () => {
  const L = await import("@treetopdevs/lattice-client");
  const { viewReplica } = await import("../../src/session/projections/replica_view");
  const { projectAbilities } = await import("../../src/session/projections/abilities");
  const { buildGroup, heads, testIdentity } = await import("../support/group_fixture");
  const { authorAs, rootCap } = await import("../support/authoring");
  const { loadTreehouseVector, productOf } = await import("../support/vectors");

  // ---- property over a real group, real signers -------------------------------------------------------
  const group = await buildGroup({ members: 2 });
  const [alice, bob] = group.members as [typeof group.members[0], typeof group.members[0]];
  const outsider = testIdentity("outsider");
  const everyone = [group.admin, alice, bob, outsider];
  const thread = [...group.thread.frames];
  const own = new Map<string, string>();
  for (const who of [group.admin, alice, bob]) {
    const cap = L.memberCapability(thread, who.pubkey, group.thread.replica, { product: "Treehouse.Thread", command: "post" });
    const post = await authorAs(who, "Treehouse.Thread", thread, { command: "post", text: `from ${who.realm}` }, cap?.id ?? rootCap(thread));
    thread.push(post);
    own.set(who.pubkey, post.id);
  }
  const archive = await authorAs(group.admin, "Treehouse.Thread", thread, { command: "archive_thread" }, rootCap(thread));
  const invitation = L.carrierOpsToSemanticOps([...group.space.frames], {}, L.treehouseCommandDecoders("Treehouse.Space")).find(
    (op) => op.command === "issue_invitation",
  )!.id;
  const fresh = Buffer.alloc(32, 3).toString("base64");

  const commandsFor = (product: TreehouseProduct, who: string): TreehouseCommand[] => {
    if (product === "Treehouse.Space")
      return [
        { command: "issue_invitation", recipient: fresh, threads: [group.thread.replica] },
        { command: "revoke_invitation", invitationId: invitation },
        { command: "remove_member", recipient: bob.pubkey },
        { command: "create_thread", title: "Another", threadReplica: "replica:treehouse:thread:another" },
      ];
    const mine = own.get(who) ?? own.get(alice.pubkey)!;
    return [
      { command: "post", text: "hello" },
      { command: "author_edit", postId: mine, targetId: mine, text: "edited" },
      { command: "author_tombstone", postId: mine, targetId: mine },
      { command: "moderator_tombstone", postId: own.get(alice.pubkey)!, targetId: own.get(alice.pubkey)! },
      { command: "archive_thread" },
    ];
  };
  const schemaOf = (product: TreehouseProduct) => (product === "Treehouse.Space" ? L.treehouseSpaceSchema : L.treehouseThreadSchema);
  const judgeHonors = async (who: (typeof everyone)[number], product: TreehouseProduct, frames: CarrierOpFrame[], command: TreehouseCommand) => {
    const caps = [null, ...L.carrierDelegationsFromFrames(frames).map((d) => d.id)];
    for (const capId of caps) {
      const frame = await authorAs(who, product, frames, command, capId, heads(frames));
      const ops = L.carrierOpsToSemanticOps([...frames, frame], {}, L.treehouseCommandDecoders(product));
      if (!L.materialize(schemaOf(product), ops).quarantineReasons.has(frame.id)) return true;
    }
    return false;
  };

  let checked = 0;
  // Roles handed to alice: the admin's own root delegation stays live, but the judge refuses it (not_holder).
  const genesisOf = (frames: CarrierOpFrame[]) => L.carrierDelegationsFromFrames([frames[0]!])[0]!;
  const adminMove = await L.authorTreehouseRoleTransfer({
    replica: group.space.replica, deps: heads(group.space.frames), signer: group.admin.signer,
    parent: genesisOf(group.space.frames), recipient: alice.pubkey, action: "transfer_admin",
  });
  const moderatorMove = await L.authorTreehouseRoleTransfer({
    replica: group.thread.replica, deps: heads(thread), signer: group.admin.signer,
    parent: genesisOf(thread), recipient: alice.pubkey, action: "change_moderator",
  });
  const states: [string, CarrierOpFrame[], CarrierOpFrame[]][] = [
    ["open", group.space.frames, thread],
    ["archived", group.space.frames, [...thread, archive]],
    ["roles moved to alice", [...group.space.frames, adminMove.frame], [...thread, moderatorMove.frame]],
  ];
  let notHolder = 0;
  for (const [label, spaceFrames, threadFrames] of states) {
    const replicas: [string, TreehouseProduct, CarrierOpFrame[]][] = [
      [group.space.replica, "Treehouse.Space", spaceFrames],
      [group.thread.replica, "Treehouse.Thread", threadFrames],
    ];
    const views = replicas.map(([replica, product, frames]) => viewReplica(replica, product, frames));
    for (const who of everyone) {
      const abilities = projectAbilities({ views, myKey: who.pubkey });
      for (const [replica, product, frames] of replicas) {
        for (const command of commandsFor(product, who.pubkey)) {
          const ability = abilities.replicas[replica]![command.command]!;
          const honored = await judgeHonors(who, product, frames, command);
          assert.equal(ability.allowed, honored, `${label}: ${who.realm} ${command.command} (${JSON.stringify(ability)})`);
          if (!ability.allowed && ability.reason === "not_holder") notHolder++;
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 3 * 4 * 9);
  assert.ok(notHolder > 0, "the transferred state exercises the holder check");

  // No key: nothing is allowed, and the reason says so.
  const keyless = projectAbilities({ views: [viewReplica(group.thread.replica, "Treehouse.Thread", thread)], myKey: null });
  assert.deepEqual(keyless.replicas[group.thread.replica]!.post, { allowed: false, reason: "identity_unavailable" });

  // ---- Sim anchor: every command op in the vectors, judged over its own causal past -------------------
  let anchored = 0;
  for (const name of ["treehouse_space_membership", "treehouse_space_roles", "treehouse_thread_conflicts", "treehouse_thread_archive"]) {
    const vector = loadTreehouseVector(name);
    const product = productOf(vector.replica);
    const byId = new Map(vector.frames.map((f) => [f.id, f]));
    const ops = L.carrierOpsToSemanticOps([...vector.frames], {}, L.treehouseCommandDecoders(product));
    for (const op of ops) {
      if (op.kind !== "command" || !op.command) continue;
      const reason = vector.expected.quarantined[op.id];
      if (reason !== undefined && ARGUMENT_REASONS.has(reason)) continue;
      const past = new Set<string>();
      const stack = [...op.deps];
      while (stack.length) {
        const id = stack.pop()!;
        if (past.has(id)) continue;
        past.add(id);
        stack.push(...byId.get(id)!.deps);
      }
      const frames = vector.frames.filter((f) => past.has(f.id));
      const author = byId.get(op.id)!.author;
      const ability = projectAbilities({ views: [viewReplica(vector.replica, product, frames)], myKey: author }).replicas[vector.replica]![op.command]!;
      assert.equal(ability.allowed, reason === undefined, `${name}: ${vector.realmByPubkey[author]} ${op.command} (Sim: ${reason ?? "honored"})`);
      anchored++;
    }
  }
  assert.ok(anchored >= 10, `anchored ${anchored} Sim command ops`);
});

test("the abilities delegation match equals memberCapability for every key and command over the vectors", async () => {
  // The app's per-command delegation match (audience, ops, roles over liveTreehouseDelegations) must be
  // exactly lattice-client's memberCapability, evaluated at every causal prefix of every vector.
  const L = await import("@treetopdevs/lattice-client");
  const { viewReplica } = await import("../../src/session/projections/replica_view");
  const { abilityOf } = await import("../../src/session/projections/abilities");
  const { loadTreehouseVector, productOf } = await import("../support/vectors");
  let compared = 0;
  let granted = 0;
  let denied = 0;
  for (const name of ["treehouse_space_membership", "treehouse_space_roles", "treehouse_thread_conflicts", "treehouse_thread_archive"]) {
    const vector = loadTreehouseVector(name);
    const product = productOf(vector.replica);
    const keys = Object.keys(vector.realmByPubkey);
    const commands = [...L.treehouseCommandDecoders(product).keys()];
    for (let n = 1; n <= vector.frames.length; n++) {
      const frames = vector.frames.slice(0, n);
      const view = viewReplica(vector.replica, product, frames);
      for (const key of keys)
        for (const command of commands) {
          const upstream = L.memberCapability(frames, key, vector.replica, { product, command }) !== null;
          const mine = abilityOf(view, key, command);
          const matched = mine.allowed || mine.reason !== "no_capability";
          assert.equal(matched, upstream, `${name}@${n}: ${vector.realmByPubkey[key]} ${command}`);
          if (upstream) granted++;
          else denied++;
          compared++;
        }
    }
  }
  assert.ok(compared > 100, `compared ${compared}`);
  assert.ok(granted > 0 && denied > 0, `both verdicts exercised: ${granted} granted, ${denied} denied`);
});
