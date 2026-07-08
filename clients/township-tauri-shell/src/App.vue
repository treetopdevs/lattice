<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  loadTownshipNativeStatus,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_STORAGE_NAMESPACE,
  type TownshipNativeStatus,
} from "./native_workflow";
import { submitTownshipPost, type TownshipPostSubmission } from "./township_actions";
import { townshipPreview } from "./township_preview";
import { townshipCarrierPeerFromEnv } from "./township_carrier_peer";
import { syncTownshipOutbox, type TownshipOutboxSync } from "./township_sync";

const matter = computed(() => townshipPreview());
const carrierPeer = townshipCarrierPeerFromEnv();
const nativeStatus = ref<TownshipNativeStatus>({
  ready: false,
  keyId: TOWNSHIP_NATIVE_KEY_ID,
  storageNamespace: TOWNSHIP_STORAGE_NAMESPACE,
  error: "Checking device key",
});
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

onMounted(async () => {
  nativeStatus.value = await loadTownshipNativeStatus();
});

async function submitPost() {
  postSubmitting.value = true;
  postStatus.value = await submitTownshipPost({ text: postDraft.value });
  if (postStatus.value.ok) postDraft.value = "";
  postSubmitting.value = false;
}

async function syncOutbox() {
  syncSubmitting.value = true;
  syncStatus.value = await syncTownshipOutbox(carrierPeer ? { peer: carrierPeer } : {});
  syncSubmitting.value = false;
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
