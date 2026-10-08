import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

// Copy exact, explicitly selected v2 value modules, never the server application tree.
// Generated files are ignored. Re-running before compilation prevents drift.
export const sources = ["identity.ex", "canonical.ex", "op.ex", "authority/delegation.ex", "authority/succession_certificate.ex", "authority/continuation.ex", "authority/continuation_certificate.ex", "authority/beacon_certificate.ex", "authority.ex", "replica.ex", "log.ex", "dag.ex", "sync.ex", "sync/shape.ex", "reduce.ex", "crdt/causal_list.ex", "crdt/lww.ex", "crdt/or_set.ex", "carrier/wire.ex", "browser_log_store.ex"];

// Plan 185: the domain Replica modules named by the Sim-exported vector corpus
// (`schema.name` in clients/lattice-client/test/vectors/*.json), plus everything they
// alias or call. Paths are relative to apps/lattice_core/lib/ and copied byte-for-byte.
export const domainSources = [
  "lattice/demo/thread.ex", "lattice/authority/consent.ex",
  "township/matter.ex", "township/election_board.ex",
  "toolshed/shed.ex", "toolshed/tool.ex",
  "treehouse/space.ex", "treehouse/thread.ex", "treehouse/invitation.ex",
  "treehouse/transport_catalog.ex", "treehouse/member_continuity.ex",
  "treehouse/member_continuity_certificate.ex", "treehouse/member_continuity_authoring.ex"
];

// The DualAuthorityFixture and PolicyFixture schemas are defined at the head of the
// exporter Mix task. Copy exactly that byte prefix (everything before the task module),
// so the vectors are judged by the same fixture source without bringing Mix code along.
export const fixtureSlices = [{
  file: "mix/tasks/lattice.export_vectors.ex",
  until: "defmodule Mix.Tasks.Lattice.ExportVectors do\n",
  target: "fixtures/export_vector_fixtures.ex"
}];

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export async function prepareShared() {
  const hashes = {};
  for (const file of sources) {
    const bytes = await readFile(new URL(`../../lattice_core/lib/lattice/${file}`, import.meta.url));
    const target = new URL(`../browser/lib/shared/${file}`, import.meta.url);
    await mkdir(new URL(".", target), { recursive: true });
    await writeFile(target, bytes);
    hashes[file] = sha256(bytes);
  }
  for (const file of domainSources) {
    const bytes = await readFile(new URL(`../../lattice_core/lib/${file}`, import.meta.url));
    const target = new URL(`../browser/lib/shared/domain/${file}`, import.meta.url);
    await mkdir(new URL(".", target), { recursive: true });
    await writeFile(target, bytes);
    hashes[`lib/${file}`] = sha256(bytes);
  }
  for (const { file, until, target: out } of fixtureSlices) {
    const bytes = await readFile(new URL(`../../lattice_core/lib/${file}`, import.meta.url));
    const end = bytes.indexOf(Buffer.from(until));
    if (end <= 0) throw new Error(`fixture slice anchor missing in ${file}`);
    // Drop the blank separator line(s) before the task module so the slice ends at `end\n`.
    let stop = end;
    while (stop > 1 && bytes[stop - 1] === 0x0a && bytes[stop - 2] === 0x0a) stop--;
    const slice = bytes.subarray(0, stop);
    const target = new URL(`../browser/lib/shared/${out}`, import.meta.url);
    await mkdir(new URL(".", target), { recursive: true });
    await writeFile(target, slice);
    hashes[`lib/${file}#prefix`] = sha256(slice);
    hashes[`lib/${file}`] = sha256(bytes);
  }
  return hashes;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log(JSON.stringify(await prepareShared(), null, 2));
}
