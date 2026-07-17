import { describe, expect, it, vi } from "vitest";
import {
  ACTION_INTENT_SLOT_VERSIONS,
  actionIntentDevTraceEvent,
  actionIntentLabel,
  parseActionIntentDevRoute,
  useActionIntent,
} from "../src/use_action_intent";
import type {
  TownshipFieldActionIntent,
  TownshipGrantActionIntent,
  TownshipPostActionIntent,
  TownshipRevokeActionIntent,
  TownshipRosterActionIntent,
  TownshipStatusActionIntent,
  TownshipWitnessSuccessionActionIntent,
} from "../src/township_action_intent";

const replica = "replica:matter:township-g1#root:test";
const postIntent: TownshipPostActionIntent = {
  v: 1,
  id: "11111111111111111111111111111111",
  replica,
  command: { command: "post", text: "Resident update" },
};
const statusIntent: TownshipStatusActionIntent = {
  v: 2,
  id: "22222222222222222222222222222222",
  replica,
  command: { command: "close_matter" },
};
const fieldIntent: TownshipFieldActionIntent = {
  v: 3,
  id: "33333333333333333333333333333333",
  replica,
  command: { command: "set_title", text: "New title" },
};
const rosterIntent: TownshipRosterActionIntent = {
  v: 4,
  id: "44444444444444444444444444444444",
  replica,
  command: { command: "admit", member: "resident:alice" },
};
const grantIntent: TownshipGrantActionIntent = {
  v: 5,
  id: "55555555555555555555555555555555",
  replica,
  authority: {
    action: "grant",
    audience: "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=",
    ops: ["admit", "post", "set_summary", "set_title"],
    roles: [],
    live: false,
  },
};
const revokeIntent: TownshipRevokeActionIntent = {
  v: 6,
  id: "66666666666666666666666666666666",
  replica,
  authority: {
    action: "revoke",
    delegation: "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI",
  },
};
const witnessSuccessionIntent: TownshipWitnessSuccessionActionIntent = {
  v: 7,
  id: "77777777777777777777777777777777",
  replica,
  authority: { action: "witness_succession", role: "clerk" },
};

function postController(overrides: Partial<Parameters<typeof useActionIntent<1>>[0]> = {}) {
  return useActionIntent({
    version: 1,
    currentReplica: () => replica,
    submit: async () => ({ ok: true, message: "saved" }),
    acceptMessage: () => "Post request moved to the local draft.",
    dismissFallback: "Post request",
    ...overrides,
  });
}

