<script setup lang="ts">
import { computed, ref } from "vue";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import type { DemoIdentity } from "../lib/custody";
import type { DemoEndpoint } from "../lib/browser_host";
import {
  authorTownshipCommand,
  frontierIds,
  observeTownshipMatter,
  pickCapabilityForCommand,
} from "../lib/products";

const props = defineProps<{
  endpoint: DemoEndpoint | null;
  frames: CarrierOpFrame[];
  identity: DemoIdentity | null;
  realmByPubkey: Record<string, string>;
  pendingCount: number;
  onAppendFrame: (replica: string, frame: CarrierOpFrame) => Promise<void>;
}>();

const postText = ref("");
const summaryText = ref("");
const status = ref("");
const error = ref("");
const busy = ref(false);

const liveViewUrl = computed(() => {
  const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
  return host === "127.0.0.1" || host === "localhost"
    ? "http://localhost:4120/township"
    : "/township";
});

const view = computed(() =>
  props.frames.length > 0 ? observeTownshipMatter(props.frames, props.realmByPubkey) : null,
);

const postCap = computed(() =>
  props.identity
    ? pickCapabilityForCommand(
        "Township.Matter",
        props.frames,
        props.identity.publicKeyBase64,
        "post",
        props.realmByPubkey,
      )
    : null,
);

const summaryCap = computed(() =>
  props.identity
    ? pickCapabilityForCommand(
        "Township.Matter",
        props.frames,
        props.identity.publicKeyBase64,
        "set_summary",
        props.realmByPubkey,
      )
    : null,
);

const clerkCap = computed(() =>
  props.identity
    ? pickCapabilityForCommand(
        "Township.Matter",
        props.frames,
        props.identity.publicKeyBase64,
        view.value?.clerkLocked ? "reopen_matter" : "close_matter",
        props.realmByPubkey,
      )
    : null,
);

async function run(label: string, fn: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  status.value = "";
  try {
    await fn();
    status.value = label;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function sendPost() {
  const text = postText.value.trim();
  if (!text || !props.identity || !props.endpoint) return;
  await run("Signed and queued Township post (watch LiveView update via ops_available).", async () => {
    const frame = await authorTownshipCommand({
      replica: props.endpoint!.replica,
      deps: frontierIds(props.frames),
      signer: props.identity!.signer,
      capId: postCap.value,
      command: { command: "post", text },
    });
    postText.value = "";
    await props.onAppendFrame(props.endpoint!.replica, frame);
  });
}

async function updateSummary() {
  const text = summaryText.value.trim();
  if (!text || !props.identity || !props.endpoint) return;
  await run("Signed and queued summary update.", async () => {
    const frame = await authorTownshipCommand({
      replica: props.endpoint!.replica,
      deps: frontierIds(props.frames),
      signer: props.identity!.signer,
      capId: summaryCap.value,
      command: { command: "set_summary", text },
    });
    summaryText.value = "";
    await props.onAppendFrame(props.endpoint!.replica, frame);
  });
}

async function toggleLock(unauthorized: boolean) {
  if (!props.identity || !props.endpoint) return;
  const cmd = view.value?.clerkLocked ? "reopen_matter" : "close_matter";
  const label = unauthorized
    ? `Authored unauthorized ${cmd} op (check Quarantine Inspector & LiveView).`
    : `Signed and queued ${cmd}.`;
  await run(label, async () => {
    const frame = await authorTownshipCommand({
      replica: props.endpoint!.replica,
      deps: frontierIds(props.frames),
      signer: props.identity!.signer,
      capId: unauthorized ? null : clerkCap.value,
      command: { command: cmd },
    });
    await props.onAppendFrame(props.endpoint!.replica, frame);
  });
}
</script>

<template>
  <div class="grid-2" data-testid="township-app">
    <section class="card">
      <h2>
        <span>Township Matter</span>
        <span class="pill" :class="view?.clerkLocked ? 'warn' : 'ok'">
          {{ view?.clerkLocked ? "clerk locked" : "open" }}
        </span>
      </h2>
      <div v-if="endpoint" class="mono muted">{{ endpoint.replica }}</div>

      <template v-if="view">
        <div class="item">
          <strong>{{ view.title }}</strong>
          <span class="muted">{{ view.summary }}</span>
        </div>
        <div class="row">
          <span class="pill ok">clerk: {{ view.clerkHolder ?? "none" }}</span>
          <span class="pill">members: {{ view.members.join(", ") || "none" }}</span>
          <span v-if="view.quarantinedCount > 0" class="pill danger">
            quarantined: {{ view.quarantinedCount }}
          </span>
        </div>

        <div class="row">
          <input
            v-model="summaryText"
            class="grow"
            placeholder="Update matter summary (clerk/root cap)…"
          />
          <button :disabled="busy || !summaryCap || !summaryText.trim()" @click="updateSummary">
            Set Summary
          </button>
        </div>

        <div class="row">
          <button
            v-if="clerkCap"
            class="primary"
            :disabled="busy"
            @click="toggleLock(false)"
          >
            {{ view.clerkLocked ? "Reopen Matter (Clerk)" : "Close Matter (Clerk)" }}
          </button>
          <button
            class="danger"
            data-testid="township-unauth-btn"
            :disabled="busy || !identity"
            @click="toggleLock(true)"
          >
            Test Unauthorized Close (Quarantine)
          </button>
        </div>
      </template>

      <div class="notice-box">
        Open
        <a :href="liveViewUrl" target="_blank" rel="noreferrer">
          {{ liveViewUrl }}
        </a>
        to watch Phoenix LiveView + Vue causal replay update in real time from posts authored here.
      </div>
    </section>

    <section class="card">
      <h2>
        <span>Deliberation Feed</span>
        <span v-if="pendingCount > 0" class="pill warn">outbox: {{ pendingCount }}</span>
      </h2>

      <div v-if="error" class="error-box">{{ error }}</div>
      <div v-if="status" class="notice-box">{{ status }}</div>

      <div class="list" data-testid="township-posts">
        <div v-for="p in view?.posts ?? []" :key="p.id" class="item">
          <div class="item-head">
            <strong>{{ p.author }}</strong>
            <span class="mono">{{ p.id.slice(0, 10) }}…</span>
          </div>
          <div>{{ p.text }}</div>
        </div>
      </div>

      <div class="row">
        <input
          v-model="postText"
          class="grow"
          data-testid="township-post-input"
          placeholder="Add a signed civic deliberation comment…"
          @keyup.enter="sendPost"
        />
        <button
          class="primary"
          data-testid="township-post-submit"
          :disabled="busy || !postCap || !postText.trim()"
          @click="sendPost"
        >
          Post Comment
        </button>
      </div>
    </section>
  </div>
</template>
