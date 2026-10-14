/**
 * SQLITE_BUSY retry for the packaged gates' read-only store evidence.
 *
 * The packaged harnesses read the running app's kv table with `sqlite3 -readonly`. A read that meets
 * the app's write lock exits 5 with "database is locked (5)" (extended codes such as 261 keep the
 * same text). That one error is retried after a short backoff; every other failure (missing table,
 * bad SQL, signal, buffer overflow) is rethrown on the first attempt so a real fault still surfaces.
 */
export function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { status, stderr } = error as { status?: unknown; stderr?: unknown };
  if (status === 5) return true;
  const text = typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
  return /database is locked/.test(text);
}

const pause = new Int32Array(new SharedArrayBuffer(4));

/** Runs `read`, retrying only SQLITE_BUSY up to `retries` times with exponential backoff. Synchronous. */
export function retryOnSqliteBusy<T>(read: () => T, retries = 4, backoffMs = 200): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return read();
    } catch (error) {
      if (attempt >= retries || !isSqliteBusy(error)) throw error;
      Atomics.wait(pause, 0, 0, backoffMs * 2 ** attempt);
    }
  }
}
