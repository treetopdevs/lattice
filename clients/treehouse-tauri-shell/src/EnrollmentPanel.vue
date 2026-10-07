<script setup lang="ts">
import { computed, ref } from "vue";
import type { OfferReview, TreehouseWorkflow } from "./treehouse_workflow";
import type { PreviewState } from "./treehouse_state";

// Plan 181 S2c. Loaded only when the app is built with VITE_TREEHOUSE_ENROLLMENT=1. Use (import and
// review), Sign (accept, admit and grant) and Sync stay separate actions: nothing in this panel touches
// the network, and no button does more than one of them. Sync arrives with its own button in S3c.
const props = defineProps<{
  workflow: TreehouseWorkflow;
  state: PreviewState;
  busy: boolean;
  run: (
    action: () => Promise<void>,
    explain?: (cause: unknown) => string,
  ) => Promise<void>;
  describe: (cause: unknown) => string;
}>();

const DISCLOSURE =
  "The relay operator, and anyone with its host, backups or admitted peers, can read this group's plaintext log, and the host can withhold availability. The relay cannot decide who may act in the group.";
const messages: Record<string, string> = {
  wrong_product:
    "That text is not a Treehouse artifact. Nothing was changed.",
  invalid_artifact_format:
    "That text is not a complete Treehouse artifact. Nothing was changed.",
  unsupported_artifact_version:
    "That artifact comes from a different version. Nothing was changed.",
  invalid_artifact_payload:
    "That artifact could not be read. Nothing was changed.",
  artifact_too_large: "That artifact is too large. Nothing was changed.",
  secret_field:
    "That artifact carries a field that must never be shared. Nothing was changed.",
  join_not_begun: "Press Join a group first to create your join request.",
  identity_creation_not_allowed:
    "This device already holds a group. It cannot start a join.",
  different_creation_pending:
    "A different setup is waiting to finish. Finish it first.",
  join_in_progress:
    "This device is waiting to join a group, so it cannot start one.",
  creation_incomplete: "Finish the pending local setup first.",
  space_unavailable:
    "The group's history has not arrived on this device yet. Pull it from the relay first.",
  routes_not_configured:
    "Paste and configure the relay route list for this group first.",
  invalid_local_realm: "Enter the transport realm name of the person joining.",
  invalid_route_list: "The route list is not valid JSON of the expected shape.",
  invalid_route: "A route in the list is not valid.",
  duplicate_route: "Two routes name the same group or thread.",
  too_many_routes: "At most four routes are supported: the group and three threads.",
  unknown_route_replica:
    "A route names a group or thread that this device does not hold.",
  relay_already_configured:
    "Different relay routes are already saved. Saved routes are never replaced.",
  route_replica_mismatch: "A route does not belong to this group.",
  no_pending_offer: "Use an offer first, then confirm its routes.",
  offer_not_confirmed:
    "Confirm this offer's routes before accepting the invitation.",
  thread_cap_reached:
    "With relay routes, a group can hold at most three threads.",
  thread_scope_exceeds_routes:
    "Every thread in the group needs a configured route, and at most three threads can be invited.",
  thread_not_available: "A thread in the invitation is not saved here yet.",
  root_capability_unavailable: "Only the founder of this group can do that.",
  no_capability: "This identity holds no grant for that action.",
  wrong_replica: "That text belongs to a different group. Nothing was changed.",
  invitation_not_found: "That invitation is not in this group's history.",
  invitation_not_honored: "That invitation is not valid in this group.",
  wrong_recipient: "That invitation was issued to a different identity.",
  revoked: "That invitation was revoked.",
  stale_scope:
    "The group's threads changed after this invitation. Ask for a new offer.",
  offer_scope_mismatch:
    "The offer's threads do not match the invitation. Nothing was changed.",
  invalid_acceptance: "That acceptance is not valid for this invitation.",
  invalid_recipient: "That join request carries an invalid identity.",
};
const explain = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return messages[message] ?? props.describe(cause);
};

