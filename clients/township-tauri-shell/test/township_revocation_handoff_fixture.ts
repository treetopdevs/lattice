import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  carrierDelegationsFromFrames,
  type CarrierOpFrame,
} from "@treetopdevs/lattice-client";
import { runBeamSupport } from "./support/beam_peer";
import { seededEd25519Identity } from "./support/packaged_action_handoff";

interface Projection {
  opIds: string[];
  readModel: {
    threads: { posts: string[]; [key: string]: unknown };
    roles: { reasons: Record<string, string>; [key: string]: unknown };
    [key: string]: unknown;
  };
  causalReplay: { nodes: Array<{ id: string }>; [key: string]: unknown };
}

interface RevocationHandoffOracle {
  replica: string;
  issuerRealm: string;
  issuerPubkey: string;
  recipientRealm: string;
  recipientPubkey: string;
  sourceFrontier: string[];
  source: Projection;
  grant: { delegationId: string; frame: CarrierOpFrame };
  preRevokeUse: { text: string; frame: CarrierOpFrame };
  revoke: { frame: CarrierOpFrame; after: Projection };
  recipientPull: { after: Projection };
  revokedUse: { text: string; reason: "revoked_capability"; frame: CarrierOpFrame; after: Projection };
}

console.log("\n▸ Township revocation-handoff fixture");

const root = mkdtempSync(join(tmpdir(), "township-revocation-fixture-"));

try {
  await runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_revocation_handoff_fixture.exs",
    [root],
    "REVOCATION_FIXTURE_READY",
  );

  const sourcePath = join(root, "matter.log");
  const oraclePath = join(root, "oracle.json");
  assert.ok(existsSync(sourcePath));
  const oracle = JSON.parse(readFileSync(oraclePath, "utf8")) as RevocationHandoffOracle;
  const issuer = seededEd25519Identity(`township-g1:${oracle.issuerRealm}`);
  const recipient = seededEd25519Identity(`township-g1:${oracle.recipientRealm}`);

  assert.equal(oracle.issuerPubkey, issuer.publicKeyBase64);
  assert.equal(oracle.recipientPubkey, recipient.publicKeyBase64);
  assert.notEqual(oracle.issuerPubkey, oracle.recipientPubkey);

  const [delegation] = carrierDelegationsFromFrames([oracle.grant.frame]);
  assert.ok(delegation);
  assert.equal(delegation.id, oracle.grant.delegationId);
  assert.equal(delegation.replica, oracle.replica);
  assert.equal(delegation.issuer, oracle.issuerPubkey);
  assert.equal(delegation.audience, oracle.recipientPubkey);
  assert.deepEqual(delegation.ops, ["post"]);

  assert.equal(oracle.preRevokeUse.frame.author, oracle.recipientPubkey);
  assert.deepEqual(oracle.revoke.frame.deps, oracle.sourceFrontier);
  assert.equal(frameCommandName(oracle.revoke.frame), "revoke");
  assert.deepEqual(oracle.revokedUse.frame.deps, [oracle.revoke.frame.id]);
  assert.equal(oracle.revokedUse.frame.author, oracle.recipientPubkey);

  assert.deepEqual(oracle.revoke.after.opIds, [...oracle.source.opIds, oracle.revoke.frame.id].sort());
  assert.deepEqual(oracle.recipientPull.after, oracle.revoke.after);
  assert.deepEqual(
    oracle.revokedUse.after.opIds,
    [...oracle.revoke.after.opIds, oracle.revokedUse.frame.id].sort(),
  );
  assert.equal(oracle.revokedUse.reason, "revoked_capability");
  assert.equal(
    oracle.revokedUse.after.readModel.roles.reasons[oracle.revokedUse.frame.id],
    "revoked_capability",
  );
  assert.deepEqual(oracle.revokedUse.after.readModel.threads.posts, oracle.source.readModel.threads.posts);
  assert.ok(oracle.source.readModel.threads.posts.includes(oracle.preRevokeUse.text));
  assert.ok(!oracle.revokedUse.after.readModel.threads.posts.includes(oracle.revokedUse.text));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("\u001b[32m✓ Township revocation-handoff fixture checks passed\u001b[0m");

function frameCommandName(frame: CarrierOpFrame): string | undefined {
  const body = frame.body;
  return body?.[0] === "tuple" && body[1][0]?.[0] === "atom" ? body[1][0][1] : undefined;
}
