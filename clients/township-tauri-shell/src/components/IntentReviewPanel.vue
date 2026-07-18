<script setup lang="ts">
import { computed } from "vue";
import type { WitnessedSuccessionReview } from "@treetopdevs/lattice-client";
import { townshipCarrierPeerFingerprint } from "../township_carrier_peer";
import type {
  TownshipPostActionIntent,
  TownshipReviewableActionIntent,
} from "../township_action_intent";
import { actionIntentLabel } from "../use_action_intent";

type IntentReview = Exclude<TownshipReviewableActionIntent, TownshipPostActionIntent>;
type IntentReviewModel = {
  id: string;
  eyebrow: string;
  details: string[];
  signLabel: string;
};

const props = defineProps<{
  intent: IntentReview;
  busy: boolean;
  submitting: boolean;
  allowed: boolean;
  witnessReview?: WitnessedSuccessionReview | null;
}>();
const emit = defineEmits<{
  sign: [event: Event];
  dismiss: [event: Event];
}>();

const model = computed<IntentReviewModel>(() => reviewModel(props.intent, props.witnessReview));
const witnessWarning =
  "This artifact has no expiry and may remain valid indefinitely. " +
  "Valid until the clerk or recovery policy changes; this app cannot revoke an exported signature.";
const signAllowed = computed(
  () => props.allowed && (props.intent.v !== 7 || props.witnessReview != null),
);

function reviewModel(
  intent: IntentReview,
  witnessReview: WitnessedSuccessionReview | null | undefined,
): IntentReviewModel {
  if (intent.v === 2) {
    return {
      id: "participant-status-request",
      eyebrow: "Local capability required",
      details: [],
      signLabel: `Sign ${intent.command.command === "close_matter" ? "close" : "reopen"}`,
    };
  }
  if (intent.v === 3) {
    return {
      id: "participant-field-request",
      eyebrow: "Local capability required",
      details: [intent.command.text],
      signLabel: `Sign ${intent.command.command === "set_title" ? "title edit" : "summary edit"}`,
    };
  }
  if (intent.v === 4) {
    return {
      id: "participant-roster-request",
      eyebrow: "Unsigned local review",
      details: [intent.command.member],
      signLabel: `Sign ${intent.command.command === "admit" ? "admit" : "remove member"}`,
    };
  }
  if (intent.v === 5) {
    const roles = intent.authority.roles.length === 0 ? "No roles" : intent.authority.roles.join(", ");
    return {
      id: "participant-grant-request",
      eyebrow: "Unsigned local review",
      details: [
        `Recipient ${townshipCarrierPeerFingerprint(intent.authority.audience)}`,
        `Operations: ${intent.authority.ops.join(", ")}`,
        `${roles} ; ${intent.authority.live ? "Live" : "Offline"}`,
      ],
      signLabel: "Sign grant",
    };
  }
  if (intent.v === 6) {
    return {
      id: "participant-revoke-request",
      eyebrow: "Unsigned local review",
      details: [intent.authority.delegation],
      signLabel: "Sign revoke",
    };
  }
  if (intent.v === 7) {
    const details = witnessReview
      ? [
          `Replica: ${witnessReview.claim.replica}`,
          `Role: ${witnessReview.claim.role}`,
          `Holder: ${witnessReview.claim.holder}`,
          `Holder epoch: ${witnessReview.claim.holderEpoch}`,
          `Successor: ${witnessReview.claim.successor}`,
          `Policy ID: ${witnessReview.claim.policyId}`,
          `Winning policy genesis operation ID: ${witnessReview.policyGenesisOperationId}`,
          `Witness key: ${witnessReview.witness}`,
          `Threshold: ${witnessReview.threshold}`,
          `Verified frontier: ${witnessReview.verifiedFrontier.join(", ")}`,
        ]
      : [`Requested role: ${intent.authority.role}`];
    return {
      id: "participant-witness-request",
      eyebrow: "Unsigned local review",
      details,
      signLabel: "Sign witness artifact",
    };
  }
  return assertNeverIntentReview(intent);
}

function assertNeverIntentReview(_intent: never): never {
  throw new Error("Unsupported accepted action intent.");
}
</script>

<template>
  <section :id="model.id" class="incoming-action-panel" aria-live="polite">
    <div class="panel-heading">
      <p>{{ actionIntentLabel(intent) }}</p>
      <span>{{ model.eyebrow }}</span>
    </div>
    <p v-for="detail in model.details" :key="detail" class="incoming-action-text">{{ detail }}</p>
    <p v-if="intent.v === 7 && witnessReview" class="witness-warning">{{ witnessWarning }}</p>
    <div class="incoming-action-controls">
      <button type="button" :disabled="busy || submitting || !signAllowed" @click="emit('sign', $event)">
        {{ submitting ? "Signing" : model.signLabel }}
      </button>
      <button type="button" class="secondary-action" @click="emit('dismiss', $event)">Dismiss request</button>
    </div>
  </section>
</template>