const space = computed(() =>
  props.state.profiles.find((p) => p.product === "Treehouse.Space"),
);
// The genesis operation is the only one without dependencies, and its author is the founder.
const founderKey = computed(
  () => space.value?.frames.find((f) => f.deps.length === 0)?.author ?? null,
);
const isFounder = computed(
  () =>
    space.value !== undefined &&
    props.state.publicKey !== null &&
    founderKey.value === props.state.publicKey,
);
const canJoin = computed(() => props.state.profiles.length === 0);
const short = (replica: string) =>
  replica.replace("replica:treehouse:", "").slice(0, 28);

const joinRequest = ref(""),
  offerText = ref(""),
  review = ref<OfferReview | null>(null),
  confirmed = ref(false),
  acceptance = ref("");
const routeList = ref(""),
  joinRequestPaste = ref(""),
  joinerRealm = ref(""),
  offerOut = ref(""),
  acceptancePaste = ref(""),
  admitted = ref("");
const copyNote = ref("");

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    copyNote.value = "Copied.";
  } catch {
    copyNote.value = "Copy was not possible. Select the text and copy it by hand.";
  }
}
async function joinGroup() {
  await props.run(async () => {
    joinRequest.value = await props.workflow.beginJoin();
  }, explain);
}
async function useOffer() {
  review.value = null;
  confirmed.value = false;
  await props.run(async () => {
    review.value = await props.workflow.useOffer(offerText.value.trim());
  }, explain);
}
async function confirmRoutes() {
  await props.run(async () => {
    await props.workflow.confirmOffer();
    confirmed.value = true;
  }, explain);
}
async function acceptInvitation() {
  await props.run(async () => {
    acceptance.value = await props.workflow.acceptInvitation(
      offerText.value.trim(),
    );
  }, explain);
}
async function configureRoutes() {
  await props.run(async () => {
    await props.workflow.configureRoutes(routeList.value.trim());
  }, explain);
}
async function issueInvitation() {
  await props.run(async () => {
    offerOut.value = await props.workflow.issueInvitation(
      joinRequestPaste.value.trim(),
      joinerRealm.value.trim(),
    );
  }, explain);
}
async function admitAndGrant() {
  await props.run(async () => {
    const done = await props.workflow.admitAndGrant(
      acceptancePaste.value.trim(),
    );
    admitted.value =
      done.admit === null && done.grants.length === 0
        ? "This member is already admitted. Nothing new was signed."
        : `Admitted and granted ${done.grants.length} thread${done.grants.length === 1 ? "" : "s"}. These operations are saved on this device and are not delivered yet.`;
  }, explain);
}
</script>
<template>
  <section class="enrollment" aria-label="Enrollment">
    <h2>Relay enrollment</h2>
    <p class="fine">
      Relay routes are hand-configured by an operator and are not signed by
      any catalog. Recovery comes later.
    </p>

    <div v-if="!isFounder" class="enroll-step">
      <h3>Join a group</h3>
      <p class="muted">
        Create your identity once, then send the join request to the person
        who started the group.
      </p>
      <button
        type="button"
        aria-label="Join a group"
        :disabled="busy || !canJoin"
        @click="joinGroup"
      >
        Join a group
      </button>
      <template v-if="joinRequest">
        <label for="join-request">Join request</label>
        <textarea
          id="join-request"
          aria-label="Join request"
          readonly
          rows="3"
          :value="joinRequest"
        />
        <button
          type="button"
          class="secondary"
          aria-label="Copy join request"
          @click="copy(joinRequest)"
        >
          Copy join request
        </button>
      </template>
      <label for="paste-offer">Paste offer</label>
      <textarea
        id="paste-offer"
        v-model="offerText"
        aria-label="Paste offer"
        rows="3"
        :disabled="busy"
      />
      <div class="actions">
        <button
          type="button"
          aria-label="Use offer"
          :disabled="busy || !offerText.trim()"
          @click="useOffer"
        >
          Use offer
        </button>
        <button
          type="button"
          aria-label="Accept invitation"
          :disabled="busy || !offerText.trim() || !space"
          @click="acceptInvitation"
        >
          Accept invitation
        </button>
      </div>
      <section v-if="review" class="notice" aria-label="Offer review">
        <h3>Review this offer</h3>
        <p>
          {{ review.threads.length }} thread{{
            review.threads.length === 1 ? "" : "s"
          }}
          in scope<span v-if="review.threads.some((t) => t.archived)">
            (archived threads are included)</span
          >. Transport realm: <code>{{ review.localRealm }}</code
          >.
          <span v-if="review.invitationVerified"
            >The invitation is verified against the group's history.</span
          ><span v-else
            >The invitation can be verified after the group's history
            arrives.</span
          >
        </p>
        <ul class="routes">
          <li v-for="route in review.routes" :key="route.replica">
            <code>{{ short(route.replica) }}</code> at
            <code>{{ route.url }}</code
            ><br />Server realm <code>{{ route.expectedPeerRealm }}</code
            ><br />Server key <code>{{ route.expectedPeerPubkey }}</code>
          </li>
        </ul>
        <p class="disclosure">{{ DISCLOSURE }}</p>
        <button
          type="button"
          aria-label="Confirm routes"
          :disabled="busy || confirmed"
          @click="confirmRoutes"
        >
          {{ confirmed ? "Routes saved" : "Confirm routes" }}
        </button>
      </section>
      <template v-if="acceptance">
        <label for="acceptance-out">Acceptance</label>
        <textarea
          id="acceptance-out"
          aria-label="Acceptance"
          readonly
          rows="3"
          :value="acceptance"
        />
        <button
          type="button"
          class="secondary"
          aria-label="Copy acceptance"
          @click="copy(acceptance)"
        >
          Copy acceptance
        </button>
      </template>
    </div>

    <div v-else class="enroll-step">
      <h3>Invite a member</h3>
      <label for="route-list">Paste route list</label>
      <textarea
        id="route-list"
        v-model="routeList"
        aria-label="Paste route list"
        rows="3"
        :disabled="busy"
      />
      <button
        type="button"
        class="secondary"
        aria-label="Configure routes"
        :disabled="busy || !routeList.trim()"
        @click="configureRoutes"
      >
        Configure routes
      </button>
      <label for="paste-join-request">Paste join request</label>
      <textarea
        id="paste-join-request"
        v-model="joinRequestPaste"
        aria-label="Paste join request"
        rows="2"
        :disabled="busy"
      />
      <label for="joiner-realm">Joiner realm</label>
      <input
        id="joiner-realm"
        v-model="joinerRealm"
        aria-label="Joiner realm"
        placeholder="Transport realm of the person joining"
        :disabled="busy"
      />
      <button
        type="button"
        aria-label="Issue invitation"
        :disabled="busy || !joinRequestPaste.trim() || !joinerRealm.trim()"
        @click="issueInvitation"
      >
        Issue invitation
      </button>
      <template v-if="offerOut">
        <label for="offer-out">Offer</label>
        <textarea
          id="offer-out"
          aria-label="Offer"
          readonly
          rows="3"
          :value="offerOut"
        />
        <button
          type="button"
          class="secondary"
          aria-label="Copy offer"
          @click="copy(offerOut)"
        >
          Copy offer
        </button>
      </template>
      <label for="paste-acceptance">Paste acceptance</label>
      <textarea
        id="paste-acceptance"
        v-model="acceptancePaste"
        aria-label="Paste acceptance"
        rows="3"
        :disabled="busy"
      />
      <button
        type="button"
        aria-label="Admit and grant"
        :disabled="busy || !acceptancePaste.trim()"
        @click="admitAndGrant"
      >
        Admit and grant
      </button>
      <p v-if="admitted" role="status">{{ admitted }}</p>
    </div>

    <section v-if="state.relay" class="notice" aria-label="Saved relay routes">
      <h3>Saved relay routes</h3>
      <p>
        Transport realm <code>{{ state.relay.localRealm }}</code>
      </p>
      <ul class="routes">
        <li v-for="route in state.relay.routes" :key="route.replica">
          <code>{{ short(route.replica) }}</code> at
          <code>{{ route.url }}</code
          ><br />Server realm <code>{{ route.expectedPeerRealm }}</code
          ><br />Server key <code>{{ route.expectedPeerPubkey }}</code>
        </li>
      </ul>
      <p class="disclosure">{{ DISCLOSURE }}</p>
    </section>
    <p v-if="copyNote" role="status" class="muted">{{ copyNote }}</p>
  </section>
</template>
