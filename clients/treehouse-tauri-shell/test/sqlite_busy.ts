import assert from "node:assert/strict";
import { isSqliteBusy, retryOnSqliteBusy } from "./support/sqlite_busy";

console.log("\n▸ Treehouse packaged store reader SQLITE_BUSY retry");

// Shapes of the error execFileSync throws when sqlite3 exits non-zero (encoding "utf8" gives string stderr).
const busy = { status: 5, stderr: "Error: in prepare, database is locked (5)\n" };
const busyBySignalText = { status: null, stderr: "Error: in prepare, database is locked (5)\n" };
const busyBufferText = { status: 1, stderr: Buffer.from("Error: stepping, database is locked (261)\n") };
const missingTable = { status: 1, stderr: "Error: in prepare, no such table: kv\n" };
const tableLocked = { status: 6, stderr: "Error: in prepare, database table is locked (6)\n" };
const killed = { status: null, stderr: "" };
const killedAfterLocked = { status: null, signal: "SIGTERM", stderr: "Error: in prepare, database is locked (5)\n" };
const missingBinary = Object.assign(new Error("spawnSync sqlite3 ENOENT"), { code: "ENOENT", status: null });
const overflowed = { status: null, signal: "SIGTERM", code: "ENOBUFS", stderr: "database is locked" };

function scripted<T>(failures: unknown[], value: T): { read: () => T; calls: () => number } {
  let calls = 0;
  return {
    read: () => {
      const failure = failures[calls++];
      if (failure !== undefined) throw failure;
      return value;
    },
    calls: () => calls,
  };
}

assert.equal(isSqliteBusy(busy), true, "exit status 5 is SQLITE_BUSY");
assert.equal(isSqliteBusy(busyBySignalText), true, "the locked stderr is SQLITE_BUSY without a status");
assert.equal(isSqliteBusy(busyBufferText), true, "a Buffer stderr is decoded");
assert.equal(isSqliteBusy(missingTable), false, "a missing table is not busy");
assert.equal(isSqliteBusy(tableLocked), false, "SQLITE_LOCKED (6) is not busy");
assert.equal(isSqliteBusy(killed), false, "a signal kill is not busy");
assert.equal(isSqliteBusy(killedAfterLocked), false, "a signal kill is not busy even after the locked text");
assert.equal(isSqliteBusy(missingBinary), false, "a missing sqlite3 binary is not busy");
assert.equal(isSqliteBusy(overflowed), false, "a maxBuffer overflow is not busy");
assert.equal(isSqliteBusy(new Error("database is locked")), false, "only stderr text counts");
assert.equal(isSqliteBusy("database is locked"), false, "a thrown string is not busy");
assert.equal(isSqliteBusy(null), false);
assert.equal(isSqliteBusy(undefined), false);

const recovers = scripted([busy, busyBySignalText], "[]");
assert.equal(retryOnSqliteBusy(recovers.read, 4, 1), "[]", "busy reads are retried until one succeeds");
assert.equal(recovers.calls(), 3);

const fatal = scripted([missingTable], "[]");
assert.throws(() => retryOnSqliteBusy(fatal.read, 4, 1), (error) => error === missingTable);
assert.equal(fatal.calls(), 1, "a non-busy failure surfaces on the first attempt");

const busyThenFatal = scripted([busy, killed], "[]");
assert.throws(() => retryOnSqliteBusy(busyThenFatal.read, 4, 1), (error) => error === killed);
assert.equal(busyThenFatal.calls(), 2, "a non-busy failure after a busy retry still surfaces at once");

const stuck = scripted([busy, busy, busy, busy, busy, busy], "[]");
assert.throws(() => retryOnSqliteBusy(stuck.read, 4, 1), (error) => error === busy);
assert.equal(stuck.calls(), 5, "a lock that never clears fails after the last retry");

const started = performance.now();
const backoff = scripted([busy, busy], "[]");
retryOnSqliteBusy(backoff.read, 4, 20);
assert.ok(performance.now() - started >= 55,"attempts are separated by an exponential backoff (20 ms + 40 ms)");

console.log("  ✓ only SQLITE_BUSY is retried, with backoff, and other failures surface on the first attempt");
