<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  loadTownshipNativeStatus,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_STORAGE_NAMESPACE,
  type TownshipNativeStatus,
} from "./native_workflow";
import {
  loadTownshipActionAvailability,
  submitTownshipDelegation,
  submitTownshipRevocation,
  submitTownshipCommand,
  submitTownshipPost,
  type TownshipActionAvailability,
  type TownshipCommandName,
  type TownshipDelegationSubmission,
  type TownshipRevocationSubmission,
  type TownshipCommandSubmission,
  type TownshipPostSubmission,
} from "./township_actions";
import { townshipPreview } from "./township_preview";
import { townshipCarrierPeerFromEnv } from "./township_carrier_peer";
import { syncTownshipOutbox, type TownshipOutboxSync } from "./township_sync";

const matter = computed(() => townshipPreview());
const carrierPeer = townshipCarrierPeerFromEnv();
const autosyncOnMount = truthy(import.meta.env.VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT);
const nativeStatus = ref<TownshipNativeStatus>({
  ready: false,
  keyId: TOWNSHIP_NATIVE_KEY_ID,
  storageNamespace: TOWNSHIP_STORAGE_NAMESPACE,
  error: "Checking device key",
});
const actionOrder: readonly TownshipCommandName[] = [
  "set_title",
  "set_summary",
  "post",
  "admit",
  "remove_member",
  "close_matter",
  "reopen_matter",
];
const actionLabels: Record<TownshipCommandName, string> = {
  set_title: "Title",
  set_summary: "Summary",
  post: "Post",
  admit: "Admit member",
  remove_member: "Remove member",
  close_matter: "Close matter",
  reopen_matter: "Reopen matter",
};
type MatterStatusCommand = "close_matter" | "reopen_matter";
type MemberCommand = "admit" | "remove_member";
const actionAvailability = ref<TownshipActionAvailability>({
  ready: false,
  reason: "native_unavailable",
  message: "Checking local action permissions.",
});
const summaryDraft = ref(matter.value.summary);
const summaryStatus = ref<TownshipCommandSubmission | null>(null);
const summarySubmitting = ref(false);
const statusStatus = ref<TownshipCommandSubmission | null>(null);
const statusSubmitting = ref<MatterStatusCommand | null>(null);
const memberDraft = ref("");
const memberStatus = ref<TownshipCommandSubmission | null>(null);
const memberSubmitting = ref<MemberCommand | null>(null);
const grantAudienceDraft = ref("");
const grantStatus = ref<TownshipDelegationSubmission | null>(null);
const grantSubmitting = ref(false);
const revokeDelegationDraft = ref("");
const revokeStatus = ref<TownshipRevocationSubmission | null>(null);
const revokeSubmitting = ref(false);
const postDraft = ref("");
const postStatus = ref<TownshipPostSubmission | null>(null);
const postSubmitting = ref(false);
const syncStatus = ref<TownshipOutboxSync | null>(null);
const syncSubmitting = ref(false);
const postStatusMessage = computed(() => {
  if (postStatus.value === null) return "Local post will be signed by this device key.";
  if (postStatus.value.ok) return `Saved signed frame ${postStatus.value.frameId.slice(0, 10)}...`;
  return postStatus.value.message;
});
const postStatusTone = computed(() => {
  if (postStatus.value === null) return "idle";
  return postStatus.value.ok ? "success" : postStatus.value.reason;
});
const summaryStatusMessage = computed(() => {
  if (summaryStatus.value === null) return "Summary edits will be signed by this device key.";
  if (summaryStatus.value.ok) return `Saved signed frame ${summaryStatus.value.frameId.slice(0, 10)}...`;
  return summaryStatus.value.message;
});
const summaryStatusTone = computed(() => {
  if (summaryStatus.value === null) return "idle";
  return summaryStatus.value.ok ? "success" : summaryStatus.value.reason;
});
const statusStatusMessage = computed(() => {
  if (statusStatus.value === null) return "Close and reopen actions will be signed by this device key.";
  if (statusStatus.value.ok) return `Saved signed frame ${statusStatus.value.frameId.slice(0, 10)}...`;
  return statusStatus.value.message;
});
const statusStatusTone = computed(() => {
  if (statusStatus.value === null) return "idle";
  return statusStatus.value.ok ? "success" : statusStatus.value.reason;
});
const memberStatusMessage = computed(() => {
  if (memberStatus.value === null) return "Member changes will be signed by this device key.";
  if (memberStatus.value.ok) return `Saved signed frame ${memberStatus.value.frameId.slice(0, 10)}...`;
  return memberStatus.value.message;
});
const memberStatusTone = computed(() => {
  if (memberStatus.value === null) return "idle";
  return memberStatus.value.ok ? "success" : memberStatus.value.reason;
});
const grantStatusMessage = computed(() => {
  if (grantStatus.value === null) return "Resident access will be signed by this device key.";
  if (grantStatus.value.ok) {
    return `Saved grant frame ${grantStatus.value.frameId.slice(0, 10)}...; pending carrier sync.`;
  }
  return grantStatus.value.message;
});
const grantStatusTone = computed(() => {
  if (grantStatus.value === null) return "idle";
  return grantStatus.value.ok ? "success" : grantStatus.value.reason;
});
const revokeStatusMessage = computed(() => {
  if (revokeStatus.value === null) return "Revokes are saved locally and confirmed by carrier sync.";
  if (revokeStatus.value.ok) {
    return `Saved revoke frame ${revokeStatus.value.frameId.slice(0, 10)}...; pending carrier sync.`;
  }
  return revokeStatus.value.message;
});
const revokeStatusTone = computed(() => {
  if (revokeStatus.value === null) return "idle";
  return revokeStatus.value.ok ? "success" : revokeStatus.value.reason;
});
const syncStatusMessage = computed(() => {
  if (syncStatus.value === null) return "No carrier peer is connected yet.";
  if (syncStatus.value.ok) {
    return `Pushed ${syncStatus.value.pushedFrameCount}, pulled ${syncStatus.value.pulledOpCount}, accepted ${syncStatus.value.acceptedCount}.`;
  }
  return syncStatus.value.message;
});
const syncStatusTone = computed(() => {
  if (syncStatus.value === null) return "idle";
  return syncStatus.value.ok ? "success" : syncStatus.value.reason;
});
const availableActions = computed(() => {
  const availability = actionAvailability.value;
  if (!availability.ready) return [];

  return actionOrder.map((name) => ({
    ...availability.commands[name],
    label: actionLabels[name],
  }));
});

