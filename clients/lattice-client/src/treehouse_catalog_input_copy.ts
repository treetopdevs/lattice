import {CATALOG_RAW_NODE_LIMIT} from "./treehouse_catalog_raw_bounds";

function malformed(): never { throw new Error("malformed_catalog"); }

// Storage buckets, not an input limit. Keep each weak table small even when
// a valid observation contains millions of distinct composite values.
class CompletedObjects {
  private readonly buckets = [new WeakSet<object>()];
  private entries = 0;
  has(value: object): boolean {
    for (let index = this.buckets.length - 1; index >= 0; index--) {
      if (this.buckets[index]!.has(value)) return true;
    }
    return false;
  }
  add(value: object): void {
    if (this.entries === 1_000_000) { this.buckets.push(new WeakSet<object>()); this.entries = 0; }
    this.buckets[this.buckets.length - 1]!.add(value);
    this.entries++;
  }
}

function* children(value: object): Generator<unknown> {
  const array = Array.isArray(value);
  let keys: (string | symbol)[];
  try { keys = Reflect.ownKeys(value); }
  catch (error) {
    if (!array || !(error instanceof RangeError)) throw error;
    // Only this engine failure permits the operator-approved exception for
    // hidden non-index decorations. Own enumerable keys and descriptors never read them;
    // structuredClone drops them. Ordinary arrays keep all-own-key validation.
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > CATALOG_RAW_NODE_LIMIT) malformed();
    if (Object.getOwnPropertySymbols(value).length !== 0) malformed();
    // Own-only enumeration avoids executing traps on an array's prototype.
    for (const key of Object.keys(value)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) malformed();
    }
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined) continue; // Preserve sparse-array clone semantics.
      if (!Object.hasOwn(descriptor, "value")) malformed();
      yield descriptor.value;
    }
    return;
  }
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string") malformed();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) malformed();
    yield descriptor.value;
  }
}

// JSON ownership only: this performs no signature, authority or trust validation.
export function copyCatalogInput<T>(input: T): T {
  const pending: {values: Iterator<unknown>; owner?: object}[] = [{values: [input].values()}];
  const active = new WeakSet<object>(), finished = new CompletedObjects();
  while (pending.length > 0) {
    const current = pending[pending.length - 1]!, next = current.values.next();
    if (next.done) {
      if (current.owner !== undefined) { active.delete(current.owner); finished.add(current.owner); }
      pending.pop(); continue;
    }
    const value = next.value;
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") continue;
    if (typeof value !== "object" || active.has(value)) malformed();
    if (finished.has(value)) continue;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) malformed();
    active.add(value);
    pending.push({values: children(value), owner: value});
  }
  return structuredClone(input);
}
