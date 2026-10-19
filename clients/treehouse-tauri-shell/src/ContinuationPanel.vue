<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type {
  BindingReview,
  ContinuationReview,
  TreehouseWorkflow,
} from "./treehouse_workflow";
import { DEFAULT_MAX_LEASE_EPOCHS } from "./treehouse_workflow";
import type { PreviewState } from "./treehouse_state";
import { isExportFileName, suggestExportFileName } from "./space_export";

// Row 232. Two root-only actions for a bounded-family Space: pin a continuation (an empty-delegation
// genesis carrying the nominee, witnesses, threshold and lease bound), then sign the catalog binding a
// ceremony produced. Each is a review step followed by a separate explicit confirmation. Nothing here
// touches the network: the signed frames are queued locally like every other operation. "Pinned" means the
// continuation is recorded in the Space's history, nothing more.
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

const messages: Record<string, string> = {
  invalid_public_key:
    "A public key is not a valid base64 key. Paste one 32-byte key per line.",
  invalid_continuation_profile:
    "Those continuation settings are not valid. Check the witnesses, the threshold and the lease bound.",
  nominee_is_root: "The nominee must be someone other than you.",
  witness_is_root: "You cannot be one of your own witnesses.",
  witness_is_nominee: "The nominee cannot also be a witness.",
  continuation_already_pinned: "A continuation is pinned for this Space.",
  not_root: "Only the root of this Space can do that.",
  not_bounded_space:
    "This Space was created before bounded continuation; it cannot carry a catalog binding. Create a new Space.",
  malformed_payload:
    "That text is not a catalog binding payload. Nothing was changed.",
  payload_digest_mismatch:
    "The payload's digest does not match its record. Nothing was changed.",
  wrong_space: "That binding names a different Space. Nothing was changed.",
  continuation_not_configured:
    "Pin a continuation for this Space before signing a catalog binding.",
  binding_mismatch:
    "That binding does not match this Space's pinned continuation. Nothing was changed.",
  catalog_bootstrap_exists:
    "This Space already carries a catalog binding; this app signs only one.",
  no_pending_binding: "Review a binding payload first.",
  no_pending_continuation: "Review the continuation settings first.",
  continuation_review_mismatch:
    "Those settings are not the ones that were reviewed. Review them again.",
  binding_key_reuse:
    "The catalog or service key in that binding is the Space root's own key. Nothing was changed.",
  creation_incomplete: "Finish the pending local setup first.",
  space_unavailable: "No Space is saved on this device.",
  invalid_export_name:
    "Use a plain file name ending in .json, with letters, digits, dots, dashes or underscores.",
  export_empty: "This Space has no history to export.",
  continuation_not_pinned: "Pin the continuation first; the ceremony needs the pinned history.",
  export_too_large: "This Space's history is too large to export.",
  export_wrong_replica: "A saved operation belongs to a different Space. Nothing was written.",
  export_duplicate_frame: "A saved operation appears twice. Nothing was written.",
  export_invalid_frame: "A saved operation failed verification. Nothing was written.",
  export_exists: "A file with that name already exists in Downloads. Choose another name.",
  export_unavailable: "Exporting a file is not available on this device.",
  identity_unavailable:
    "The signing key is unavailable. Saved history is open for reading.",
};
const explain = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return messages[message] ?? props.describe(cause);
};

// One continuation snapshot per saved state; the bare props.state read is the reactivity hook.
const facts = computed(() => {
  props.state;
  return props.workflow.continuation();
});
const signing = computed(
  () => props.state.publicKey !== null && props.workflow.keyAvailable,
);
const members = facts.value.members;
const nominee = ref(members[0] ?? ""),
  witnesses = ref(members.slice(1).join("\n")),
  threshold = ref<number | string>(""),
  maxLeaseEpochs = ref<number | string>(DEFAULT_MAX_LEASE_EPOCHS);
