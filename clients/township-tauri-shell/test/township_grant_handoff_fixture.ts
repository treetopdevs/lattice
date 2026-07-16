import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import { runBeamSupport } from "./support/beam_peer";

interface GrantProjection {
  opIds: string[];
  readModel: {
    threads: { posts: string[]; [key: string]: unknown };
    members: unknown;
    roles: { quarantine: string[]; reasons: Record<string, string>; [key: string]: unknown };
    [key: string]: unknown;
  };
  causalReplay: { nodes: Array<{ id: string }>; [key: string]: unknown };
}

interface GrantHandoffOracle {
  replica: string;
  issuerRealm: string;
  issuerPubkey: string;
  recipientRealm: string;
  recipientPubkey: string;
  unsoundAudienceRealm: string;
  unsoundAudiencePubkey: string;
  baseAuthorPubkeys: string[];
  baseFrontier: string[];
  base: GrantProjection;
  soundGrant: {
    delegationId: string;
    parentDelegationId: string;
    frame: CarrierOpFrame;
    after: GrantProjection;
  };
  recipientUse: {
    text: string;
    frame: CarrierOpFrame;
    after: GrantProjection;
  };
  unsoundGrant: {
    delegationId: string;
    parentDelegationId: string;
    reason: "not_attenuated";
    frame: CarrierOpFrame;
    after: GrantProjection;
  };
  unsoundUse: {
    reason: "invalid_capability";
    frame: CarrierOpFrame;
    after: GrantProjection;
  };
}

console.log("\n▸ Township Sim delegation-grant handoff fixture");

const tempRoot = mkdtempSync(join(tmpdir(), "township-grant-fixture-"));
const sourcePath = join(tempRoot, "matter.log");
const oraclePath = join(tempRoot, "oracle.json");

try {
  await runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_grant_handoff_fixture.exs",
    [tempRoot],
    "GRANT_FIXTURE_READY",
  );

  assert.ok(existsSync(sourcePath), "fixture must dump the exact onboarding base log");
  const oracleText = readFileSync(oraclePath, "utf8");
  const oracle = JSON.parse(oracleText) as GrantHandoffOracle;

  assert.equal(oracle.issuerRealm, "clerk");
  assert.equal(oracle.recipientRealm, "grant-recipient");
  assert.equal(oracle.unsoundAudienceRealm, "unsound-audience");
  assert.notEqual(oracle.issuerPubkey, oracle.recipientPubkey);
  assert.notEqual(oracle.recipientPubkey, oracle.unsoundAudiencePubkey);
  assert.ok(oracle.baseAuthorPubkeys.includes(oracle.issuerPubkey));
  assert.equal(oracle.baseAuthorPubkeys.includes(oracle.recipientPubkey), false);

  assert.deepEqual(oracle.soundGrant.frame.deps, oracle.baseFrontier);
  assert.equal(oracle.soundGrant.frame.kind, "authority");
  assert.equal(oracle.soundGrant.frame.author, oracle.issuerPubkey);
  assert.equal(oracle.soundGrant.frame.body[0], "tuple");
  assert.equal(oracle.soundGrant.frame.body[1][0][1], "grant");
  assert.equal(oracle.soundGrant.after.opIds.length, oracle.base.opIds.length + 1);
  assert.ok(oracle.soundGrant.after.opIds.includes(oracle.soundGrant.frame.id));
  assert.equal(oracle.soundGrant.after.readModel.roles.reasons[oracle.soundGrant.frame.id], undefined);

  assert.equal(oracle.recipientUse.frame.kind, "command");
  assert.equal(oracle.recipientUse.frame.author, oracle.recipientPubkey);
  assert.deepEqual(oracle.recipientUse.frame.cap, ["bin", Buffer.from(oracle.soundGrant.delegationId).toString("base64")]);
  assert.equal(oracle.recipientUse.after.opIds.length, oracle.soundGrant.after.opIds.length + 1);
  assert.ok(oracle.recipientUse.after.readModel.threads.posts.includes(oracle.recipientUse.text));
  assert.equal(oracle.recipientUse.after.readModel.roles.reasons[oracle.recipientUse.frame.id], undefined);

  assert.equal(oracle.unsoundGrant.parentDelegationId, oracle.soundGrant.delegationId);
  assert.equal(oracle.unsoundGrant.frame.kind, "authority");
  assert.equal(oracle.unsoundGrant.frame.author, oracle.recipientPubkey);
  assert.equal(oracle.unsoundGrant.after.readModel.roles.reasons[oracle.unsoundGrant.frame.id], "not_attenuated");
  assert.equal(oracle.unsoundGrant.reason, "not_attenuated");

  assert.equal(oracle.unsoundUse.frame.kind, "command");
  assert.equal(oracle.unsoundUse.frame.author, oracle.unsoundAudiencePubkey);
  assert.deepEqual(oracle.unsoundUse.frame.cap, ["bin", Buffer.from(oracle.unsoundGrant.delegationId).toString("base64")]);
  assert.equal(oracle.unsoundUse.after.readModel.roles.reasons[oracle.unsoundGrant.frame.id], "not_attenuated");
  assert.equal(oracle.unsoundUse.after.readModel.roles.reasons[oracle.unsoundUse.frame.id], "invalid_capability");
  assert.equal(oracle.unsoundUse.reason, "invalid_capability");
  assert.deepEqual(oracle.unsoundUse.after.readModel.threads, oracle.recipientUse.after.readModel.threads);
  assert.deepEqual(oracle.unsoundUse.after.readModel.members, oracle.recipientUse.after.readModel.members);

  for (const stage of [oracle.base, oracle.soundGrant.after, oracle.recipientUse.after, oracle.unsoundGrant.after, oracle.unsoundUse.after]) {
    assert.deepEqual(stage.causalReplay.nodes.map((node) => node.id).sort(), [...stage.opIds].sort());
  }

  assert.doesNotMatch(
    oracleText,
    /"(?:priv(?:ate)?(?:_?(?:key|seed))?|secret(?:_?key)?|seed|sk)"\s*:/i,
  );
  console.log("\x1b[32m✓ Township delegation-grant fixture checks passed\x1b[0m");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
