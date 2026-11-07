import {CATALOG_RAW_NODE_LIMIT, CATALOG_RAW_STRING_LIMIT, CATALOG_RAW_EVIDENCE_DEPTH_LIMIT} from "./treehouse_catalog_raw_bounds";

function malformed(): never { throw new Error("malformed_catalog"); }
export class CatalogInputResourceError extends Error {}

// Small summaries fit a small integer; larger summaries use a single bigint.
// No summary object is allocated for each of millions of small composites.
type Summary = number | bigint;
const metricBits = BigInt(Math.ceil(Math.log2(Math.max(CATALOG_RAW_NODE_LIMIT, CATALOG_RAW_STRING_LIMIT) + 2)));
const metricMask = (1n << metricBits) - 1n;
function summary(nodes: number, bytes: number, depth: number): Summary {
  return nodes < 1024 && bytes < 1024 && depth < 256 ? nodes * 256 + depth + bytes * 262144 :
    BigInt(nodes) | (BigInt(bytes) << metricBits) | (BigInt(depth) << (2n * metricBits));
}
const nodeCount = (v: Summary): number => typeof v === "number" ? Math.floor(v / 256) % 1024 : Number(v & metricMask);
const stringCount = (v: Summary): number => typeof v === "number" ? Math.floor(v / 262144) : Number((v >> metricBits) & metricMask);
const containerDepth = (v: Summary): number => typeof v === "number" ? v % 256 : Number(v >> (2n * metricBits));

class CaptureMemo {
  private readonly buckets = [new WeakMap<object, Summary>()];
  private lastLongString?: string;
  private lastLongStringBytes = 0;
  private entries = 0;
  get(value: object): Summary | undefined {
    for (let index = this.buckets.length - 1; index >= 0; index--) {
      const found = this.buckets[index]!.get(value);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  byteLength(value: string): number {
    // Reuse one long value across adjacent rows. A content-keyed Map can
    // compare a long string with many equal-length entries on a hash collision.
    if (value.length < 1024 || value.length > CATALOG_RAW_STRING_LIMIT) return stringBytes(value);
    if (value === this.lastLongString) return this.lastLongStringBytes;
    const bytes = stringBytes(value);
    this.lastLongString = value;
    this.lastLongStringBytes = bytes;
    return bytes;
  }
  add(value: object, metrics: Summary): void {
    if (this.entries === 1_000_000) { this.buckets.push(new WeakMap<object, Summary>()); this.entries = 0; }
    this.buckets[this.buckets.length - 1]!.set(value, metrics);
    this.entries++;
  }
}

// Count UTF-8 bytes without allocating an input-sized Uint8Array. Lone
// surrogates cost the encoder's replacement bytes; validation still owns refusal.
function stringBytes(value: string): number {
  if (value.length > CATALOG_RAW_STRING_LIMIT) return CATALOG_RAW_STRING_LIMIT + 1;
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += 3;
    if (bytes > CATALOG_RAW_STRING_LIMIT) return CATALOG_RAW_STRING_LIMIT + 1;
  }
  return bytes;
}
interface Frame {
  values: Iterator<unknown>; owner?: object; json: boolean; visible: boolean; depth: number;
  nodes: number; bytes: number; height: number; activate: boolean; incomingRoot: boolean;
}
interface Budget { nodes: number; bytes: number; failure?: CatalogInputResourceError; }
function exhaust(budget: Budget): never {
  const error = new CatalogInputResourceError(); budget.failure = error; throw error;
}
class CaptureFrame implements Frame {
  values: Iterator<unknown>;
  json = false;
  nodes = 1;
  bytes = 0;
  height = 0;
  activate = false;
  constructor(readonly owner: object, readonly visible: boolean, readonly depth: number,
    readonly incomingRoot: boolean, budget: Budget | undefined, memo: CaptureMemo) {
    this.values = children(owner, this, budget, memo);
  }
}

function charge(budget: Budget, nodes: number, bytes: number): void {
  budget.nodes += nodes; budget.bytes += bytes;
  if (budget.nodes > CATALOG_RAW_NODE_LIMIT || budget.bytes > CATALOG_RAW_STRING_LIMIT) exhaust(budget);
}
function add(frame: Frame, nodes: number, bytes: number, height = 0): void {
  frame.nodes = Math.min(CATALOG_RAW_NODE_LIMIT + 1, frame.nodes + nodes);
  frame.bytes = Math.min(CATALOG_RAW_STRING_LIMIT + 1, frame.bytes + bytes);
  frame.height = Math.min(CATALOG_RAW_EVIDENCE_DEPTH_LIMIT, Math.max(frame.height, height));
}
function* children(value: object, frame: Frame, budget: Budget | undefined, memo: CaptureMemo): Generator<unknown> {
  const array = Array.isArray(value);
  let keys: (string | symbol)[];
  try { keys = Reflect.ownKeys(value); }
  catch (error) {
    if (!array || !(error instanceof RangeError)) throw error;
    // Preserve the operator-approved engine-ceiling exception. This early
    // capture failure is not reclassified as a later resource observation.
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > CATALOG_RAW_NODE_LIMIT) malformed();
    if (Object.getOwnPropertySymbols(value).length !== 0) malformed();
    for (const key of Object.keys(value)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) malformed();
    }
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined) continue;
      if (!Object.hasOwn(descriptor, "value")) malformed();
      frame.activate = false;
      frame.json = descriptor.enumerable === true;
      yield descriptor.value;
    }
    return;
  }
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string") malformed();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) malformed();
    const index = array && budget !== undefined ? Number(key) : 0;
    frame.activate = frame.incomingRoot && key === "incoming";
    frame.json = budget !== undefined && descriptor.enumerable === true && (!array ||
      (Number.isInteger(index) && index >= 0 && index < 4294967295 && String(index) === key));
    if (budget !== undefined && frame.json && !array) {
      const bytes = memo.byteLength(key); add(frame, 1, bytes);
      if (frame.visible) charge(budget, 1, bytes);
    }
    yield descriptor.value;
  }
}