describe("useActionIntent", () => {
  it("accepts only the configured version for the saved replica", () => {
    const controller = postController();

    expect(controller.accept(postIntent)).toBe("accepted");
    expect(controller.accepted.value).toEqual(postIntent);
    expect(controller.status.value).toEqual({
      ok: true,
      message: "Post request moved to the local draft.",
    });
    expect(controller.accept(statusIntent)).toBe("wrong_version");
    expect(controller.accepted.value).toEqual(postIntent);
  });

  it("retains the request and reports the exact mismatch without submitting", async () => {
    const submit = vi.fn(async () => ({ ok: true, message: "saved" }));
    const controller = postController({ currentReplica: () => "replica:other", submit });

    expect(controller.accept(postIntent)).toBe("mismatch");
    expect(controller.accepted.value).toBeNull();
    expect(controller.status.value).toEqual({
      ok: false,
      message: "Post request no longer matches the saved Township pairing.",
    });
    expect(await controller.sign()).toBe("missing");
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses untrusted accept, sign, and dismiss events while no-event controls remain valid", async () => {
    const submit = vi.fn(async () => ({ ok: true, message: "saved" }));
    const controller = postController({ submit });
    const syntheticClick = new Event("click");

    expect(syntheticClick.isTrusted).toBe(false);
    expect(controller.accept(postIntent, syntheticClick)).toBe("ignored");
    expect(controller.accept(postIntent)).toBe("accepted");
    expect(await controller.sign(syntheticClick)).toBe("ignored");
    expect(controller.dismiss(syntheticClick)).toBe("ignored");
    expect(controller.accepted.value).toEqual(postIntent);
    expect(await controller.sign()).toBe("signed");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("keeps failures reviewable and clears successful requests with slot-specific success copy", async () => {
    const failed = postController({ submit: async () => ({ ok: false, message: "author failed" }) });
    failed.accept(postIntent);

    expect(await failed.sign()).toBe("failed");
    expect(failed.accepted.value).toEqual(postIntent);
    expect(failed.status.value).toEqual({ ok: false, message: "author failed" });

    const signed = postController({
      successMessage: () => "Grant signed and held for explicit Sync.",
    });
    signed.accept(postIntent);

    expect(await signed.sign()).toBe("signed");
    expect(signed.accepted.value).toBeNull();
    expect(signed.status.value).toEqual({
      ok: true,
      message: "Grant signed and held for explicit Sync.",
    });
  });

  it("refuses blocked and concurrent signing and releases its guard in finally", async () => {
    let release!: (value: { ok: boolean; message: string }) => void;
    const submit = vi.fn(
      () => new Promise<{ ok: boolean; message: string }>((resolve) => {
        release = resolve;
      }),
    );
    let allowed = false;
    const controller = postController({ submit, allowed: () => allowed });
    controller.accept(postIntent);

    expect(await controller.sign()).toBe("blocked");
    allowed = true;
    const first = controller.sign();
    expect(controller.submitting.value).toBe(true);
    expect(controller.submittingIntent.value).toEqual(postIntent);
    expect(await controller.sign()).toBe("busy");
    expect(submit).toHaveBeenCalledTimes(1);
    release({ ok: true, message: "saved" });
    expect(await first).toBe("signed");
    expect(controller.submitting.value).toBe(false);
    expect(controller.submittingIntent.value).toBeNull();

    const rejected = postController({ submit: async () => Promise.reject(new Error("boom")) });
    rejected.accept(postIntent);
    await expect(rejected.sign()).rejects.toThrow("boom");
    expect(rejected.submitting.value).toBe(false);
    expect(rejected.submittingIntent.value).toBeNull();
  });

  it("observes an external busy lifecycle for shared post and status surfaces", async () => {
    const submit = vi.fn(async () => ({ ok: true, message: "saved" }));
    let busy = true;
    const controller = postController({ submit, busy: () => busy });
    controller.accept(postIntent);

    expect(await controller.sign()).toBe("busy");
    expect(submit).not.toHaveBeenCalled();
    busy = false;
    expect(await controller.sign()).toBe("signed");
  });

  it("keeps controller statuses independent while reporting the latest written slot", () => {
    const writes: string[] = [];
    const post = postController({ onStatus: () => writes.push("post") });
    const status = useActionIntent({
      version: 2,
      currentReplica: () => replica,
      submit: async () => ({ ok: true, message: "saved" }),
      acceptMessage: (intent) => `${actionIntentLabel(intent)} ready to sign on this device.`,
      dismissFallback: "Status request",
      onStatus: () => writes.push("status"),
    });

    post.accept(postIntent);
    status.accept(statusIntent);
    status.dismiss();

    expect(post.status.value?.message).toBe("Post request moved to the local draft.");
    expect(status.status.value?.message).toBe("Close matter request dismissed.");
    expect(writes).toEqual(["post", "status", "status"]);
  });

  it("clears accepted state and status without mutating another controller", () => {
    const post = postController();
    const other = postController();
    post.accept(postIntent);
    other.accept(postIntent);

    post.clear();

    expect(post.accepted.value).toBeNull();
    expect(post.status.value).toBeNull();
    expect(other.accepted.value).toEqual(postIntent);
  });

  it("keeps v6 Use, mismatch, and dismiss review-only without submitting", () => {
    const submit = vi.fn(async () => ({ ok: true, message: "saved" }));
    let currentReplica = replica;
    const controller = useActionIntent({
      version: 6,
      currentReplica: () => currentReplica,
      submit,
      acceptMessage: () => "Revoke access request held for local review.",
      dismissFallback: "Revoke access request",
    });
    const syntheticClick = new Event("click");

    expect(controller.accept(revokeIntent, syntheticClick)).toBe("ignored");
    expect(controller.accept(revokeIntent)).toBe("accepted");
    expect(controller.accepted.value).toEqual(revokeIntent);
    expect(submit).not.toHaveBeenCalled();
    expect(controller.dismiss()).toBe("dismissed");
    expect(controller.accepted.value).toBeNull();
    expect(submit).not.toHaveBeenCalled();

    currentReplica = "replica:matter:other";
    expect(controller.accept(revokeIntent)).toBe("mismatch");
    expect(controller.accepted.value).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("action intent descriptors", () => {
  it("keeps exact labels for frozen v1-v6 and the v7 witness selector", () => {
    expect([
      actionIntentLabel(postIntent),
      actionIntentLabel(statusIntent),
      actionIntentLabel(fieldIntent),
      actionIntentLabel(rosterIntent),
      actionIntentLabel(grantIntent),
      actionIntentLabel(revokeIntent),
      actionIntentLabel(witnessSuccessionIntent),
    ]).toEqual([
      "Post request",
      "Close matter request",
      "Title edit request",
      "Admit member request",
      "Grant access request",
      "Revoke access request",
      "Witness recovery request",
    ]);
  });

  it("parses every slot use/sign route and nothing outside the descriptor", () => {
    expect(ACTION_INTENT_SLOT_VERSIONS).toEqual([
      { slot: "post", version: 1 },
      { slot: "status", version: 2 },
      { slot: "field", version: 3 },
      { slot: "roster", version: 4 },
      { slot: "grant", version: 5 },
      { slot: "revoke", version: 6 },
      { slot: "witness", version: 7 },
    ]);

    for (const { slot, version } of ACTION_INTENT_SLOT_VERSIONS) {
      expect(parseActionIntentDevRoute(`action-${slot}/use`)).toEqual({ slot, version, step: "use" });
      expect(parseActionIntentDevRoute(`action-${slot}/sign`)).toEqual({ slot, version, step: "sign" });
    }

    expect(parseActionIntentDevRoute("action-intent/submit")).toBeNull();
    expect(parseActionIntentDevRoute("action-post/sync")).toBeNull();
    expect(parseActionIntentDevRoute("action-v6/use")).toBeNull();
  });

  it("keeps witness Use and dismiss inert while refusing untrusted and mismatched requests", async () => {
    let currentReplica = replica;
    const submit = vi.fn(async () => ({ ok: true, message: "unexpected" }));
    const controller = useActionIntent({
      version: 7,
      currentReplica: () => currentReplica,
      submit,
      acceptMessage: () => "Witness recovery request held for local review.",
      dismissFallback: "Witness recovery request",
      allowed: () => false,
    });
    const syntheticClick = new Event("click");

    expect(controller.accept(witnessSuccessionIntent, syntheticClick)).toBe("ignored");
    expect(controller.accept(witnessSuccessionIntent)).toBe("accepted");
    expect(controller.accepted.value).toEqual(witnessSuccessionIntent);
    expect(submit).not.toHaveBeenCalled();
    expect(await controller.sign()).toBe("blocked");
    expect(submit).not.toHaveBeenCalled();
    expect(controller.dismiss()).toBe("dismissed");
    expect(controller.accepted.value).toBeNull();
    expect(submit).not.toHaveBeenCalled();

    currentReplica = "replica:matter:other";
    expect(controller.accept(witnessSuccessionIntent)).toBe("mismatch");
    expect(controller.accepted.value).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it("builds redacted per-slot trace events without accepting payload data", () => {
    for (const { slot } of ACTION_INTENT_SLOT_VERSIONS) {
      const trace = actionIntentDevTraceEvent(slot, "sign", "signed");
      expect(trace).toBe(`action-${slot}-dev-sign:signed`);
      expect(trace).not.toMatch(/Resident update|resident:alice|QUFB|intent|deep-link/);
    }
  });
});
