<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onMounted,
  onBeforeUnmount,
  ref,
  shallowRef,
} from "vue";
import { TreehouseWorkflow } from "./treehouse_workflow";
import { native } from "./native_adapter";
import WitnessSetup from "./WitnessSetup.vue";
const workflow = new TreehouseWorkflow(native);
// Plan 181 decision 11: the enrollment panel and its relay copy exist only in the build made with
// VITE_TREEHOUSE_ENROLLMENT=1. Vite replaces the flag at build time, so the ordinary and Android builds
// neither emit the panel chunk nor name it.
const enrollment = import.meta.env.VITE_TREEHOUSE_ENROLLMENT === "1";
const EnrollmentPanel = enrollment
  ? defineAsyncComponent(() => import("./EnrollmentPanel.vue"))
  : null;
const state = shallowRef(workflow.state);
const ready = ref(false),
  busy = ref(false),
  error = ref("");
const groupName = ref(""),
  threadTitle = ref(""),
  draftText = ref(""),
  draftRevision = ref(0),
  draftSaved = ref(true);
const draftFailed = ref(false);
const editing = ref<string | null>(null),
  editText = ref(""),
  audit = ref(false);
let draftTimer: ReturnType<typeof setTimeout> | undefined;
let draftWrites: Promise<void> = Promise.resolve();
const space = computed(() =>
  state.value.profiles.find((p) => p.product === "Treehouse.Space"),
);
const threads = computed(() =>
  state.value.profiles.filter((p) => p.product === "Treehouse.Thread"),
);
const active = computed(() =>
  threads.value.find((p) => p.replica === state.value.active),
);
const view = computed(() => {
  state.value;
  return active.value ? workflow.views.get(active.value.replica) : undefined;
});
const name = computed(() =>
  space.value
    ? String(workflow.views.get(space.value.replica)?.state.name ?? "")
    : "",
);
const count = computed(() =>
  state.value.profiles.reduce((n, p) => n + p.frames.length, 0),
);
const queued = computed(() =>
  state.value.profiles.reduce((n, p) => n + p.outbox.length, 0),
);
const writable = computed(
  () =>
    ready.value && workflow.keyAvailable && !state.value.intent && !busy.value,
);
// The founder is the author of the Space's committed genesis (the one its #root: commitment names).
const founderKey = computed(() => (space.value ? workflow.founderKey() : null));
const authorLabel = (author: string) =>
  author === state.value.publicKey
    ? "You"
    : author === founderKey.value
      ? "Founder"
      : "Member";
// Posting needs a capability this key holds: the founder's root grant or a member's Thread grant.
const canPost = computed(
  () =>
    writable.value &&
    active.value !== undefined &&
    workflow.canAuthor(active.value.replica, "post"),
);
// A join identity exists but its Space has not synced yet: creating a group would fail with
// join_in_progress, so the welcome form is not offered.
const joining = computed(
  () => state.value.intent === null && state.value.publicKey !== null && space.value === undefined,
);
// Only the Space's root holder can add a Thread, so a joined member never sees an action that always fails.
const canCreateThread = computed(
  () => writable.value && space.value !== undefined && workflow.canCreateThread(),
);
// Each Thread action is gated on its own operation: a grant may carry one without another, and a revoked
// or lapsed grant carries none.
const canDo = (command: "archive_thread" | "moderator_tombstone" | "author_edit" | "author_tombstone") =>
  writable.value &&
  active.value !== undefined &&
  workflow.canAuthor(active.value.replica, command);
