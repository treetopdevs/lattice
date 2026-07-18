import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { WitnessedSuccessionReview } from "@treetopdevs/lattice-client";
import IntentReviewPanel from "../src/components/IntentReviewPanel.vue";
import type {
  TownshipFieldActionIntent,
  TownshipGrantActionIntent,
  TownshipRevokeActionIntent,
  TownshipRosterActionIntent,
  TownshipStatusActionIntent,
  TownshipWitnessSuccessionActionIntent,
} from "../src/township_action_intent";

const replica = "replica:matter:township-g1#root:test";
const witnessWarning =
  "This artifact has no expiry and may remain valid indefinitely. " +
  "Valid until the clerk or recovery policy changes; this app cannot revoke an exported signature.";
const witnessReview: WitnessedSuccessionReview = {
  claim: {
    version: 1,
    replica,
    role: "clerk",
    holder: "aG9sZGVyaG9sZGVyaG9sZGVyaG9sZGVyaG9sZGVyaG8=",
    holderEpoch: "RVBPQ0hFUE9DSEVQT0NIRVBPQ0hFUE9DSEVQT0NIRVA",
    successor: "c3VjY2Vzc29yc3VjY2Vzc29yc3VjY2Vzc29yc3VjY2U=",
    policyId: "UE9MSUNZUE9MSUNZUE9MSUNZUE9MSUNZUE9MSUNZUE9",
  },
  policyGenesisOperationId: "R0VORVNJU0dFTkVTSVNHRU5FU0lTR0VORVNJU0dFTkV",
  witness: "d2l0bmVzc3dpdG5lc3N3aXRuZXNzd2l0bmVzc3dpdG4=",
  threshold: 2,
  verifiedFrontier: ["RlJPTlRJRVJGUk9OVElFUkZST05USUVSRlJPTlRJRVJ"],
};
const witnessReviewDetails = [
  `Replica: ${witnessReview.claim.replica}`,
  "Role: clerk",
  `Holder: ${witnessReview.claim.holder}`,
  `Holder epoch: ${witnessReview.claim.holderEpoch}`,
  `Successor: ${witnessReview.claim.successor}`,
  `Policy ID: ${witnessReview.claim.policyId}`,
  `Winning policy genesis operation ID: ${witnessReview.policyGenesisOperationId}`,
  `Witness key: ${witnessReview.witness}`,
  "Threshold: 2",
  `Verified frontier: ${witnessReview.verifiedFrontier.join(", ")}`,
];
const cases: Array<{
  intent:
    | TownshipStatusActionIntent
    | TownshipFieldActionIntent
    | TownshipRosterActionIntent
    | TownshipGrantActionIntent
    | TownshipRevokeActionIntent
    | TownshipWitnessSuccessionActionIntent;
  id: string;
  heading: string;
  eyebrow: string;
  details: string[];
  sign: string;
  witnessReview?: WitnessedSuccessionReview;
  warning?: string;
}> = [
  {
    intent: {
      v: 2,
      id: "22222222222222222222222222222222",
      replica,
      command: { command: "close_matter" },
    },
    id: "participant-status-request",
    heading: "Close matter request",
    eyebrow: "Local capability required",
    details: [],
    sign: "Sign close",
  },
  {
    intent: {
      v: 3,
      id: "33333333333333333333333333333333",
      replica,
      command: { command: "set_summary", text: "Revised summary" },
    },
    id: "participant-field-request",
    heading: "Summary edit request",
    eyebrow: "Local capability required",
    details: ["Revised summary"],
    sign: "Sign summary edit",
  },
  {
    intent: {
      v: 4,
      id: "44444444444444444444444444444444",
      replica,
      command: { command: "remove_member", member: "resident:alice" },
    },
    id: "participant-roster-request",
    heading: "Remove member request",
    eyebrow: "Unsigned local review",
    details: ["resident:alice"],
    sign: "Sign remove member",
  },
  {
    intent: {
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
    },
    id: "participant-grant-request",
    heading: "Grant access request",
    eyebrow: "Unsigned local review",
    details: [
      "Recipient 41414141...41414141",
      "Operations: admit, post, set_summary, set_title",
      "No roles ; Offline",
    ],
    sign: "Sign grant",
  },
  {
    intent: {
      v: 6,
      id: "66666666666666666666666666666666",
      replica,
      authority: {
        action: "revoke",
        delegation: "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI",
      },
    },
    id: "participant-revoke-request",
    heading: "Revoke access request",
    eyebrow: "Unsigned local review",
    details: ["QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI"],
    sign: "Sign revoke",
  },
  {
    intent: {
      v: 7,
      id: "77777777777777777777777777777777",
      replica,
      authority: { action: "witness_succession", role: "clerk" },
    },
    id: "participant-witness-request",
    heading: "Witness recovery request",
    eyebrow: "Unsigned local review",
    details: witnessReviewDetails,
    sign: "Sign witness artifact",
    witnessReview,
    warning: witnessWarning,
  },
];

