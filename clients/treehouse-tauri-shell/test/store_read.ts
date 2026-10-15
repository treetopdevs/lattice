import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STORE_READ_OPTIONS, parseStoreRows, readKv, readStore, storeReadArgs } from "./support/store_read";

// The packaged gates read the app's live store through support/store_read. This test runs the real sqlite3 CLI
// against a throwaway database (never an app store) while a separate sqlite3 process holds an exclusive write
// lock, as an app write does. It proves the bare reader fails "database is locked" (the packaged macOS failure on
// main at 1017cb8f3), the helper's reader waits for the writer and then sees its commit, and the helper cannot
// write.

console.log("\n▸ Treehouse packaged store reader (real sqlite3 write lock)");

const KV = "SELECT key,value FROM kv ORDER BY key;";
const dir = mkdtempSync(join(tmpdir(), "treehouse-store-read-"));
const database = join(dir, "treehouse-v1.sqlite3");
let writer: ChildProcess | undefined;
try {
  execFileSync("sqlite3", [
    database,
    "CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE frames(id TEXT); INSERT INTO kv VALUES('a','1');",
  ]);
  assert.deepEqual(readKv(database), [{ key: "a", value: "1" }]);
  assert.deepEqual(readStore(database, "SELECT count(*) AS n FROM frames;"), [{ n: 0 }]);
  assert.deepEqual(readStore(database, "SELECT key FROM kv WHERE key = 'missing';"), [], "an empty result is no rows");
  console.log("  ✓ reads kv rows, a frame count and an empty result");

  // The writer takes the exclusive lock, says so, then holds it until it is told to commit.
  const held = spawn("sqlite3", [database], { stdio: ["pipe", "pipe", "inherit"] });
  writer = held;
  const exited = new Promise<number | null>((resolve) => held.once("exit", resolve));
  const locked = new Promise<void>((resolve, reject) => {
    let out = "";
    held.stdout!.on("data", (chunk) => {
      out += String(chunk);
      if (out.includes("locked")) resolve();
    });
    void exited.then((code) => reject(new Error(`the writer exited (${code}) before taking the lock`)));
    setTimeout(() => reject(new Error("the writer did not report the lock within 10 s")), 10_000).unref();
  });
  held.stdin!.write("BEGIN EXCLUSIVE; INSERT INTO kv VALUES('b','2'); SELECT 'locked';\n");
  await locked;

  assert.throws(
    () => execFileSync("sqlite3", ["-readonly", "-json", database, KV], { encoding: "utf8", stdio: "pipe" }),
    (error: { stderr?: string }) => /database is locked/u.test(error.stderr ?? ""),
    "control: a reader with no busy timeout fails at once while the write lock is held",
  );
  console.log("  ✓ control: a bare reader fails \"database is locked\" during the write");

  let settled = false;
  const read = new Promise<string>((resolve, reject) =>
    execFile("sqlite3", storeReadArgs(database, KV), STORE_READ_OPTIONS, (error, stdout) => {
      settled = true;
      if (error) reject(error);
      else resolve(stdout);
    }),
  );
  // An early failure is reported by the assertion below, with cleanup, not as an unhandled rejection.
  read.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(settled, false, "the helper's reader is still waiting while the write lock is held");
  held.stdin!.end("COMMIT;\n");
  assert.equal(await exited, 0, "the writer committed");
  assert.deepEqual(parseStoreRows(await read), [
    { key: "a", value: "1" },
    { key: "b", value: "2" },
  ]);
  console.log("  ✓ the helper's reader waits out the write and then sees the commit");

  console.log("  (sqlite3 reports the refused write below; that refusal is the expected result)");
  assert.throws(
    () => readStore(database, "INSERT INTO kv VALUES('c','3');"),
    (error: { stderr?: string }) => /readonly/u.test(error.stderr ?? ""),
    "the helper opens the store read-only",
  );
  assert.deepEqual(readKv(database), [
    { key: "a", value: "1" },
    { key: "b", value: "2" },
  ]);
  console.log("  ✓ the helper cannot write the store");
} finally {
  if (writer && writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
