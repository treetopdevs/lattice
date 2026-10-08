import { ed25519 } from "@noble/curves/ed25519.js";
import { verifyCarrierOp } from "@treetopdevs/lattice-client";
import type {
  CarrierOpFrame,
  CarrierPushReport,
  CarrierRelayClient,
  CarrierSyncClient,
} from "@treetopdevs/lattice-client";

/**
 * In-process stand-in for one carrier route (the Plan 133 test peer pattern). It speaks the same
 * advertise / pull / relay surface that `syncCarrierOnce` consumes and models the relay's report
 * buckets and its per-connection token bucket (burst 120, refilled at 12 per second). It never
 * replaces the real socket: Slice 4 is the real-socket gate.
 */
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const emptyReport = (): CarrierPushReport => ({ accepted: [], quarantined: [], rejected: [], pending: [] });

export type Forced = "accepted" | "quarantined" | "rejected" | "pending" | "empty";

export class FakeClock {
  ms = 0;
  sleep = async (ms: number) => {
    this.ms += ms;
  };
}

export class FakeRelay {
  /** The durable relay log, in acceptance order. */
  readonly log = new Map<string, CarrierOpFrame>();
  /** Ops the relay stored but reported as structurally quarantined. */
  readonly stored = new Set<string>();
  /** Forced relay-report bucket per op id. `empty` replies with an empty report and stores nothing. */
  readonly forced = new Map<string, Forced>();
  /** Ids hidden from the next advertise only (a stale advertise). */
  hideOnce = new Set<string>();
  /** How many advertises `hideOnce` covers before it clears. */
  hideOnceFor = 1;
  /** Ids hidden from every advertise. */
  hideAlways = new Set<string>();
  /** Return at most this many missing frames per pull, newest first (open dependencies on a page). */
  pullPage: number | null = null;
  /** Ignore the pull `have` list and return the whole log (a relay that re-serves known frames). */
  ignoreHave = false;
  /** Serve this instead of the log (a hostile pull). */
  servePull: unknown[] | null = null;
  rateLimit = true;
  tokens = 120;
  private refilledAt = 0;
  events: string[] = [];
  connects = 0;
  constructor(private readonly clock: FakeClock, readonly replica: string) {}

  private refill() {
    const elapsed = this.clock.ms - this.refilledAt;
    this.tokens = Math.min(120, this.tokens + (elapsed * 12) / 1000);
    this.refilledAt = this.clock.ms;
  }

  connect(): FakeConnection {
    this.connects++;
    return new FakeConnection(this);
  }

  advertisedIds(): string[] {
    const ids = [...this.log.keys(), ...this.stored].filter((id) => !this.hideAlways.has(id) && !this.hideOnce.has(id));
    if (--this.hideOnceFor <= 0) {
      this.hideOnce = new Set();
      this.hideOnceFor = 1;
    }
    return ids.sort();
  }

  missing(have: string[]): CarrierOpFrame[] {
    const known = new Set(have);
    let out = [...this.log.values()];
    if (!this.ignoreHave) out = out.filter((frame) => !known.has(frame.id));
    if (this.pullPage !== null) out = out.reverse().slice(0, this.pullPage);
    return out;
  }

  async deliver(op: CarrierOpFrame): Promise<CarrierPushReport> {
    this.events.push(`relay:${op.id}`);
    if (this.rateLimit) {
      this.refill();
      if (this.tokens < 1) throw new Error("carrier peer error: rate_limited");
      this.tokens -= 1;
    }
    const report = emptyReport();
    const forced = this.forced.get(op.id);
    if (forced === "empty") return report;
    if (forced === "rejected") {
      report.rejected.push([op.id, "wrong_replica"]);
      return report;
    }
    if (forced === "pending") {
      report.pending.push(op.id);
      return report;
    }
    if (op.replica !== this.replica) {
      report.rejected.push([op.id, "wrong_replica"]);
      return report;
    }
    const valid = await verifyCarrierOp(op, {
      verify: async (pub, bytes, sig) => ed25519.verify(sig, bytes, fromBase64(pub), { zip215: false }),
    });
    if (!valid.valid) {
      report.quarantined.push([op.id, "bad_signature"]);
      this.stored.add(op.id);
      return report;
    }
    if (this.log.has(op.id)) return report;
    if (op.deps.some((dep) => !this.log.has(dep))) {
      report.pending.push(op.id);
      return report;
    }
    this.log.set(op.id, structuredClone(op));
    if (forced === "quarantined") {
      report.quarantined.push([op.id, "authority"]);
      return report;
    }
    report.accepted.push(op.id);
    return report;
  }
}

export class FakeConnection implements CarrierSyncClient, CarrierRelayClient {
  closed = false;
  constructor(private readonly source: FakeRelay) {}
  async advertise() {
    this.source.events.push("advertise");
    return this.source.advertisedIds();
  }
  async pull(have: string[]) {
    this.source.events.push("pull");
    return this.source.servePull ?? this.source.missing(have);
  }
  async push(): Promise<CarrierPushReport> {
    throw new Error("generic push is not part of the Treehouse relay path");
  }
  relay(op: CarrierOpFrame) {
    return this.source.deliver(op);
  }
  close() {
    this.closed = true;
  }
}
