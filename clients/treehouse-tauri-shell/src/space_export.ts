import { canonicalBytesForCarrierTerm } from "@treetopdevs/lattice-client";
import type { CarrierDelegation, CarrierOpFrame, CarrierTerm } from "@treetopdevs/lattice-client";

// Space frames export (v1): a Space's public signed carrier frames, for the catalog ceremony operator.
// Not a backup: it carries no keys, outbox, acknowledgements, routes, drafts or state, only the frames.
export const SPACE_EXPORT_FORMAT = "lattice-space-frames-export-v1";
export const SPACE_EXPORT_MAX_FRAMES = 4000;
export const SPACE_EXPORT_MAX_BYTES = 16 * 1024 * 1024;

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.json$/;

/** The only file names the native writer accepts: one plain `.json` segment, never a path. */
export const isExportFileName = (name: string): boolean => FILE_NAME.test(name) && !name.includes("..");

/** A default file name from the tail of the Space id, sanitized. */
export function suggestExportFileName(replica: string): string {
  const id = replica.split("#")[0]!.split(":").pop() ?? "";
  const tail = id.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "space";
  return `treehouse-space-${tail}.frames.json`;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Compact JSON with object keys sorted in code-unit order at every level. */
const sortedJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => byCodeUnit(a, b)))
      : v,
  );

const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return a.length - b.length;
};
const bad = (): never => {
  throw new Error("export_invalid_frame");
};
const str = (v: unknown): string => (typeof v === "string" ? v : bad());
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : bad());

function delegationCopy(d: CarrierDelegation): CarrierDelegation {
  if (d === null || typeof d !== "object" || typeof d.live !== "boolean") return bad();
  const out: CarrierDelegation = {
    id: str(d.id),
    replica: str(d.replica),
    issuer: str(d.issuer),
    audience: str(d.audience),
    parent_id: d.parent_id === null ? null : str(d.parent_id),
    ops: strs(d.ops),
    roles: strs(d.roles),
    live: d.live,
    sig: str(d.sig),
  };
  if (d.expires_epoch !== undefined && d.expires_epoch !== null) {
    if (typeof d.expires_epoch !== "number") return bad();
    out.expires_epoch = d.expires_epoch;
  }
  return out;
}

/**
 * Rebuild a term arm by arm, so nothing but the closed grammar survives, and put map pairs and mapset elements in
 * the canonical order the BEAM encoder emits (Lattice.Carrier.Wire.encode_op): by canonical key bytes. The app's
 * own pin is authored in insertion order; the export must match the BEAM re-encoding byte for byte.
 */
export function canonicalCarrierTerm(term: CarrierTerm): CarrierTerm {
  if (!Array.isArray(term)) return bad();
  switch (term[0]) {
    case "nil":
      return term.length === 1 ? ["nil"] : bad();
    case "bool":
      return term.length === 2 && typeof term[1] === "boolean" ? ["bool", term[1]] : bad();
    case "int":
      return term.length === 2 && (typeof term[1] === "number" || typeof term[1] === "string") ? ["int", term[1]] : bad();
    case "bin":
      return term.length === 2 ? ["bin", str(term[1])] : bad();
    case "atom":
      return term.length === 2 ? ["atom", str(term[1])] : bad();
    case "list":
    case "tuple":
      return term.length === 2 && Array.isArray(term[1]) ? [term[0], term[1].map(canonicalCarrierTerm)] : bad();
    case "mapset": {
      if (term.length !== 2 || !Array.isArray(term[1])) return bad();
      const values = term[1].map(canonicalCarrierTerm);
      return ["mapset", values.sort((a, b) => compareBytes(canonicalBytesForCarrierTerm(a), canonicalBytesForCarrierTerm(b)))];
    }
    case "map": {
      if (term.length !== 2 || !Array.isArray(term[1])) return bad();
      const pairs = term[1].map((pair) => {
        if (!Array.isArray(pair) || pair.length !== 2) return bad();
        return [canonicalCarrierTerm(pair[0]), canonicalCarrierTerm(pair[1])] as [CarrierTerm, CarrierTerm];
      });
      const keyed = pairs.map((p) => [canonicalBytesForCarrierTerm(p[0]), p] as const);
      keyed.sort((a, b) => compareBytes(a[0], b[0]));
      return ["map", keyed.map(([, p]) => p)];
    }
    case "delegation":
      return term.length === 2 ? ["delegation", delegationCopy(term[1])] : bad();
    default:
      return bad();
  }
}

export async function buildSpaceFramesExport(input: {
  space: string;
  /** The Space root's public key, standard base64 of 32 bytes. */
  rootPublicKey: string;
  frames: readonly CarrierOpFrame[];
  verify: (frame: CarrierOpFrame) => Promise<boolean>;
}): Promise<string> {
  const { space, rootPublicKey, frames, verify } = input;
  if (!frames.length) throw new Error("export_empty");
  if (frames.length > SPACE_EXPORT_MAX_FRAMES) throw new Error("export_too_large");
  const ids = new Set<string>();
  const copies: CarrierOpFrame[] = [];
  for (const frame of frames) {
    if (frame.replica !== space) throw new Error("export_wrong_replica");
    if (ids.has(frame.id)) throw new Error("export_duplicate_frame");
    ids.add(frame.id);
    // A malformed frame makes the verifier throw; either way the frame is refused.
    if (!(await verify(frame).catch(() => false))) throw new Error("export_invalid_frame");
    // Rebuilt field by field, terms arm by arm: a retained object may carry nothing else into the file, at any depth.
    copies.push({
      v: frame.v,
      id: frame.id,
      replica: frame.replica,
      author: frame.author,
      deps: strs(frame.deps),
      kind: frame.kind,
      body: canonicalCarrierTerm(frame.body),
      cap: canonicalCarrierTerm(frame.cap),
      sig: frame.sig,
    });
  }
  copies.sort((a, b) => byCodeUnit(a.id, b.id));
  const text = sortedJson({ format: SPACE_EXPORT_FORMAT, space, root: rootPublicKey, frames: copies });
  if (new TextEncoder().encode(text).length > SPACE_EXPORT_MAX_BYTES) throw new Error("export_too_large");
  return text;
}
