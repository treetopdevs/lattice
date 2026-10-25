<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { OfflineInvitationDisplay, TreehouseWorkflow } from "./treehouse_workflow";
import type { PreviewState } from "./treehouse_state";
import { OFFLINE_EVIDENCE_MAX_BYTES } from "./offline_enrollment";
const props = defineProps<{
  workflow: TreehouseWorkflow; state: PreviewState; busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
}>();
const joinRequest = ref(""), recipientRequest = ref(""), recipient = ref("");
const recipientConfirmed = ref(false), fingerprintConfirmed = ref("");
const founderFingerprint = ref(""), joinConfirmed = ref(false);
const exportName = ref("treehouse-invitation.json"), bundleName = ref("treehouse-initial.json");
const invitation = ref(""), acceptance = ref(""), acceptanceInput = ref(""), status = ref("");
const review = ref<OfflineInvitationDisplay | null>(null);
const facts = computed(() => { void props.state; return props.workflow.snapshot(); });
const canInvite = computed(() => facts.value.isFounder && facts.value.canIssueInvitation);
const canAdmit = computed(() => facts.value.isFounder && facts.value.canAdmit);
const joining = computed(() => props.state.profiles.length === 0);
function cancel() {
  props.workflow.cancelOfflineReview(); recipient.value = ""; review.value = null;
  recipientConfirmed.value = false; fingerprintConfirmed.value = "";
}
watch(() => props.state, cancel);
watch(recipientRequest, cancel);
async function begin() { await props.run(async () => { if (!joinConfirmed.value) return; joinRequest.value = await props.workflow.beginJoin(); }); }
async function reviewRecipient() {
  cancel();
  await props.run(async () => { const shown = await props.workflow.reviewOfflineRecipient(recipientRequest.value); recipient.value = shown.recipient; founderFingerprint.value = shown.fingerprint; });
}
async function issue() {
  if (!recipientConfirmed.value) return;
  await props.run(async () => { invitation.value = await props.workflow.issueOfflineInvitation(recipient.value); status.value = "Invitation prepared. Share it privately with this person."; cancel(); });
}
async function readInvitation(event: Event) {
  cancel(); acceptance.value = "";
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await props.run(async () => {
    if (file.size > OFFLINE_EVIDENCE_MAX_BYTES) throw new Error("offline_evidence_too_large");
    review.value = await props.workflow.reviewOfflineInvitation(new Uint8Array(await file.arrayBuffer()));
  });
  (event.target as HTMLInputElement).value = "";
}
async function accept() {
  if (!fingerprintConfirmed.value || !review.value) return;
  const fingerprint = fingerprintConfirmed.value;
  await props.run(async () => { acceptance.value = await props.workflow.acceptOfflineInvitation(fingerprint); cancel(); });
}
async function admit() {
  await props.run(async () => { const result = await props.workflow.admitAndGrant(acceptanceInput.value); status.value = result.admit || result.grants.length ? "Admission and Thread permissions saved together. Prepare the operator bundle next." : "This acceptance is already admitted with its Thread permissions."; });
}
</script>

<template>
  <section class="notice offline-enrollment" aria-label="Offline group invitations">
    <h2>Invite someone by file</h2>
    <p>Exchange these signed files privately. Compare keys and fingerprints in a separate conversation. This step does not connect either app to a relay.</p>
    <template v-if="joining">
      <p>Preparing a join request reserves this app identity for joining an existing group. It cannot then create its own group.</p>
      <label><input v-model="joinConfirmed" type="checkbox" :disabled="busy" />I want this app to join an existing group.</label>
      <button :disabled="busy || Boolean(state.intent) || !joinConfirmed" @click="begin">Prepare join request</button>
      <label v-if="joinRequest">Your join request<textarea :value="joinRequest" readonly aria-label="Your join request" /></label>
      <p v-if="state.publicKey">Your public key: <code>{{ state.publicKey }}</code></p>
      <label>Open invitation file<input type="file" accept=".json,application/json" :disabled="busy || !state.publicKey" @change="readInvitation" /></label>
      <section v-if="review" aria-label="Review offline invitation">
        <h3>{{ review.name }}</h3>
        <ul><li v-for="thread in review.threadTitles" :key="thread.replica">{{ thread.title }}</li></ul>
        <p>Group root: <code>{{ review.spaceRoot }}</code></p>
        <p>Recipient: <code>{{ review.recipient }}</code></p>
        <p>Enter the group code the founder sent through a separate channel. Treehouse checks it against this signed group before signing.</p>
        <label>Fingerprint received from the founder<input v-model="fingerprintConfirmed" :disabled="busy" autocomplete="off" /></label>
        <button :disabled="busy || !fingerprintConfirmed" @click="accept">Sign acceptance</button>
        <button :disabled="busy" @click="cancel">Cancel</button>
      </section>
      <label v-if="acceptance">Send this acceptance to the founder<textarea :value="acceptance" readonly aria-label="Signed acceptance" /></label>
      <p v-if="acceptance">Your identity stays on this device. Group history and relay access arrive in a later step.</p>
    </template>
    <template v-else-if="facts.isFounder">
      <template v-if="canInvite">
      <label>Person's join request<textarea v-model="recipientRequest" :disabled="busy" maxlength="4096" /></label>
      <button :disabled="busy || !recipientRequest" @click="reviewRecipient">Review recipient key</button>
      <section v-if="recipient" aria-label="Review invitation recipient">
        <p>Recipient public key: <code>{{ recipient }}</code></p>
        <label><input v-model="recipientConfirmed" type="checkbox" :disabled="busy" />I compared this key with the person through a separate channel.</label>
        <button :disabled="busy || !recipientConfirmed" @click="issue">Sign invitation</button>
        <button :disabled="busy" @click="cancel">Cancel</button>
      </section>
      <label v-if="founderFingerprint">Group fingerprint to share<textarea :value="founderFingerprint" readonly aria-label="Group fingerprint to share" rows="2" /></label>
      <p v-if="founderFingerprint">Send this code to the person through a separate channel.</p>
      <label v-if="invitation">Signed invitation JSON<textarea :value="invitation" readonly aria-label="Signed offline invitation" /></label>
      <label v-if="invitation">Invitation file name<input v-model="exportName" :disabled="busy" /></label>
      <button v-if="invitation" :disabled="busy" @click="props.run(async () => { status = await workflow.exportOfflineInvitation(exportName, invitation); })">Save invitation file</button>
      </template>
      <template v-if="canAdmit">
      <label>Person's signed acceptance<textarea v-model="acceptanceInput" :disabled="busy" maxlength="4096" /></label>
      <button :disabled="busy || !acceptanceInput" @click="admit">Admit and grant Thread access</button>
      </template>
      <label>Operator bundle file name<input v-model="bundleName" :disabled="busy" /></label>
      <button :disabled="busy" @click="props.run(async () => { status = await workflow.exportInitialProvisioning(bundleName); })">Save initial operator bundle</button>
      <p>The operator must verify the bundle and ceremony before starting the relay. Exporting does not establish relay readiness.</p>
    </template>
    <p role="status">{{ status }}</p>
  </section>
</template>
