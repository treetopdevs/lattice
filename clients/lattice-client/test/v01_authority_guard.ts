// V-01 fail-closed guard (stop-gap ahead of Plan 140).
//
// The TS reducer has no authority validation: `payloadFromBody` turns any
// signed transfer/succeed into a holder write and `isQuarantined` never gates
// authority ops. So a forged role transfer authored by a NON-holder was
// silently honored — inverting both the materialized holder and the quarantine
// set relative to the Lattice.Sim oracle (the V-01 STOP condition).
//
// Until Plan 140 ports real authority validation, `materialize` fails CLOSED:
// it refuses to reduce a log that changes an authority role beyond its
// establishing genesis, rather than guess who holds it. Genesis, delegation
// grants (__authority), commands, and CRDT fields are unaffected.
//
// Run:  npx tsx test/v01_authority_guard.ts   (from lattice-client/)

import { materialize, V01UnvalidatedAuthorityError } from "../src/index";
import type { Op, ReplicaSchema } from "../src/index";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag} ${name}`);
  if (!ok && detail) console.log(`       ${detail}`);
  if (!ok) failures++;
}

const schema: ReplicaSchema = {
  name: "Township.Matter",
  fields: {
    clerk: { authority: "clerk" },
    clerk_locked: { merge: "lww", gatedBy: "clerk", default: false },
    posts: { merge: "causal_list" },
  },
};

function op(part: Partial<Op> & Pick<Op, "id" | "kind" | "author" | "field" | "mutation" | "value">): Op {
  return { deps: [], hash: part.id, ...part } as Op;
}

// The genesis that establishes the clerk role. Always allowed.
const genesis = op({ id: "g", kind: "authority", author: "clerk", field: "clerk", mutation: "write", value: "clerk" });

// --- Case A: forged transfer by a non-holder MUST be refused, not honored ---
{
  const forged = op({
    id: "x",
    deps: ["g"],
    kind: "authority",
    author: "mallory", // NOT the current holder
    field: "clerk",
    mutation: "write",
    value: "mallory",
    command: "transfer clerk",
  });

  let threw: unknown = null;
  try {
    materialize(schema, [genesis, forged]);
  } catch (e) {
    threw = e;
  }
  check(
    "forged transfer by non-holder is refused (throws)",
    threw instanceof V01UnvalidatedAuthorityError,
    threw === null
      ? "materialize returned instead of refusing — the forged holder was silently honored"
      : `threw ${String(threw)} (wrong type)`,
  );
}

// --- Case B: genesis + delegation grant + command still reduces normally ---
{
  const grant = op({
    id: "gr",
    deps: ["g"],
    kind: "authority",
    author: "clerk",
    field: "__authority", // a delegation grant, not a role move
    mutation: "write",
    value: null,
    command: "grant resident",
  });
  const post = op({ id: "p", deps: ["gr"], kind: "command", author: "clerk", field: "posts", mutation: "append", value: "hello" });

  let result: ReturnType<typeof materialize> | null = null;
  let threw: unknown = null;
  try {
    result = materialize(schema, [genesis, grant, post]);
  } catch (e) {
    threw = e;
  }
  check("genesis + grant + command does not trigger the guard", threw === null, threw ? `threw ${String(threw)}` : undefined);
  check("commands still reduce under the guard", !!result && JSON.stringify(result.state.posts) === JSON.stringify(["hello"]), result ? `posts=${JSON.stringify(result.state.posts)}` : "no result");
  check("genesis-established holder still materializes", !!result && result.state.clerk === "clerk", result ? `clerk=${JSON.stringify(result.state.clerk)}` : "no result");
}

// --- Case C: with a replica anchor pinned, an evidence-free authority write
// carrying NO outer replica must still be refused, not silently quarantined.
// Regression pin for the 1baa4ae9 fail-open: the wrong_replica admission
// filter used to swallow anchor-less ops before writesPerRole accounting,
// bypassing the V-01 refusal (caught by township_feed.ts:562 in CI).
{
  const anchoredGenesis = op({
    id: "g",
    kind: "authority",
    author: "clerk",
    field: "clerk",
    mutation: "write",
    value: "clerk",
    replica: "matter-1",
  });
  const anchorless = op({
    id: "x",
    deps: ["g"],
    kind: "authority",
    author: "mallory",
    field: "clerk",
    mutation: "write",
    value: "mallory",
    command: "unvalidated clerk write",
    // deliberately no replica
  });

  let threw: unknown = null;
  try {
    materialize(schema, [anchoredGenesis, anchorless], undefined, null, "matter-1");
  } catch (e) {
    threw = e;
  }
  check(
    "anchor-less evidence-free authority write is refused under a pinned anchor (throws)",
    threw instanceof V01UnvalidatedAuthorityError,
    threw === null
      ? "materialize returned instead of refusing — the anchor-less write was silently quarantined"
      : `threw ${String(threw)} (wrong type)`,
  );
}

// --- Case D: an evidence-free authority write naming a FOREIGN replica is
// judgeable foreign evidence: quarantined as wrong_replica, reduction proceeds.
{
  const anchoredGenesis = op({
    id: "g",
    kind: "authority",
    author: "clerk",
    field: "clerk",
    mutation: "write",
    value: "clerk",
    replica: "matter-1",
  });
  const foreign = op({
    id: "x",
    deps: ["g"],
    kind: "authority",
    author: "mallory",
    field: "clerk",
    mutation: "write",
    value: "mallory",
    command: "unvalidated clerk write",
    replica: "matter-1:sibling",
  });

  let result: ReturnType<typeof materialize> | null = null;
  let threw: unknown = null;
  try {
    result = materialize(schema, [anchoredGenesis, foreign], undefined, null, "matter-1");
  } catch (e) {
    threw = e;
  }
  check("foreign-replica evidence-free write does not trigger the guard", threw === null, threw ? `threw ${String(threw)}` : undefined);
  check(
    "foreign-replica evidence-free write is quarantined as wrong_replica",
    !!result && result.quarantine.includes("x") && result.quarantineReasons.get("x") === "wrong_replica",
    result ? `quarantine=${JSON.stringify(result.quarantine)} reason=${result.quarantineReasons.get("x")}` : "no result",
  );
  check(
    "anchored genesis holder survives the foreign write",
    !!result && result.state.clerk === "clerk",
    result ? `clerk=${JSON.stringify(result.state.clerk)}` : "no result",
  );
}

console.log(`\n${failures === 0 ? "\x1b[32m✓ v01 authority guard holds\x1b[0m" : `\x1b[31m✗ ${failures} check(s) failed\x1b[0m`}`);
process.exit(failures === 0 ? 0 : 1);