// JSON ownership only: no signature, authority or trust validation. Evidence
// accounting is opt-in. Sparse holes remain unreadable at normal validation;
// ignored metadata, copied array decorations and engine key-array costs stay open.
// The caller keeps values and metadata stable until capture returns so each
// cached summary describes every later occurrence of its object.
type EvidenceRoot = "snapshot" | "incoming";
export function copyCatalogInput<T>(input: T, evidenceBounds?: EvidenceRoot): T {
  const budget: Budget | undefined = evidenceBounds !== undefined ? {nodes: 0, bytes: 0} : undefined;
  try { return capture(input, evidenceBounds, budget); }
  catch (error) {
    // Caller metadata may throw an error from another capture. Only this
    // walk's own measured overflow can change the owner's refusal priority.
    if (error instanceof CatalogInputResourceError && error !== budget?.failure) malformed();
    throw error;
  }
}
function capture<T>(input: T, evidenceBounds: EvidenceRoot | undefined, budget: Budget | undefined): T {
  const pending: Frame[] = [{values: [input].values(), json: true, visible: evidenceBounds === "snapshot", depth: -1, nodes: 0, bytes: 0, height: 0, activate: false, incomingRoot: false}];
  const active = new WeakSet<object>(), memo = new CaptureMemo();
  while (pending.length > 0) {
    const current = pending[pending.length - 1]!, next = current.values.next();
    if (next.done) {
      if (current.owner !== undefined) {
        active.delete(current.owner);
        const metrics = budget === undefined ? 0 : summary(current.nodes, current.bytes, current.height);
        memo.add(current.owner, metrics);
        const parent = pending[pending.length - 2]!;
        if (budget !== undefined && parent.json) add(parent, current.nodes, current.bytes, current.height + 1);
      }
      pending.pop(); continue;
    }
    const value = next.value, visible = current.activate || (current.visible && current.json);
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
      if (budget !== undefined && current.json) {
        const bytes = typeof value === "string" ? memo.byteLength(value) : 0;
        add(current, 1, bytes); if (visible) charge(budget, 1, bytes);
      }
      continue;
    }
    if (typeof value !== "object" || active.has(value)) malformed();
    const cached = memo.get(value);
    if (cached !== undefined) {
      if (budget !== undefined && current.json) {
        const nodes = nodeCount(cached), bytes = stringCount(cached), height = containerDepth(cached);
        add(current, nodes, bytes, height + 1);
        if (visible) {
          if ((current.activate ? 0 : current.depth + 1) + height >= CATALOG_RAW_EVIDENCE_DEPTH_LIMIT) exhaust(budget);
          charge(budget, nodes, bytes);
        }
      }
      continue;
    }
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) malformed();
    const depth = visible && !current.activate ? current.depth + 1 : 0;
    if (budget !== undefined && visible) {
      if (depth >= CATALOG_RAW_EVIDENCE_DEPTH_LIMIT) exhaust(budget);
      charge(budget, 1, 0);
    }
    const frame = new CaptureFrame(value, visible, depth, evidenceBounds === "incoming" && value === input, budget, memo);
    active.add(value); pending.push(frame);
  }
  return structuredClone(input);
}