describe("IntentReviewPanel", () => {
  for (const example of cases) {
    it(`renders and emits the frozen v${example.intent.v} review contract`, async () => {
      const wrapper = mount(IntentReviewPanel, {
        props: {
          intent: example.intent,
          busy: false,
          submitting: false,
          allowed: true,
          ...(example.witnessReview ? { witnessReview: example.witnessReview } : {}),
        },
      });

      expect(wrapper.attributes("id")).toBe(example.id);
      expect(wrapper.attributes("aria-live")).toBe("polite");
      expect(wrapper.find(".panel-heading p").text()).toBe(example.heading);
      expect(wrapper.find(".panel-heading span").text()).toBe(example.eyebrow);
      expect(wrapper.findAll(".incoming-action-text").map((node) => node.text())).toEqual(example.details);
      expect(wrapper.text()).not.toContain("Sync");
      if (example.warning) {
        expect(wrapper.find(".witness-warning").text()).toBe(example.warning);
      } else {
        expect(wrapper.find(".witness-warning").exists()).toBe(false);
        expect(wrapper.text()).not.toContain("no expiry");
      }

      const [sign, dismiss] = wrapper.findAll("button");
      expect(sign?.text()).toBe(example.sign);
      expect(dismiss?.text()).toBe("Dismiss request");
      await sign?.trigger("click");
      await dismiss?.trigger("click");

      const signEvent = wrapper.emitted("sign")?.[0]?.[0];
      const dismissEvent = wrapper.emitted("dismiss")?.[0]?.[0];
      expect(signEvent).toBeInstanceOf(Event);
      expect(dismissEvent).toBeInstanceOf(Event);
      expect((signEvent as Event).isTrusted).toBe(false);
      expect((dismissEvent as Event).isTrusted).toBe(false);
      expect((signEvent as Event).target).toBe(sign?.element);
      expect((dismissEvent as Event).target).toBe(dismiss?.element);
    });
  }

  it("keeps the sign control disabled while busy or locally disallowed", async () => {
    const intent = cases[1]?.intent;
    if (!intent) throw new Error("field fixture missing");
    const wrapper = mount(IntentReviewPanel, {
      props: { intent, busy: true, submitting: false, allowed: true },
    });

    expect(wrapper.find("button").attributes("disabled")).toBeDefined();
    expect(wrapper.find("button").text()).toBe("Sign summary edit");
    await wrapper.setProps({ busy: false, allowed: false });
    expect(wrapper.find("button").attributes("disabled")).toBeDefined();
    await wrapper.setProps({ submitting: true, allowed: true });
    expect(wrapper.find("button").attributes("disabled")).toBeDefined();
    expect(wrapper.find("button").text()).toBe("Signing");
    await wrapper.setProps({ submitting: false });
    expect(wrapper.find("button").attributes("disabled")).toBeUndefined();
    expect(wrapper.find("button").text()).toBe("Sign summary edit");
  });

  it("keeps witness signing disabled while no verified review is derived", () => {
    const intent = cases.find((example) => example.intent.v === 7)?.intent;
    if (!intent) throw new Error("witness fixture missing");
    const wrapper = mount(IntentReviewPanel, {
      props: { intent, busy: false, submitting: false, allowed: true, witnessReview: null },
    });

    expect(wrapper.find("button").text()).toBe("Sign witness artifact");
    expect(wrapper.find("button").attributes("disabled")).toBeDefined();
    expect(wrapper.findAll(".incoming-action-text").map((node) => node.text())).toEqual([
      "Requested role: clerk",
    ]);
    expect(wrapper.text()).not.toContain("Holder");
    expect(wrapper.text()).not.toContain("Policy ID");
    expect(wrapper.find(".witness-warning").exists()).toBe(false);
  });

  it("renders the exact indefinite-validity warning with a derived witness review", () => {
    const intent = cases.find((example) => example.intent.v === 7)?.intent;
    if (!intent) throw new Error("witness fixture missing");
    const wrapper = mount(IntentReviewPanel, {
      props: { intent, busy: false, submitting: false, allowed: true, witnessReview },
    });

    expect(wrapper.find(".witness-warning").text()).toBe(witnessWarning);
    expect(wrapper.find("button").attributes("disabled")).toBeUndefined();
    expect(wrapper.findAll(".incoming-action-text").map((node) => node.text())).toEqual(witnessReviewDetails);
  });
});
