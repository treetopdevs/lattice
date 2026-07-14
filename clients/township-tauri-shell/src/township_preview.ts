import { materialize, type Op, type ReplicaSchema } from "@treetopdevs/lattice-client";

export interface TownshipMatterPreview {
  title: string;
  summary: string;
  clerk: string;
  status: "Open" | "Locked";
  members: string[];
  posts: string[];
  opCount: number;
  appliedCount: number;
  quarantineCount: number;
}

export const townshipMatterSchema: ReplicaSchema = {
  name: "Township.Matter",
  fields: {
    clerk: { authority: "clerk" },
    clerk_locked: { merge: "lww", gatedBy: "clerk", default: false },
    members: { merge: "or_set" },
    posts: { merge: "causal_list" },
    summary: { merge: "lww", default: "" },
    title: { merge: "lww", default: "" },
  },
};

export const townshipMatterOps: Op[] = [
  op("alPyLJrTujWnm_cNWbburV2Y4NP3mYdkjAUqIHXxJ9U", [], "authority", "clerk", "clerk", "write", "clerk", "genesis clerk"),
  op(
    "wSAxLmQL_laRKD8pa5Lm9gh6hdsFE6ee1BZKkT4yC1I",
    ["alPyLJrTujWnm_cNWbburV2Y4NP3mYdkjAUqIHXxJ9U"],
    "authority",
    "clerk",
    "__authority",
    "write",
    null,
    "grant resident",
  ),
  op(
    "LjyuGoRJNDzsPTVpuW7MlLFuMNsMmVOx_GxGyyjn1rQ",
    ["wSAxLmQL_laRKD8pa5Lm9gh6hdsFE6ee1BZKkT4yC1I"],
    "command",
    "clerk",
    "members",
    "add",
    "clerk",
    "admit",
  ),
  op(
    "vp4P8uIkZFgcjT6a4qCsSQ-DBTrCSoD8HZNrCQpjMks",
    ["LjyuGoRJNDzsPTVpuW7MlLFuMNsMmVOx_GxGyyjn1rQ"],
    "command",
    "clerk",
    "members",
    "add",
    "resident",
    "admit",
  ),
  op(
    "E5fAT3RYRfxYwcw4h6hXIUrLoDAvgwpvdEHtCRAB4E4",
    ["wSAxLmQL_laRKD8pa5Lm9gh6hdsFE6ee1BZKkT4yC1I"],
    "command",
    "resident",
    "posts",
    "append",
    "resident: I will attend",
    "post",
  ),
  op(
    "1xtEPVnYbSxHgVHKayyMdvIuf49NeVSgQqi96Gg-MM8",
    ["E5fAT3RYRfxYwcw4h6hXIUrLoDAvgwpvdEHtCRAB4E4"],
    "command",
    "resident",
    "summary",
    "write",
    "Needs traffic study",
    "set_summary",
  ),
  op(
    "mMpefHRAYHYm3b4zVySAJm-0c4BXo2AgfN_YsODA37g",
    ["1xtEPVnYbSxHgVHKayyMdvIuf49NeVSgQqi96Gg-MM8"],
    "command",
    "resident",
    "posts",
    "append",
    "resident: posted while offline",
    "post",
  ),
  op(
    "L10W2QqXGpkBAsTNlxX3_dfwrEEKV1E5Ji-U6yXQffM",
    ["vp4P8uIkZFgcjT6a4qCsSQ-DBTrCSoD8HZNrCQpjMks"],
    "command",
    "clerk",
    "title",
    "write",
    "Zoning Variance #24",
    "set_title",
  ),
  op(
    "Rr9vJAyKWsSqBQNFgBnQyYGDtlDcbNjLMhtIo0GqvaY",
    ["L10W2QqXGpkBAsTNlxX3_dfwrEEKV1E5Ji-U6yXQffM"],
    "command",
    "clerk",
    "posts",
    "append",
    "clerk: hearing Tue 6pm",
    "post",
  ),
  op(
    "1pyd8r5YGNSMV5op3yPSMKBUwYWRZ_0L5Fne16bq9pA",
    ["Rr9vJAyKWsSqBQNFgBnQyYGDtlDcbNjLMhtIo0GqvaY", "mMpefHRAYHYm3b4zVySAJm-0c4BXo2AgfN_YsODA37g"],
    "command",
    "clerk",
    "clerk_locked",
    "write",
    true,
    "close_matter",
  ),
  op(
    "NZ1Y6_uwlEGNQtbxQ2hFwKTsndAgtQYFBUHu7b_H5pQ",
    ["Rr9vJAyKWsSqBQNFgBnQyYGDtlDcbNjLMhtIo0GqvaY"],
    "command",
    "clerk",
    "summary",
    "write",
    "Leaning approve",
    "set_summary",
  ),
];

export function townshipPreview(): TownshipMatterPreview {
  return townshipPreviewFromOps(townshipMatterOps);
}

export function townshipPreviewFromOps(
  ops: Op[],
  externallyQuarantined: ReadonlySet<string> = new Set(),
): TownshipMatterPreview {
  const materialized = materialize(
    townshipMatterSchema,
    ops,
    undefined,
    externallyQuarantined,
  );
  const state = materialized.state;

  return {
    title: stringValue(state.title, "Untitled matter"),
    summary: stringValue(state.summary, ""),
    clerk: stringValue(state.clerk, "unassigned"),
    status: state.clerk_locked === true ? "Locked" : "Open",
    members: stringArray(state.members),
    posts: stringArray(state.posts),
    opCount: ops.length,
    appliedCount: materialized.order.length - materialized.quarantine.length,
    quarantineCount: materialized.quarantine.length,
  };
}

function op(
  id: string,
  deps: string[],
  kind: Op["kind"],
  author: string,
  field: string,
  mutation: Op["mutation"],
  value: unknown,
  command: string,
): Op {
  return { id, deps, kind, author, field, mutation, value, hash: id, command };
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
