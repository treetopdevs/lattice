<script setup lang="ts">
import { computed, ref } from "vue";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import type { DemoIdentity } from "../lib/custody";
import type { DemoEndpoint } from "../lib/browser_host";
import {
  authorTreehouseCommand,
  framesToOps,
  frontierIds,
  observeTreehouse,
  pickCapabilityForCommand,
} from "../lib/products";

const props = defineProps<{
  spaceEndpoint: DemoEndpoint | null;
  threadEndpoint: DemoEndpoint | null;
  spaceFrames: CarrierOpFrame[];
  threadFrames: CarrierOpFrame[];
  identity: DemoIdentity | null;
  realmByPubkey: Record<string, string>;
  pendingCount: number;
  onAppendFrame: (replica: string, frame: CarrierOpFrame) => Promise<void>;
}>();

const postText = ref("");
const editingPostId = ref<string | null>(null);
const editText = ref("");
const status = ref("");
const error = ref("");
const busy = ref(false);

const spaceView = computed(() => {
  if (!props.spaceEndpoint || props.spaceFrames.length === 0) return null;
  const ops = framesToOps("Treehouse.Space", props.spaceFrames, props.realmByPubkey);
  return observeTreehouse("Treehouse.Space", ops);
});

const threadView = computed(() => {
  if (!props.threadEndpoint || props.threadFrames.length === 0) return null;
  const ops = framesToOps("Treehouse.Thread", props.threadFrames, props.realmByPubkey);
  return observeTreehouse("Treehouse.Thread", ops);
});

const postCap = computed(() =>
  props.identity && props.threadEndpoint
    ? pickCapabilityForCommand(
        "Treehouse.Thread",
        props.threadFrames,
        props.identity.publicKeyBase64,
        "post",
        props.realmByPubkey,
      )
    : null,
);

const editCap = computed(() =>
  props.identity && props.threadEndpoint
    ? pickCapabilityForCommand(
        "Treehouse.Thread",
        props.threadFrames,
        props.identity.publicKeyBase64,
        "author_edit",
        props.realmByPubkey,
      )
    : null,
);

