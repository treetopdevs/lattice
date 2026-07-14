import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import IntentReviewPanel from "../src/components/IntentReviewPanel.vue";
import type {
  TownshipFieldActionIntent,
  TownshipGrantActionIntent,
  TownshipRevokeActionIntent,
  TownshipRosterActionIntent,
  TownshipStatusActionIntent,
} from "../src/township_action_intent";

const replica = "replica:matter:township-g1#root:test";
const cases: Array<{
  intent:
    | TownshipStatusActionIntent
    | TownshipFieldActionIntent
    | TownshipRosterActionIntent
    | TownshipGrantActionIntent
    | TownshipRevokeActionIntent;
  id: string;
  heading: string;
  eyebrow: string;
  details: string[];
  sign: string;
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
];

describe("IntentReviewPanel", () => {
  for (const example of cases) {
    it(`renders and emits the frozen v${example.intent.v} review contract`, async () => {
      const wrapper = mount(IntentReviewPanel, {
        props: { intent: example.intent, busy: false, submitting: false, allowed: true },
      });

      expect(wrapper.attributes("id")).toBe(example.id);
      expect(wrapper.attributes("aria-live")).toBe("polite");
      expect(wrapper.find(".panel-heading p").text()).toBe(example.heading);
      expect(wrapper.find(".panel-heading span").text()).toBe(example.eyebrow);
      expect(wrapper.findAll(".incoming-action-text").map((node) => node.text())).toEqual(example.details);
      expect(wrapper.text()).not.toContain("Sync");

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
});
