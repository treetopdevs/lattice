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
  op("3gisahML791TEKkKa56M2GSxknsj60ZgHgEl-GIO9rs", [], "authority", "clerk", "clerk", "write", "clerk", "genesis clerk"),
  op(
    "-36WpNvm7LCAmZD2R68_MIjqcRusi88snNB_xhQD9aQ",
    ["3gisahML791TEKkKa56M2GSxknsj60ZgHgEl-GIO9rs"],
    "authority",
    "clerk",
    "__authority",
    "write",
    null,
    "grant resident",
  ),
  op(
    "IHBXBz7xJx_JXLmSTZQGw7u7A-BMnAxo6xQ0U-TVTvQ",
    ["-36WpNvm7LCAmZD2R68_MIjqcRusi88snNB_xhQD9aQ"],
    "command",
    "clerk",
    "members",
    "add",
    "clerk",
    "admit",
  ),
  op(
    "RbT2hkJ0AZlrdvGC2KvbgGZY04Yhq7v-PKURGf9oFQE",
    ["IHBXBz7xJx_JXLmSTZQGw7u7A-BMnAxo6xQ0U-TVTvQ"],
    "command",
    "clerk",
    "members",
    "add",
    "resident",
    "admit",
  ),
  op(
    "fG5WVRkc4rAl6G5i8YYCahuaIr4rwPFFZMjyTdEooNg",
    ["-36WpNvm7LCAmZD2R68_MIjqcRusi88snNB_xhQD9aQ"],
    "command",
    "resident",
    "posts",
    "append",
    "resident: I will attend",
    "post",
  ),
  op(
    "vEyKbmA4a5ysTnOlTwE3oQrzckUZUVY0peCz3wPbRio",
    ["fG5WVRkc4rAl6G5i8YYCahuaIr4rwPFFZMjyTdEooNg"],
    "command",
    "resident",
    "summary",
    "write",
    "Needs traffic study",
    "set_summary",
  ),
  op(
    "j2gcb5LdpWoVY93rKM9nLusQw5Us9VCrbE2aTNQ8Evg",
    ["vEyKbmA4a5ysTnOlTwE3oQrzckUZUVY0peCz3wPbRio"],
    "command",
    "resident",
    "posts",
    "append",
    "resident: posted while offline",
    "post",
  ),
  op(
    "vqf1_jGFwz5mC-dGQf82VFxIRyUD10XLll23af8S-es",
    ["RbT2hkJ0AZlrdvGC2KvbgGZY04Yhq7v-PKURGf9oFQE"],
    "command",
    "clerk",
    "title",
    "write",
    "Zoning Variance #24",
    "set_title",
  ),
  op(
    "e_17sbyo-dGFCyV2G7z_Fn5St4Clrt9_OKE7YqhX91E",
    ["vqf1_jGFwz5mC-dGQf82VFxIRyUD10XLll23af8S-es"],
    "command",
    "clerk",
    "posts",
    "append",
    "clerk: hearing Tue 6pm",
    "post",
  ),
  op(
    "6kDiSO8qiTfEJy0qudiJ_sk27xT9kaxoofv19HOyj3A",
    ["e_17sbyo-dGFCyV2G7z_Fn5St4Clrt9_OKE7YqhX91E", "j2gcb5LdpWoVY93rKM9nLusQw5Us9VCrbE2aTNQ8Evg"],
    "command",
    "clerk",
    "clerk_locked",
    "write",
    true,
    "close_matter",
  ),
  op(
    "NTzDm0Y8bZjjbEeGk0iUOqzsyF1eum6v-Yb5ZTAKc_Q",
    ["e_17sbyo-dGFCyV2G7z_Fn5St4Clrt9_OKE7YqhX91E"],
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

export function townshipPreviewFromOps(ops: Op[]): TownshipMatterPreview {
  const materialized = materialize(townshipMatterSchema, ops);
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