const archiveCap = computed(() =>
  props.identity && props.threadEndpoint
    ? pickCapabilityForCommand(
        "Treehouse.Thread",
        props.threadFrames,
        props.identity.publicKeyBase64,
        "archive_thread",
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
  if (!text || !props.identity || !props.threadEndpoint) return;
  await run("Signed and queued Treehouse post.", async () => {
    const frame = await authorTreehouseCommand({
      product: "Treehouse.Thread",
      replica: props.threadEndpoint!.replica,
      deps: frontierIds(props.threadFrames),
      signer: props.identity!.signer,
      capId: postCap.value,
      command: { command: "post", text },
    });
    postText.value = "";
    await props.onAppendFrame(props.threadEndpoint!.replica, frame);
  });
}

async function submitEdit(postId: string) {
  const text = editText.value.trim();
  if (!text || !props.identity || !props.threadEndpoint) return;
  await run("Signed and queued Treehouse post edit.", async () => {
    const frame = await authorTreehouseCommand({
      product: "Treehouse.Thread",
      replica: props.threadEndpoint!.replica,
      deps: frontierIds(props.threadFrames),
      signer: props.identity!.signer,
      capId: editCap.value,
      command: { command: "author_edit", postId, targetId: postId, text },
    });
    editingPostId.value = null;
    editText.value = "";
    await props.onAppendFrame(props.threadEndpoint!.replica, frame);
  });
}

async function archiveThread(unauthorized: boolean) {
  if (!props.identity || !props.threadEndpoint) return;
  const label = unauthorized
    ? "Authored unauthorized archive_thread op (check Quarantine Inspector)."
    : "Signed and queued archive_thread.";
  await run(label, async () => {
    const frame = await authorTreehouseCommand({
      product: "Treehouse.Thread",
      replica: props.threadEndpoint!.replica,
      deps: frontierIds(props.threadFrames),
      signer: props.identity!.signer,
      capId: unauthorized ? null : archiveCap.value,
      command: { command: "archive_thread" },
    });
    await props.onAppendFrame(props.threadEndpoint!.replica, frame);
  });
}
</script>

<template>
  <div class="grid-2" data-testid="treehouse-app">
    <section class="card">
      <h2>
        <span>Treehouse Space</span>
        <span class="pill">{{ spaceView?.state.name || "Not synced" }}</span>
      </h2>
      <div v-if="spaceEndpoint" class="mono muted">{{ spaceEndpoint.replica }}</div>
      <div v-if="spaceView" class="list">
        <div class="item">
          <div class="item-head"><span>Members</span><span>{{ (spaceView.state.members as string[] || []).length }}</span></div>
          <div class="row">
            <span
              v-for="m in (spaceView.state.members as string[] || [])"
              :key="m"
              class="pill ok"
            >{{ realmByPubkey[m] ?? m.slice(0, 10) }}</span>
          </div>
        </div>
        <div class="item">
          <div class="item-head"><span>Linked Threads</span><span>{{ (spaceView.state.threads as string[] || []).length }}</span></div>
          <div v-for="t in (spaceView.state.threads as string[] || [])" :key="t" class="mono">
            {{ t }}
          </div>
        </div>
      </div>
      <p class="muted" style="margin: 0; font-size: 12.5px">
        Interoperates directly over the same carrier routes with the native Treehouse desktop app
        (<code>scripts/demo_ecosystem_treehouse.sh</code>).
      </p>
    </section>

    <section class="card">
      <h2>
        <span>Treehouse Thread: {{ threadView?.state.title || "Loading…" }}</span>
        <span class="pill" :class="threadView?.state.archived ? 'warn' : 'ok'">
          {{ threadView?.state.archived ? "archived" : "open" }}
        </span>
      </h2>

      <div v-if="error" class="error-box">{{ error }}</div>
      <div v-if="status" class="notice-box">{{ status }}</div>

      <div class="list" data-testid="treehouse-posts">
        <div v-for="p in threadView?.posts ?? []" :key="p.id" class="item">
          <div class="item-head">
            <strong>{{ p.author }}</strong>
            <span class="mono">{{ p.id.slice(0, 10) }}…</span>
          </div>
          <div v-if="editingPostId === p.id" class="row">
            <input v-model="editText" class="grow" placeholder="Updated post text" />
            <button class="primary" :disabled="busy" @click="submitEdit(p.id)">Save</button>
            <button @click="editingPostId = null">Cancel</button>
          </div>
          <div v-else class="row" style="justify-content: space-between">
            <span>{{ p.text }}</span>
            <button
              v-if="editCap && p.author === identity?.realm"
              style="padding: 2px 8px; font-size: 12px"
              @click="
                editingPostId = p.id;
                editText = String(p.text ?? '');
              "
            >
              Edit
            </button>
          </div>
        </div>
      </div>

      <div class="row">
        <input
          v-model="postText"
          class="grow"
          data-testid="treehouse-post-input"
          placeholder="Write a signed Treehouse post…"
          @keyup.enter="sendPost"
        />
        <button
          class="primary"
          data-testid="treehouse-post-submit"
          :disabled="busy || !postCap || !postText.trim()"
          @click="sendPost"
        >
          Post
        </button>
      </div>

      <div class="row">
        <span class="pill" :class="postCap ? 'ok' : 'warn'">
          {{ postCap ? "post cap ready" : "no post cap" }}
        </span>
        <span v-if="pendingCount > 0" class="pill warn">outbox pending: {{ pendingCount }}</span>
        <button
          v-if="archiveCap && !threadView?.state.archived"
          :disabled="busy"
          @click="archiveThread(false)"
        >
          Archive Thread (Moderator)
        </button>
        <button
          class="danger"
          data-testid="treehouse-unauth-btn"
          :disabled="busy || !identity"
          @click="archiveThread(true)"
        >
          Test Unauthorized Archive (Quarantine)
        </button>
      </div>
    </section>
  </div>
</template>
