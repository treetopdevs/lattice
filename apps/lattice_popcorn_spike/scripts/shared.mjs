import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

// Copy exact, explicitly selected v2 value modules, never the server application tree.
// Generated files are ignored. Re-running before compilation prevents drift.
export const sources = ["identity.ex", "canonical.ex", "op.ex", "authority/delegation.ex", "authority/succession_certificate.ex", "authority.ex", "replica.ex", "log.ex", "dag.ex", "sync.ex", "sync/shape.ex", "reduce.ex", "crdt/causal_list.ex", "crdt/lww.ex", "crdt/or_set.ex", "carrier/wire.ex", "browser_log_store.ex"];
export async function prepareShared() {
  const hashes = {};
  for (const file of sources) {
    const bytes = await readFile(new URL(`../../lattice_core/lib/lattice/${file}`, import.meta.url));
    const target = new URL(`../browser/lib/shared/${file}`, import.meta.url);
    await mkdir(new URL(".", target), { recursive: true });
    await writeFile(target, bytes);
    hashes[file] = createHash("sha256").update(bytes).digest("hex");
  }
  return hashes;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log(JSON.stringify(await prepareShared(), null, 2));
}