onMounted(async () => {
  nativeStatus.value = await loadTownshipNativeStatus();
  actionAvailability.value = await loadTownshipActionAvailability();
  if (autosyncOnMount && carrierPeer) await syncOutbox();
});

async function submitPost() {
  postSubmitting.value = true;
  postStatus.value = await submitTownshipPost({ text: postDraft.value });
  if (postStatus.value.ok) postDraft.value = "";
  postSubmitting.value = false;
}

async function submitSummary() {
  summarySubmitting.value = true;
  summaryStatus.value = await submitTownshipCommand({
    command: { command: "set_summary", text: summaryDraft.value },
  });
  summarySubmitting.value = false;
}

async function submitMatterStatus(command: MatterStatusCommand) {
  statusSubmitting.value = command;
  statusStatus.value = await submitTownshipCommand({ command: { command } });
  statusSubmitting.value = null;
}

function statusActionAllowed(command: MatterStatusCommand): boolean {
  const availability = actionAvailability.value;
  return availability.ready && availability.commands[command].allowed;
}

async function submitMemberCommand(command: MemberCommand) {
  memberSubmitting.value = command;
  memberStatus.value = await submitTownshipCommand({
    command: { command, member: memberDraft.value },
  });
  if (memberStatus.value.ok) memberDraft.value = "";
  memberSubmitting.value = null;
}

function memberActionAllowed(command: MemberCommand): boolean {
  const availability = actionAvailability.value;
  return availability.ready && availability.commands[command].allowed;
}

async function submitGrant() {
  grantSubmitting.value = true;
  grantStatus.value = await submitTownshipDelegation({ audiencePubkey: grantAudienceDraft.value });
  if (grantStatus.value.ok) {
    grantAudienceDraft.value = "";
    actionAvailability.value = await loadTownshipActionAvailability();
  }
  grantSubmitting.value = false;
}