const continuationReview = ref<ContinuationReview | null>(null);
// Admitted members usually arrive after the panel mounts (enrollment or relay sync): refresh the
// prefill while the root has not edited it.
let prefill = { nominee: nominee.value, witnesses: witnesses.value };
watch(
  () => facts.value.members.join("\n"),
  () => {
    const next = facts.value.members;
    const fresh = { nominee: next[0] ?? "", witnesses: next.slice(1).join("\n") };
    if (nominee.value === prefill.nominee) nominee.value = fresh.nominee;
    if (witnesses.value === prefill.witnesses) witnesses.value = fresh.witnesses;
    prefill = fresh;
  },
);
const spaceReplica = () =>
  props.state.profiles.find((p) => p.product === "Treehouse.Space")?.replica ?? "";
const exportName = ref(suggestExportFileName(spaceReplica()));
const exportedPath = ref("");
const staleExport = ref("");
// Any saved-state change clears the workflow's pending review, so drop the shown confirmation too.
watch(
  () => props.state,
  () => {
    continuationReview.value = null;
    // The history changed (for example the binding was signed): an earlier export no longer matches it.
    if (exportedPath.value) staleExport.value = exportedPath.value;
    exportedPath.value = "";
  },
);
async function exportFrames() {
  exportedPath.value = "";
  staleExport.value = "";
  note.value = "";
  await props.run(async () => {
    exportedPath.value = await props.workflow.exportSpaceFrames(exportName.value.trim());
  }, explain);
}
const payloadText = ref("");
const bindingReview = ref<BindingReview | null>(null);
const note = ref("");

