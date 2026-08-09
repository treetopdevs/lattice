import type { CarrierOpFrame } from "@treetopdevs/lattice-client";

/**
 * Byte-aware carrier-frame dedup across trust tiers.
 *
 * Frames sharing an id normally carry identical bytes (an outbox copy of an
 * already-archived frame, a re-pulled frame). When representations differ,
 * one copy is corrupt or forged, and the merge must not let a less trusted
 * copy replace a more trusted one: an unverified outbox entry sharing an id
 * with an archived recovery frame would otherwise silently destroy the only
 * valid copy a later honest peer could receive. The winner is the copy from
 * the lowest `trust` rank (0 = verified-this-sync, then archive, then
 * outbox); every differing-representation id is reported so callers can keep
 * a persistent warning until the corrupt copy is removed.
 */
export interface CarrierFrameTier {
  frames: CarrierOpFrame[];
  trust: number;
}

export interface CarrierFrameMerge {
  frames: CarrierOpFrame[];
  conflictingFrameIds: string[];
}

export function mergeCarrierFrameTiers(tiers: CarrierFrameTier[]): CarrierFrameMerge {
  const chosen = new Map<string, { frame: CarrierOpFrame; trust: number; bytes: string }>();
  const order: string[] = [];
  const conflicts = new Set<string>();

  for (const tier of tiers) {
    for (const frame of tier.frames) {
      const bytes = canonicalJson(frame);
      const existing = chosen.get(frame.id);
      if (existing === undefined) {
        chosen.set(frame.id, { frame, trust: tier.trust, bytes });
        order.push(frame.id);
        continue;
      }
      if (existing.bytes === bytes) {
        if (tier.trust < existing.trust) chosen.set(frame.id, { frame, trust: tier.trust, bytes });
        continue;
      }
      conflicts.add(frame.id);
      if (tier.trust < existing.trust) chosen.set(frame.id, { frame, trust: tier.trust, bytes });
    }
  }

  return {
    frames: order.map((id) => (chosen.get(id) as { frame: CarrierOpFrame }).frame),
    conflictingFrameIds: [...conflicts].sort(),
  };
}

/** Single-tier convenience: dedupe by id, first representation wins. */
export function mergeCarrierFrames(frames: CarrierOpFrame[]): CarrierOpFrame[] {
  return mergeCarrierFrameTiers([{ frames, trust: 0 }]).frames;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
