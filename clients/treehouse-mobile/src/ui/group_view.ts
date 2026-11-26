import type { AuditView } from "../session/projections/audit_view";
import type { LinkStatus } from "../session/projections/link_status";
import { audit as auditCopy, myKey, relay as relayCopy, safety } from "./strings";

// Group tab (M1b.7, 04): pure helpers that put the session's read models into words for the Relay, Safety,
// My key and Verify & audit sections. No protocol facts are computed here: connections, waiting counts, grant
// states, quarantine reasons, frontiers and relay generations all come from the read models as they are.

interface ThreadTitles {
  threads: readonly { replica: string; title: string }[];
}

export interface RelayRow {
  replica: string;
  label: string;
  connection: string;
  waiting: number;
  text: string;
  accessibilityLabel: string;
}

const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 12)}…` : id);

function replicaTitle(replica: string, spaceReplica: string | null, threads: ThreadTitles | null): string {
  if (replica === spaceReplica) return relayCopy.groupRoute;
  const title = threads?.threads.find((t) => t.replica === replica)?.title;
  return title && title.length > 0 ? title : shortId(replica);
}

/** One row per route, the Group's first: its connection in words and what waits to send there. */
export function relayRows(link: LinkStatus, threads: ThreadTitles | null, spaceReplica: string | null): RelayRow[] {
  const rows = link.routes.map((r) => {
    const label = replicaTitle(r.replica, spaceReplica, threads);
    const connection = relayCopy.connection[r.connection];
    const text = relayCopy.row(label, connection, r.waiting);
    return { replica: r.replica, label, connection, waiting: r.waiting, text, accessibilityLabel: text };
  });
  return [...rows.filter((r) => r.replica === spaceReplica), ...rows.filter((r) => r.replica !== spaceReplica)];
}

/** The Pause sync switch: on when the person paused sync (the setting), not whenever the pill says Offline. */
export function syncSwitch(link: LinkStatus): { paused: boolean; label: string; hint: string } {
  return { paused: !link.syncEnabled, label: relayCopy.pauseSync, hint: relayCopy.pauseSyncHint };
}

/** The Safety card's lines; `demoNote` (from the demo fence, dev builds only) comes last. */
export function safetyLines(demoNote: string | null): string[] {
  const lines: string[] = [safety.relayOperator, safety.phoneLost, safety.adminLost, safety.textOnly, safety.history];
  if (demoNote) lines.push(demoNote);
  return lines;
}

/** The My key card: key check, where it is kept, and that it stays on this phone. */
export function keyLines(identity: { fingerprint: string; source: "keychain" | "demo-seed" }, keyCheck?: (f: string) => string): string[] {
  return [
    keyCheck ? keyCheck(identity.fingerprint) : identity.fingerprint,
    identity.source === "keychain" ? myKey.keychain : myKey.demoSeed,
    myKey.notMovable,
  ];
}

export interface AuditFact {
  key: "ops" | "frontier" | "generation" | "matchesRelay";
  label: string;
  value: string;
  accessibilityLabel: string;
}

export interface AuditSection {
  replica: string;
  title: string;
  facts: AuditFact[];
  grants: { id: string; state: string; stateLabel: string; text: string }[];
  notCounted: { id: string; reason: string; text: string }[];
}

const fact = (key: AuditFact["key"], label: string, value: string): AuditFact => ({
  key,
  label,
  value,
  accessibilityLabel: auditCopy.fact(label, value),
});

/** Verify & audit, per replica (the Group first): the AuditView in words, reasons as the judge's raw codes. */
export function auditSections(
  view: AuditView,
  ctx: { spaceReplica: string | null; threads: ThreadTitles | null; name(pubkey: string): string },
): AuditSection[] {
  const sections = view.replicas.map((r): AuditSection => {
    const title = r.replica === ctx.spaceReplica ? auditCopy.groupSection : replicaTitle(r.replica, ctx.spaceReplica, ctx.threads);
    return {
      replica: r.replica,
      title,
      facts: [
        fact("ops", auditCopy.ops, String(r.opCount)),
        fact("frontier", auditCopy.frontier, r.frontier.length > 0 ? r.frontier.map(shortId).join(", ") : auditCopy.noFrontier),
        fact("generation", auditCopy.generation, r.generation === null ? auditCopy.notCompared : String(r.generation)),
        fact("matchesRelay", auditCopy.matchesRelay, r.matchesRelay === null ? auditCopy.notCompared : r.matchesRelay ? auditCopy.yes : auditCopy.no),
      ],
      grants: r.grants.map((g) => {
        const stateLabel = auditCopy.grantState[g.state];
        const ops = g.roles.length > 0 ? `${g.ops.join(", ")} · ${auditCopy.roles(g.roles.join(", "))}` : g.ops.join(", ");
        return { id: g.id, state: g.state, stateLabel, text: auditCopy.grantLine(ctx.name(g.audience), ops, stateLabel) };
      }),
      notCounted: r.quarantined.map((q) => ({ id: q.id, reason: q.reason, text: auditCopy.notCountedLine(shortId(q.id), q.reason) })),
    };
  });
  return [...sections.filter((s) => s.replica === ctx.spaceReplica), ...sections.filter((s) => s.replica !== ctx.spaceReplica)];
}
