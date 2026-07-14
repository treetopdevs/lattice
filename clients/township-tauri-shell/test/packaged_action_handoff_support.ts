import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPackagedActionHandoffHarness,
  delay,
  escapeRegex,
  readKvValues,
  requiredValue,
  seededEd25519Identity,
  sortedEntries,
  storageKey,
  storedIds,
  traceLineCount,
  traceLines,
  waitFor,
  writeNativeKv,
} from "./support/packaged_action_handoff";

console.log("\n▸ Packaged action-handoff support");

const root = mkdtempSync(join(tmpdir(), "township-action-support-"));

try {
  const kvPath = join(root, "native-kv.json");
  assert.equal(storageKey("pairing"), "township:zoning-variance-24:pairing");
  const values = new Map<string, string>([
    [storageKey("z"), "last"],
    [storageKey("a"), JSON.stringify([{ id: "second" }, { id: "first" }])],
  ]);

  writeNativeKv(kvPath, values);
  assert.deepEqual(JSON.parse(readFileSync(kvPath, "utf8")), Object.fromEntries(sortedEntries(values)));
  assert.deepEqual(readKvValues(kvPath), values);
  assert.equal(requiredValue(values, storageKey("z")), "last");
  assert.deepEqual(storedIds(values, "a"), ["first", "second"]);
  assert.throws(() => requiredValue(values, "missing"), /missing native KV value/);

  const tracePath = join(root, "trace.log");
  writeFileSync(tracePath, "ready\r\n\r\nready\nsigned\n");
  assert.deepEqual(traceLines(tracePath), ["ready", "ready", "signed"]);
  assert.equal(traceLineCount(tracePath, "ready"), 2);
  assert.equal(traceLineCount(join(root, "absent.log"), "ready"), 0);

  const harness = createPackagedActionHandoffHarness({
    shellRoot: root,
    appBundlePath: join(root, "Township.app"),
    appIdentifier: "dev.treetop.lattice.township.test",
    tracePath,
    kvPath,
    toolPath: process.env.PATH ?? "",
  });
  assert.deepEqual(harness.readKvValues(), values);
  await harness.waitForStoredIds("a", ["first", "second"], 50);
  await harness.waitForTraceLine("signed", 50);
  assert.equal(await harness.runCapture(process.execPath, ["-e", "process.stdout.write('captured')"], root), "captured");

  const identity = seededEd25519Identity("support-contract-seed");
  assert.equal(identity.publicKeyBase64, "kBctCncFMtzfNrLexIEooZIoSqLy8Cn/w9YeOMe1Qpg=");
  assert.equal((JSON.parse(identity.privateSeedBytesJson) as number[]).length, 32);

  let attempts = 0;
  await waitFor("eventual value", 250, async () => ++attempts === 2, async () => "not ready", 1);
  assert.equal(attempts, 2);

  await assert.rejects(
    () => waitFor("missing value", 5, async () => false, async () => "still missing", 1),
    /timed out waiting for missing value: still missing/,
  );

  assert.equal(escapeRegex("a+b?."), "a\\+b\\?\\.");
  await delay(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("\u001b[32m✓ Packaged action-handoff support checks passed\u001b[0m");