async function submitRevoke() {
  revokeSubmitting.value = true;
  revokeStatus.value = await submitTownshipRevocation({ delegationId: revokeDelegationDraft.value });
  if (revokeStatus.value.ok) {
    revokeDelegationDraft.value = "";
  }
  revokeSubmitting.value = false;
}

async function syncOutbox() {
  syncSubmitting.value = true;
  syncStatus.value = await syncTownshipOutbox(carrierPeer ? { peer: carrierPeer } : {});
  syncSubmitting.value = false;
}

function truthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">Township</p>
        <h1>{{ matter.title }}</h1>
      </div>
      <div class="status-stack">
        <div class="status-strip" :data-state="matter.status.toLowerCase()">
          <span>{{ matter.status }}</span>
          <strong>{{ matter.appliedCount }}/{{ matter.opCount }}</strong>
        </div>
        <div class="native-strip" :data-state="nativeStatus.ready ? 'ready' : 'unavailable'">
          <span>Device key</span>
          <strong>{{ nativeStatus.ready ? "Ready" : "Browser preview" }}</strong>
          <small>{{ nativeStatus.ready ? nativeStatus.keyId : "Native bridge unavailable" }}</small>
        </div>
      </div>
    </header>

    <section class="overview">
      <article class="matter-panel">
        <div class="panel-heading">
          <p>Summary</p>
          <span>Clerk: {{ matter.clerk }}</span>
        </div>
        <p class="summary">{{ matter.summary }}</p>
        <dl class="metrics">
          <div>
            <dt>Members</dt>
            <dd>{{ matter.members.length }}</dd>
          </div>
          <div>
            <dt>Posts</dt>
            <dd>{{ matter.posts.length }}</dd>
          </div>
          <div>
            <dt>Quarantine</dt>
            <dd>{{ matter.quarantineCount }}</dd>
          </div>
        </dl>
      </article>

      <aside class="roster-panel">
        <div class="panel-heading">
          <p>Members</p>
        </div>
        <ul class="member-list">
          <li v-for="member in matter.members" :key="member">
            <span class="member-dot" aria-hidden="true"></span>
            {{ member }}
          </li>
        </ul>
      </aside>
    </section>

    <section class="actions-panel">
      <div class="panel-heading">
        <p>Available actions</p>
        <span>{{ actionAvailability.ready ? "Local delegation evidence" : "Native bridge unavailable" }}</span>
      </div>
      <ul v-if="actionAvailability.ready" class="action-list">
        <li
          v-for="action in availableActions"
          :key="action.commandName"
          :data-state="action.allowed ? 'allowed' : 'blocked'"
        >
          <span>{{ action.label }}</span>
          <strong>{{ action.allowed ? "Available" : "No local cap" }}</strong>
        </li>
      </ul>
      <p v-else class="post-message" data-state="native_unavailable">{{ actionAvailability.message }}</p>
    </section>

    <section class="status-panel">
      <div class="panel-heading">
        <p>Matter status</p>
        <span>Signed local action</span>
      </div>
      <div class="status-actions">
        <p class="post-message" :data-state="statusStatusTone">{{ statusStatusMessage }}</p>
        <div class="status-buttons">
          <button
            type="button"
            :disabled="statusSubmitting !== null || !statusActionAllowed('close_matter')"
            @click="submitMatterStatus('close_matter')"
          >
            {{ statusSubmitting === "close_matter" ? "Signing" : "Close matter" }}
          </button>
          <button
            type="button"
            :disabled="statusSubmitting !== null || !statusActionAllowed('reopen_matter')"
            @click="submitMatterStatus('reopen_matter')"
          >
            {{ statusSubmitting === "reopen_matter" ? "Signing" : "Reopen matter" }}
          </button>
        </div>
      </div>
    </section>

    <section class="member-panel">
      <div class="panel-heading">
        <p>Member management</p>
        <span>Signed local action</span>
      </div>
      <form class="member-form" @submit.prevent>
        <input
          v-model="memberDraft"
          aria-label="Member name"
          autocomplete="off"
          placeholder="Member name"
          type="text"
        />
        <div class="member-actions">
          <p class="post-message" :data-state="memberStatusTone">{{ memberStatusMessage }}</p>
          <div class="status-buttons">
            <button
              type="button"
              :disabled="memberSubmitting !== null || memberDraft.trim().length === 0 || !memberActionAllowed('admit')"
              @click="submitMemberCommand('admit')"
            >
              {{ memberSubmitting === "admit" ? "Signing" : "Admit member" }}
            </button>
            <button
              type="button"
              :disabled="
                memberSubmitting !== null ||
                memberDraft.trim().length === 0 ||
                !memberActionAllowed('remove_member')
              "
              @click="submitMemberCommand('remove_member')"
            >
              {{ memberSubmitting === "remove_member" ? "Signing" : "Remove member" }}
            </button>
          </div>
        </div>
      </form>
    </section>

    <section class="grant-panel">
      <div class="panel-heading">
        <p>Access grant</p>
        <span>Signed local cap</span>
      </div>
      <form class="grant-form" @submit.prevent="submitGrant">
        <input
          v-model="grantAudienceDraft"
          aria-label="Device public key"
          autocomplete="off"
          placeholder="Device public key"
          type="text"
        />
        <div class="grant-actions">
          <p class="post-message" :data-state="grantStatusTone">{{ grantStatusMessage }}</p>
          <button type="submit" :disabled="grantSubmitting || grantAudienceDraft.trim().length === 0">
            {{ grantSubmitting ? "Signing" : "Grant access" }}
          </button>
        </div>
      </form>
    </section>

    <section class="grant-panel">
      <div class="panel-heading">
        <p>Access revoke</p>
        <span>Signed local cap</span>
      </div>
      <form class="grant-form" @submit.prevent="submitRevoke">
        <input
          v-model="revokeDelegationDraft"
          aria-label="Delegation id"
          autocomplete="off"
          placeholder="Delegation id"
          type="text"
        />
        <div class="grant-actions">
          <p class="post-message" :data-state="revokeStatusTone">{{ revokeStatusMessage }}</p>
          <button type="submit" :disabled="revokeSubmitting || revokeDelegationDraft.trim().length === 0">
            {{ revokeSubmitting ? "Signing" : "Revoke access" }}
          </button>
        </div>
      </form>
    </section>

    <section class="compose-panel">
      <div class="panel-heading">
        <p>Summary edit</p>
        <span>Signed local action</span>
      </div>
      <form class="post-form" @submit.prevent="submitSummary">
        <textarea
          v-model="summaryDraft"
          aria-label="Township summary"
          placeholder="Update the matter summary"
          rows="3"
        ></textarea>
        <div class="post-actions">
          <p class="post-message" :data-state="summaryStatusTone">{{ summaryStatusMessage }}</p>
          <button type="submit" :disabled="summarySubmitting || summaryDraft.trim().length === 0">
            {{ summarySubmitting ? "Signing" : "Update summary" }}
          </button>
        </div>
      </form>
    </section>

    <section class="compose-panel">
      <div class="panel-heading">
        <p>Post update</p>
        <span>Signed local action</span>
      </div>
      <form class="post-form" @submit.prevent="submitPost">
        <textarea
          v-model="postDraft"
          aria-label="Township post update"
          placeholder="Add a resident update"
          rows="3"
        ></textarea>
        <div class="post-actions">
          <p class="post-message" :data-state="postStatusTone">{{ postStatusMessage }}</p>
          <button type="submit" :disabled="postSubmitting || postDraft.trim().length === 0">
            {{ postSubmitting ? "Signing" : "Post update" }}
          </button>
        </div>
      </form>
    </section>

    <section class="sync-panel">
      <div class="panel-heading">
        <p>Carrier</p>
        <span>Outbox sync</span>
      </div>
      <div class="sync-actions">
        <p class="sync-message" :data-state="syncStatusTone">{{ syncStatusMessage }}</p>
        <button type="button" :disabled="syncSubmitting" @click="syncOutbox">
          {{ syncSubmitting ? "Syncing" : "Sync outbox" }}
        </button>
      </div>
    </section>

    <section class="posts-panel">
      <div class="panel-heading">
        <p>Proceedings</p>
      </div>
      <ol class="post-list">
        <li v-for="post in matter.posts" :key="post">
          {{ post }}
        </li>
      </ol>
    </section>
  </main>
</template>