async function reviewContinuation() {
  continuationReview.value = null;
  note.value = "";
  await props.run(async () => {
    continuationReview.value = props.workflow.reviewContinuation({
      nominee: nominee.value,
      witnesses: witnesses.value,
      threshold: typeof threshold.value === "number" ? threshold.value : undefined,
      maxLeaseEpochs: typeof maxLeaseEpochs.value === "number" ? maxLeaseEpochs.value : Number.NaN,
    });
  }, explain);
}
async function pinContinuation() {
  const review = continuationReview.value;
  if (!review) return;
  await props.run(async () => {
    await props.workflow.pinContinuation(review);
    continuationReview.value = null;
    note.value =
      "Continuation pinned. The operation is saved on this device and is not delivered yet.";
  }, explain);
}
function cancelContinuation() {
  continuationReview.value = null;
}
async function reviewBinding() {
  bindingReview.value = null;
  note.value = "";
  await props.run(async () => {
    bindingReview.value = await props.workflow.reviewCatalogBinding(
      payloadText.value.trim(),
    );
  }, explain);
}
async function signBinding() {
  await props.run(async () => {
    try {
      await props.workflow.signCatalogBinding();
    } finally {
      // Success or refusal, the workflow has dropped its pending binding; a stale Sign button must not stay.
      if (!props.workflow.hasPendingBinding()) bindingReview.value = null;
    }
    payloadText.value = "";
    note.value =
      "Catalog binding signed. The operation is saved on this device and is not delivered yet.";
  }, explain);
}
function cancelBinding() {
  props.workflow.cancelCatalogBinding();
  bindingReview.value = null;
}
</script>
<template>
  <section
    v-if="facts.family === 'legacy'"
    class="notice"
    aria-label="Continuation unavailable"
  >
    <p>
      This Space was created before bounded continuation; it cannot carry a
      catalog binding. Create a new Space.
    </p>
  </section>
  <section
    v-else-if="facts.family === 'bounded' && facts.isRoot"
    class="enrollment"
    aria-label="Continuation and catalog binding"
  >
    <h2>Continuation</h2>
    <div v-if="!facts.pinned" class="enroll-step">
      <h3>Pin a continuation</h3>
      <p class="fine">
        Name the person who may take over as root, and the witnesses who must
        confirm it. Public keys only, one per line.
      </p>
      <label for="continuation-nominee">Nominee public key</label>
      <input
        id="continuation-nominee"
        v-model="nominee"
        aria-label="Nominee public key"
        :disabled="busy"
      />
      <label for="continuation-witnesses">Witness public keys</label>
      <textarea
        id="continuation-witnesses"
        v-model="witnesses"
        aria-label="Witness public keys"
        rows="3"
        :disabled="busy"
      />
      <label for="continuation-threshold"
        >Threshold (default: a majority of the witnesses)</label
      >
      <input
        id="continuation-threshold"
        v-model.number="threshold"
        aria-label="Threshold"
        type="number"
        min="1"
        :disabled="busy"
      />
      <label for="continuation-lease">Maximum lease epochs</label>
      <input
        id="continuation-lease"
        v-model.number="maxLeaseEpochs"
        aria-label="Maximum lease epochs"
        type="number"
        min="1"
        max="65535"
        :disabled="busy"
      />
      <button
        type="button"
        class="secondary"
        aria-label="Review continuation"
        :disabled="busy || !signing || !nominee.trim() || !witnesses.trim()"
        @click="reviewContinuation"
      >
        Review continuation
      </button>
      <section
        v-if="continuationReview"
        class="notice"
        aria-label="Continuation review"
      >
        <h3>Review this continuation</h3>
        <p>
          Nominee <code>{{ continuationReview.nominee }}</code>
        </p>
        <ul>
          <li v-for="key in continuationReview.witnesses" :key="key">
            Witness <code>{{ key }}</code>
          </li>
        </ul>
        <p>
          {{ continuationReview.threshold }} of
          {{ continuationReview.witnesses.length }} witnesses must confirm.
          Leases last at most {{ continuationReview.maxLeaseEpochs }} epochs.
        </p>
        <div class="actions">
          <button
            type="button"
            aria-label="Pin continuation"
            :disabled="busy || !signing"
            @click="pinContinuation"
          >
            Pin continuation
          </button>
          <button
            type="button"
            class="quiet"
            aria-label="Cancel continuation"
            :disabled="busy"
            @click="cancelContinuation"
          >
            Cancel
          </button>
        </div>
      </section>
    </div>
    <p v-else role="status">Continuation pinned.</p>

    <h2>Catalog binding</h2>
    <p v-if="facts.bound" role="status">Catalog binding signed.</p>
    <p v-else-if="!facts.pinned" class="muted">
      Pin a continuation first. The catalog binding is signed against it.
    </p>
    <div v-else class="enroll-step">
      <h3>Sign a catalog binding</h3>
      <label for="binding-payload">Paste binding payload</label>
      <textarea
        id="binding-payload"
        v-model="payloadText"
        aria-label="Paste binding payload"
        rows="4"
        :disabled="busy"
      />
      <button
        type="button"
        class="secondary"
        aria-label="Review binding"
        :disabled="busy || !signing || !payloadText.trim()"
        @click="reviewBinding"
      >
        Review binding
      </button>
      <section v-if="bindingReview" class="notice" aria-label="Binding review">
        <h3>Review this binding</h3>
        <ul>
          <li v-for="line in bindingReview.lines" :key="line.field">
            {{ line.field }}: <code>{{ line.value }}</code>
          </li>
        </ul>
        <p>
          Compare the canonical sha256 above with the one in the ceremony's
          binding-review.txt before signing. This app signs one binding per Space.
        </p>
        <div class="actions">
          <button
            type="button"
            aria-label="Sign binding"
            :disabled="busy || !signing"
            @click="signBinding"
          >
            Sign binding
          </button>
          <button
            type="button"
            class="quiet"
            aria-label="Cancel binding"
            :disabled="busy"
            @click="cancelBinding"
          >
            Cancel
          </button>
        </div>
      </section>
    </div>
    <p v-if="note" role="status" class="muted">{{ note }}</p>

    <h2>Export Space frames</h2>
    <div class="enroll-step">
      <p class="fine">
        Writes this Space's public signed operations to a new file in Downloads,
        for the catalog ceremony operator. It is not a backup and holds no keys.
      </p>
      <label for="export-name">File name</label>
      <input
        id="export-name"
        v-model="exportName"
        aria-label="Export file name"
        :disabled="busy"
      />
      <button
        type="button"
        class="secondary"
        aria-label="Export Space frames"
        :disabled="busy || !facts.pinned || !isExportFileName(exportName.trim())"
        @click="exportFrames"
      >
        Export Space frames
      </button>
      <p v-if="!facts.pinned" class="fine">Available after the continuation is pinned.</p>
      <p v-if="exportedPath" role="status" class="muted">
        Written to <code>{{ exportedPath }}</code>
      </p>
      <p v-if="staleExport" role="status" class="muted">
        This Space's history changed after <code>{{ staleExport }}</code> was written, so that file is
        out of date. Export again under a new name before the operator verifies the binding.
      </p>
    </div>
  </section>
</template>