const canArchive = computed(() => canDo("archive_thread"));
const canHideAsModerator = computed(() => canDo("moderator_tombstone"));
const canEditOwn = computed(() => canDo("author_edit"));
const canHideOwn = computed(() => canDo("author_tombstone"));
const title = (replica: string) =>
  String(workflow.views.get(replica)?.state.title ?? "Untitled thread");
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const known: Record<string, string> = {
    stale_saved_state:
      "Another window saved changes. Reopen Treehouse before retrying; your saved history is intact.",
    draft_changed_in_another_window:
      "Another window changed this draft. Your text is still here. Reopen before saving again.",
    draft_storage_conflict:
      "Two saved versions of this draft need resolution. Both are preserved; drafting is unavailable in this thread.",
    preview_storage_limit:
      "This local preview has reached its storage limit. Your saved history remains available.",
    thread_storage_limit:
      "This thread has reached its local authoring limit. Its saved history remains available.",
    thread_slots_full:
      "All twelve local thread slots are in use. Archived threads keep their slots.",
    identity_unavailable:
      "The signing key is unavailable. Saved history is open for reading.",
    identity_mismatch:
      "The signing key does not match this history. Nothing has been replaced.",
    missing_local_history:
      "A signing identity exists but its local history is missing. Nothing has been replaced.",
    key_store_unavailable:
      "The device key store is unavailable. Try again when it is accessible.",
    draft_too_large:
      "Keep this draft under 16 KiB to save it in the local preview.",
    invalid_name: "Enter a name before creating.",
  };
  return (
    known[message] ??
    "The action could not be completed. Your previously saved history is preserved."
  );
}
function refresh() {
  state.value = workflow.state;
}
// A background feed sync can merge a joiner's first Thread, which becomes the active one.
function refreshFromSync() {
  const before = active.value?.replica;
  refresh();
  if (active.value?.replica !== before)
    void loadDraft().catch((cause) => {
      error.value = describe(cause);
    });
}
async function loadDraft() {
  if (!active.value) {
    draftText.value = "";
    draftRevision.value = 0;
    draftSaved.value = true;
    draftFailed.value = false;
    return;
  }
  const draft = await workflow.draft(active.value.replica);
  draftText.value = draft.text;
  draftRevision.value = draft.revision;
  draftSaved.value = true;
  draftFailed.value = false;
}
async function run(
  action: () => Promise<void>,
  explain: (cause: unknown) => string = describe,
) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await action();
    refresh();
  } catch (cause) {
    refresh();
    error.value = explain(cause);
  } finally {
    busy.value = false;
  }
}
function flushDraft(): Promise<void> {
  clearTimeout(draftTimer);
  const replica = active.value?.replica,
    text = draftText.value;
  if (!replica) return Promise.resolve();
  const operation = draftWrites
    .then(async () => {
      draftFailed.value = false;
      if (draftSaved.value && draftText.value === text) return;
      const saved = await workflow.saveDraft(
        replica,
        draftRevision.value,
        text,
      );
      if (active.value?.replica === replica) {
        draftRevision.value = saved.revision;
        draftSaved.value = draftText.value === saved.text;
      }
    })
    .catch((cause) => {
      draftFailed.value = true;
      throw cause;
    });
  draftWrites = operation.catch(() => {});
  return operation;
}
function draftChanged() {
  draftSaved.value = false;
  draftFailed.value = false;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    void flushDraft().catch((cause) => {
      error.value = describe(cause);
    });
  }, 600);
}
async function choose(replica: string) {
  await run(async () => {
    await flushDraft();
    await workflow.select(replica);
    refresh();
    editing.value = null;
    await loadDraft();
  });
}
async function createGroup() {
  await run(async () => {
    await workflow.createSpace(groupName.value);
    refresh();
    await loadDraft();
  });
}
async function createThread() {
  await run(async () => {
    await flushDraft();
    await workflow.createThread(threadTitle.value);
    threadTitle.value = "";
    refresh();
    await loadDraft();
  });
}
async function resume() {
  await run(async () => {
    await workflow.resumeCreation();
    refresh();
    await loadDraft();
  });
}
async function post() {
  await run(async () => {
    const replica = active.value!.replica;
    await flushDraft();
    await workflow.command(
      replica,
      { command: "post", text: draftText.value },
      draftRevision.value,
    );
    refresh();
    await loadDraft();
  });
}
async function saveEdit(id: string) {
  await run(async () => {
    await workflow.command(active.value!.replica, {
      command: "author_edit",
      postId: id,
      targetId: id,
      text: editText.value,
    });
    editing.value = null;
  });
}
async function hide(id: string, moderator = false) {
  await run(async () => {
    await workflow.command(active.value!.replica, {
      command: moderator ? "moderator_tombstone" : "author_tombstone",
      postId: id,
      targetId: id,
    });
  });
}
async function archive() {
  await run(async () => {
    await flushDraft();
    await workflow.command(active.value!.replica, {
      command: "archive_thread",
    });
  });
}
onMounted(async () => {
  try {
    await workflow.open();
    refresh();
    await loadDraft();
    ready.value = true;
  } catch (cause) {
    error.value = describe(cause);
  }
});
onBeforeUnmount(() => clearTimeout(draftTimer));
</script>
<template>
  <div class="app-shell">
    <header class="masthead">
      <a class="wordmark" href="#"
        >Treehouse<span class="preview">{{
          enrollment ? "Relay preview" : "Local preview"
        }}</span></a
      ><span class="recovery">Recovery is not set up</span>
    </header>
    <div v-if="error" role="alert" class="notice error">{{ error }}</div>
    <div v-if="!ready && !error" class="loading" role="status">
      Opening local history…
    </div>
    <main v-if="ready && !space" class="welcome">
      <div class="tree-mark" aria-hidden="true">↟</div>
      <p class="eyebrow">A quieter place to gather</p>
      <h1>A place for your group.</h1>
      <p class="intro">
        Start with an empty space for notes and conversations. This preview
        stays on this device.
      </p>
      <form v-if="!state.intent && !joining" @submit.prevent="createGroup">
        <label for="group-name">Group name</label
        ><input
          id="group-name"
          v-model="groupName"
          aria-label="Group name"
          placeholder="Give your group a name"
          :disabled="busy"
          maxlength="4000"
        /><button type="submit" :disabled="busy || !groupName.trim()">
          {{ busy ? "Creating…" : "Create local group" }}
        </button>
      </form>
      <section v-else-if="joining" class="notice" aria-label="Joining a group">
        <h2>Waiting for your group</h2>
        <p>
          Your identity is ready. The group appears here once Sync brings it
          from the relay after you are admitted.
        </p>
      </section>
      <section v-else class="notice">
        <h2>Group setup is incomplete</h2>
        <p>Your saved setup can be retried with the same identity.</p>
        <button :disabled="busy" @click="resume">Finish local setup</button>
      </section>
      <p v-if="!enrollment" class="fine">
        There are no members or connections yet. Inviting others and recovery
        come later.
      </p>
    </main>
    <div v-else-if="ready" class="workspace">
      <aside class="rail">
        <p class="eyebrow">Your local group</p>
        <h1>{{ name }}</h1>
        <p class="local-label">Saved on this device</p>
        <nav aria-label="Threads">
          <div class="rail-heading">
            <h2>Threads</h2>
            <span>{{ threads.length }} / 12</span>
          </div>
          <button
            v-for="thread in threads"
            :key="thread.replica"
            :class="[
              'thread-link',
              { selected: thread.replica === state.active },
            ]"
            :aria-current="thread.replica === state.active ? 'page' : undefined"
            :disabled="busy"
            @click="choose(thread.replica)"
          >
            <span>{{ title(thread.replica) }}</span
            ><small v-if="workflow.views.get(thread.replica)?.state.archived"
              >Archived</small
            >
          </button>
          <p v-if="!threads.length" class="muted">
            Your first thread starts here.
          </p>
        </nav>
        <form
          v-if="!state.intent"
          class="new-thread"
          @submit.prevent="createThread"
        >
          <label for="thread-title">Thread title</label
          ><input
            id="thread-title"
            v-model="threadTitle"
            aria-label="Thread title"
            placeholder="What’s on your mind?"
            :disabled="!canCreateThread"
            maxlength="4000"
          /><button
            class="secondary"
            type="submit"
            :disabled="!canCreateThread || !threadTitle.trim() || threads.length >= 12"
          >
            Create thread
          </button>
        </form>
        <section v-else class="notice">
          <p>Thread setup is incomplete.</p>
          <button :disabled="busy" @click="resume">Finish local setup</button>
        </section>
        <div class="rail-bottom">
          <p>
            {{ count }} saved operations<br />{{ queued }} operations kept
            locally
          </p>
          <button class="text-button" @click="audit = !audit">
            {{ audit ? "Close history details" : "View history details" }}
          </button>
        </div>
      </aside>
      <main class="reading">
        <div v-if="!workflow.keyAvailable" class="notice">
          The signing key is unavailable. Your saved history is open for
          reading.
        </div>
        <section v-if="audit" class="audit">
          <h2>Local history</h2>
          <p v-if="enrollment">
            These are public operation identifiers. The Sync status panel counts
            the operations the relay has acknowledged.
          </p>
          <p v-else>
            These are public operation identifiers. No operation has a remote
            delivery acknowledgement.
          </p>
          <p>
            <strong>Device identity</strong><code>{{ state.publicKey }}</code>
          </p>
          <div v-for="profile in state.profiles" :key="profile.replica">
            <h3>
              {{
                profile.product === "Treehouse.Space"
                  ? name
                  : title(profile.replica)
              }}
            </h3>
            <p>{{ profile.frames.length }} retained operations</p>
            <ul>
              <li v-for="frame in profile.frames" :key="frame.id">
                <code>{{ frame.id }}</code
                ><span>{{
                  workflow.views
                    .get(profile.replica)
                    ?.quarantineReasons.get(frame.id)
                    ? "Refused in this view"
                    : "Applied locally"
                }}</span>
              </li>
            </ul>
          </div>
        </section>
        <template v-else-if="active && view">
          <div class="thread-heading">
            <div>
              <p class="eyebrow">Local conversation</p>
              <h2>{{ title(active.replica) }}</h2>
            </div>
            <button
              v-if="!view.state.archived"
              class="quiet"
              :disabled="!canArchive"
              @click="archive"
            >
              Archive thread</button
            ><span v-else class="archived">Archived</span>
          </div>
          <p v-if="view.state.archived" class="notice">
            This thread is archived. Posts stay available to read. A moderator
            can still hide a post.
          </p>
          <section class="posts" aria-label="Posts">
            <p v-if="!view.posts.length" class="empty-posts">
              No posts yet. There’s room for your first thought.
            </p>
            <article
              v-for="(item, index) in view.posts"
              :key="item.id"
              class="post"
            >
              <div class="post-author">
                <span class="avatar" aria-hidden="true">{{
                  authorLabel(item.author).charAt(0)
                }}</span
                ><strong>{{ authorLabel(item.author) }}</strong
                ><span>Saved on this device</span>
              </div>
              <form
                v-if="editing === item.id"
                @submit.prevent="saveEdit(item.id)"
              >
                <label :for="`edit-${index}`">Edit post</label
                ><textarea
                  :id="`edit-${index}`"
                  v-model="editText"
                  aria-label="Edit post"
                  :disabled="busy"
                  rows="4"
                />
                <div class="actions">
                  <button :disabled="!writable || !editText.trim()">
                    Save edit</button
                  ><button
                    type="button"
                    class="quiet"
                    :disabled="busy"
                    @click="editing = null"
                  >
                    Cancel
                  </button>
                </div>
              </form>
              <template v-else
                ><p class="post-text">{{ item.text }}</p>
                <div class="post-actions">
                  <button
                    v-if="
                      !view.state.archived && item.author === state.publicKey
                    "
                    class="text-button"
                    :aria-label="`Edit post ${index + 1}`"
                    :disabled="!canEditOwn"
                    @click="
                      editing = item.id;
                      editText = String(item.text);
                    "
                  >
                    Edit</button
                  ><button
                    v-if="
                      !view.state.archived && item.author === state.publicKey
                    "
                    class="text-button"
                    :aria-label="`Hide post ${index + 1}`"
                    :disabled="!canHideOwn"
                    @click="hide(item.id)"
                  >
                    Hide</button
                  ><button
                    class="text-button"
                    :aria-label="`Hide post ${index + 1} as moderator`"
                    :disabled="!canHideAsModerator"
                    @click="hide(item.id, true)"
                  >
                    Hide as moderator
                  </button>
                </div></template
              >
            </article>
          </section>
          <form class="composer" @submit.prevent="post">
            <label for="draft">{{
              view.state.archived ? "Saved draft" : "Write a post"
            }}</label
            ><textarea
              id="draft"
              v-model="draftText"
              :aria-label="view.state.archived ? 'Saved draft' : 'Write a post'"
              :disabled="
                busy || !workflow.keyAvailable || Boolean(view.state.archived)
              "
              rows="4"
              placeholder="Leave a thought for your group…"
              @input="draftChanged"
              @blur="
                flushDraft().catch((cause) => {
                  error = describe(cause);
                })
              "
            />
            <div class="composer-footer">
              <span role="status">{{
                draftSaved
                  ? "Saved on this device"
                  : draftFailed
                    ? "Draft is not saved"
                    : "Saving draft…"
              }}</span
              ><button
                v-if="!view.state.archived"
                type="submit"
                :disabled="!canPost || !draftText.trim()"
              >
                Post
              </button>
            </div>
          </form>
        </template>
        <section v-else class="thread-empty">
          <p class="eyebrow">An open page</p>
          <h2>Start a conversation.</h2>
          <p>
            Create a thread for a question, a plan, or something worth
            remembering.
          </p>
        </section>
      </main>
    </div>
    <component
      :is="EnrollmentPanel"
      v-if="EnrollmentPanel && ready"
      :workflow="workflow"
      :state="state"
      :busy="busy"
      :run="run"
      :describe="describe"
      :refresh="refreshFromSync"
    />
    <WitnessSetup />
  </div>
</template>
