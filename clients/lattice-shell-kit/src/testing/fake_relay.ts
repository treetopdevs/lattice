import {verifyEd25519} from "@treetopdevs/lattice-client";
import { CarrierPeerError, verifyCarrierOp } from "@treetopdevs/lattice-client";
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

/** The wire's closed report-reason list (`WIRE_REPORT_REASONS`); the real client refuses anything else. */
const REPORT_REASONS = new Set(["already_quarantined", "bad_signature", "wrong_replica"]);

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
  /**
   * Ids the relay holds only as quarantine evidence (the real log keeps them in `log.quarantine`, out of the
   * op set): never advertised, never served, and a repeat submit is answered `already_quarantined`.
   */
  readonly quarantine = new Set<string>();
  /**
   * Forced relay-report bucket per op id. `empty` replies with an empty report and stores nothing.
   * `quarantined` is a structural verdict (`bad_signature`), the only kind the real relay files there;
   * an authority failure is decided at reduction, so the real relay would report it `accepted`.
   */
  readonly forced = new Map<string, Forced>();
  /**
   * Relay error reply per op id (`"*"` for every frame): `relay(op)` throws the typed peer error the real
   * client raises for `{type: "error", reason}` (`unavailable`, `read_only`, `malformed`, `unauthenticated`,
   * `rate_limited`, or any other string). Checked after the token bucket, before the relay judges the op.
   */
  readonly errors = new Map<string, string>();
  /** Extra refusals appended to every report, naming ids the relay did not judge (a lying relay). */
  lie: Pick<CarrierPushReport, "quarantined" | "rejected"> | null = null;
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
  /** Ids the relay actually judged (a rate-limited submit is in `events` but never here), in order. */
  readonly judged: string[] = [];
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
    const ids = [...this.log.keys()].filter((id) => !this.hideAlways.has(id) && !this.hideOnce.has(id));
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
    const report = await this.judge(op);
    // The stand-in may never report a reason the real decoder refuses.
    for (const [id, reason] of [...report.quarantined, ...report.rejected])
      if (!REPORT_REASONS.has(reason)) throw new Error(`fake relay invented report reason ${reason} for ${id}`);
    if (this.lie) {
      report.quarantined.push(...this.lie.quarantined);
      report.rejected.push(...this.lie.rejected);
    }
    return report;
  }

  private async judge(op: CarrierOpFrame): Promise<CarrierPushReport> {
    this.events.push(`relay:${op.id}`);
    if (this.rateLimit) {
      this.refill();
      if (this.tokens < 1) throw new CarrierPeerError("rate_limited");
      this.tokens -= 1;
    }
    const failure = this.errors.get(op.id) ?? this.errors.get("*");
    if (failure !== undefined) throw new CarrierPeerError(failure);
    this.judged.push(op.id);
    const report = emptyReport();
    const forced = this.forced.get(op.id);
    // Evidence only: nothing enters `log`, so the id is never advertised or served.
    const quarantined = () => {
      report.quarantined.push([op.id, this.quarantine.has(op.id) ? "already_quarantined" : "bad_signature"]);
      this.quarantine.add(op.id);
      return report;
    };
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
    if (forced === "quarantined") return quarantined();
    const valid = await verifyCarrierOp(op, {
      verify: async (pub, bytes, sig) => verifyEd25519(sig, bytes, fromBase64(pub)),
    });
    if (!valid.valid) return quarantined();
    if (this.log.has(op.id)) return report;
    if (op.deps.some((dep) => !this.log.has(dep))) {
      report.pending.push(op.id);
      return report;
    }
    this.log.set(op.id, structuredClone(op));
    this.quarantine.delete(op.id);
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
