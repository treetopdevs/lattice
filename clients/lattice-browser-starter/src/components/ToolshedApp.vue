<script setup lang="ts">
import { computed, ref } from "vue";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import type { DemoIdentity } from "../lib/custody";
import type { DemoEndpoint } from "../lib/browser_host";
import {
  authorToolshedBeacon,
  authorToolshedBorrowGrant,
  authorToolshedRequest,
  authorToolshedShedCommand,
  authorToolshedToolCommand,
  frontierIds,
  observeToolshedShed,
  observeToolshedTool,
  pickCapabilityForCommand,
  pickRootDelegationId,
  signToolshedCustodyConsent,
} from "../lib/products";

const props = defineProps<{
  shedEndpoint: DemoEndpoint | null;
  toolEndpoint: DemoEndpoint | null;
  shedFrames: CarrierOpFrame[];
  toolFrames: CarrierOpFrame[];
  identity: DemoIdentity | null;
  realmByPubkey: Record<string, string>;
  onAppendFrame: (replica: string, frame: CarrierOpFrame) => Promise<void>;
}>();

const newNeighbor = ref("");
const newToolReplica = ref("");
const bulletinText = ref("");
const conditionNote = ref("");
const dueEpoch = ref(4);
const consentInput = ref("");
const signedConsentPreview = ref<{ requestOpId: string; signature: string } | null>(null);
const status = ref("");
const error = ref("");
const busy = ref(false);

const shedView = computed(() =>
  props.shedFrames.length > 0 ? observeToolshedShed(props.shedFrames, props.realmByPubkey) : null,
);

const toolView = computed(() =>
  props.toolFrames.length > 0 ? observeToolshedTool(props.toolFrames, props.realmByPubkey) : null,
);

const shedCap = (cmd: string) =>
  props.identity
    ? pickCapabilityForCommand(
        "Toolshed.Shed",
        props.shedFrames,
        props.identity.publicKeyBase64,
        cmd,
        props.realmByPubkey,
      )
    : null;

const toolCap = (cmd: string) =>
  props.identity
    ? pickCapabilityForCommand(
        "Toolshed.Tool",
        props.toolFrames,
        props.identity.publicKeyBase64,
        cmd,
        props.realmByPubkey,
      )
    : null;

const isCustodyHomeHolder = computed(
  () =>
    props.identity !== null &&
    toolView.value?.custody.homeHolderPubkey === props.identity.publicKeyBase64,
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

async function vouchNeighbor() {
  const neighbor = newNeighbor.value.trim();
  if (!neighbor || !props.identity || !props.shedEndpoint) return;
  await run(`Vouched in neighbor "${neighbor}".`, async () => {
    const frame = await authorToolshedShedCommand({
      replica: props.shedEndpoint!.replica,
      deps: frontierIds(props.shedFrames),
      signer: props.identity!.signer,
      capId: shedCap("vouch_in"),
      command: { command: "vouch_in", neighbor },
    });
    newNeighbor.value = "";
    await props.onAppendFrame(props.shedEndpoint!.replica, frame);
  });
}

async function listTool() {
  const toolReplica = newToolReplica.value.trim();
  if (!toolReplica || !props.identity || !props.shedEndpoint) return;
  await run(`Listed tool "${toolReplica}" in shed inventory.`, async () => {
    const frame = await authorToolshedShedCommand({
      replica: props.shedEndpoint!.replica,
      deps: frontierIds(props.shedFrames),
      signer: props.identity!.signer,
      capId: shedCap("list_tool"),
      command: { command: "list_tool", toolReplica },
    });
    newToolReplica.value = "";
    await props.onAppendFrame(props.shedEndpoint!.replica, frame);
  });
}

async function postBulletin(unauthorized: boolean) {
  const text = unauthorized ? "Unauthorized steward notice" : bulletinText.value.trim();
  if (!text || !props.identity || !props.shedEndpoint) return;
  await run(
    unauthorized
      ? "Authored unauthorized steward bulletin (check Quarantine Inspector)."
      : "Posted steward bulletin.",
    async () => {
      const frame = await authorToolshedShedCommand({
        replica: props.shedEndpoint!.replica,
        deps: frontierIds(props.shedFrames),
        signer: props.identity!.signer,
        capId: unauthorized ? null : shedCap("post_bulletin"),
        command: { command: "post_bulletin", text },
      });
      if (!unauthorized) bulletinText.value = "";
      await props.onAppendFrame(props.shedEndpoint!.replica, frame);
    },
  );
}

async function addConditionNote() {
  const text = conditionNote.value.trim();
  if (!text || !props.identity || !props.toolEndpoint) return;
  await run("Signed and queued tool condition note.", async () => {
    const frame = await authorToolshedToolCommand({
      replica: props.toolEndpoint!.replica,
      deps: frontierIds(props.toolFrames),
      signer: props.identity!.signer,
      capId: toolCap("note_condition"),
      command: { command: "note_condition", text },
    });
    conditionNote.value = "";
    await props.onAppendFrame(props.toolEndpoint!.replica, frame);
  });
}

async function requestCustody(kind: "borrow" | "return") {
  if (!props.identity || !props.toolEndpoint) return;
  await run(`Appended durable :inbox ${kind} request (Q-06).`, async () => {
    const frame = await authorToolshedRequest({
      replica: props.toolEndpoint!.replica,
      deps: frontierIds(props.toolFrames),
      signer: props.identity!.signer,
      requestKind: kind,
    });
    await props.onAppendFrame(props.toolEndpoint!.replica, frame);
  });
}

async function signRecipientConsent(requestOpId: string) {
  if (!props.identity || !props.toolEndpoint || !toolView.value?.custody.homeHolderPubkey) return;
  await run("Signed ADR 0007 recipient consent bytes (share with custody holder).", async () => {
    const signature = await signToolshedCustodyConsent({
      replica: props.toolEndpoint!.replica,
      requestOpId,
      fromPubkeyBase64: toolView.value!.custody.homeHolderPubkey!,
      recipientSigner: props.identity!.signer,
    });
    signedConsentPreview.value = { requestOpId, signature };
    consentInput.value = signature;
  });
}

async function completeBorrowTransfer(requestOpId: string, borrowerPubkey: string, unconsented: boolean) {
  if (!props.identity || !props.toolEndpoint) return;
  const sig = unconsented ? null : consentInput.value.trim();
  if (!unconsented && !sig) {
    error.value = "Paste the borrower's ADR 0007 consent signature first.";
    return;
  }
  await run(
    unconsented
      ? "Authored unconsented custody_transfer (check ADR 0007 missing_consent quarantine)."
      : `Completed dual-signed handoff with leased borrow cap (due epoch ${dueEpoch.value}).`,
    async () => {
      const transferFrame = await authorToolshedToolCommand({
        replica: props.toolEndpoint!.replica,
        deps: frontierIds(props.toolFrames),
        signer: props.identity!.signer,
        capId: toolCap("custody_transfer"),
        command: {
          command: "custody_transfer",
          toPubkeyBase64: borrowerPubkey,
          requestOpId,
          consentSigBase64: sig,
        },
      });
      await props.onAppendFrame(props.toolEndpoint!.replica, transferFrame);

      if (!unconsented) {
        const rootCapId = pickRootDelegationId(props.toolFrames, props.identity!.publicKeyBase64);
        if (rootCapId) {
          const leaseFrame = await authorToolshedBorrowGrant({
            replica: props.toolEndpoint!.replica,
            deps: [transferFrame.id],
            parentDelegationId: rootCapId,
            borrowerPubkeyBase64: borrowerPubkey,
            expiresEpoch: dueEpoch.value,
            signer: props.identity!.signer,
          });
          await props.onAppendFrame(props.toolEndpoint!.replica, leaseFrame);
        }
        consentInput.value = "";
      }
    },
  );
}

async function resolveReturnTransfer(requestOpId: string) {
  if (!props.identity || !props.toolEndpoint) return;
  await run("Resolved return with reverse dual-signed custody_transfer (tool is home).", async () => {
    const returnConsent = await signToolshedCustodyConsent({
      replica: props.toolEndpoint!.replica,
      requestOpId,
      fromPubkeyBase64: props.identity!.publicKeyBase64,
      recipientSigner: props.identity!.signer,
    });
    const frame = await authorToolshedToolCommand({
      replica: props.toolEndpoint!.replica,
      deps: frontierIds(props.toolFrames),
      signer: props.identity!.signer,
      capId: toolCap("custody_transfer"),
      command: {
        command: "custody_transfer",
        toPubkeyBase64: props.identity!.publicKeyBase64,
        requestOpId,
        consentSigBase64: returnConsent,
      },
    });
    await props.onAppendFrame(props.toolEndpoint!.replica, frame);
  });
}

async function advanceBeaconEpoch() {
  if (!props.identity || !props.toolEndpoint) return;
  const nextEpoch = (toolView.value?.currentEpoch ?? 0) + 1;
  await run(`Published root beacon for epoch ${nextEpoch}.`, async () => {
    const frame = await authorToolshedBeacon({
      replica: props.toolEndpoint!.replica,
      deps: frontierIds(props.toolFrames),
      epoch: nextEpoch,
      signer: props.identity!.signer,
    });
    await props.onAppendFrame(props.toolEndpoint!.replica, frame);
  });
}
</script>

<template>
  <div class="grid-2" data-testid="toolshed-app">
    <section class="card">
      <h2>
        <span>Toolshed: {{ shedView?.name || "Loading…" }}</span>
        <span class="pill ok">steward: {{ shedView?.stewardHolder ?? "—" }}</span>
      </h2>
      <div v-if="shedEndpoint" class="mono muted">{{ shedEndpoint.replica }}</div>

      <template v-if="shedView">
        <div class="item">
          <div class="item-head"><span>Steward Bulletin</span></div>
          <div>{{ shedView.bulletin || "No bulletin posted yet." }}</div>
        </div>

        <div class="item">
          <div class="item-head">
            <span>Vouched Neighbors</span>
            <span>{{ shedView.neighbors.length }}</span>
          </div>
          <div class="row">
            <span v-for="n in shedView.neighbors" :key="n" class="pill ok">{{ n }}</span>
          </div>
        </div>

        <div class="item">
          <div class="item-head">
            <span>Tool Inventory</span>
            <span>{{ shedView.inventory.length }}</span>
          </div>
          <div v-for="inv in shedView.inventory" :key="inv" class="mono">{{ inv }}</div>
        </div>

        <div class="row">
          <input v-model="newNeighbor" class="grow" placeholder="Neighbor realm to vouch in…" />
          <button
            :disabled="busy || !shedCap('vouch_in') || !newNeighbor.trim()"
            @click="vouchNeighbor"
          >
            Vouch In
          </button>
        </div>

        <div class="row">
          <input v-model="newToolReplica" class="grow" placeholder="replica:tool:…" />
          <button
            :disabled="busy || !shedCap('list_tool') || !newToolReplica.trim()"
            @click="listTool"
          >
            List Tool
          </button>
        </div>

        <div class="row">
          <input v-model="bulletinText" class="grow" placeholder="Steward bulletin message…" />
          <button
            class="primary"
            :disabled="busy || !shedCap('post_bulletin') || !bulletinText.trim()"
            @click="postBulletin(false)"
          >
            Post Bulletin
          </button>
        </div>

        <div class="row">
          <button
            class="danger"
            data-testid="toolshed-unauth-bulletin-btn"
            :disabled="busy || !identity"
            @click="postBulletin(true)"
          >
            Test Unauthorized Bulletin (Quarantine)
          </button>
        </div>
      </template>
    </section>

    <section class="card">
      <h2>
        <span>Tool Custody (ADR 0007)</span>
        <span
          class="pill"
          :class="toolView?.custody.available ? 'ok' : toolView?.loan?.overdue ? 'danger' : 'warn'"
        >
          {{
            toolView?.custody.available
              ? "Available (Home)"
              : toolView?.loan?.overdue
                ? "OUT — OVERDUE"
                : "Checked Out"
          }}
        </span>
      </h2>
      <div v-if="toolEndpoint" class="mono muted">{{ toolEndpoint.replica }}</div>

      <div v-if="error" class="error-box">{{ error }}</div>
      <div v-if="status" class="notice-box">{{ status }}</div>

      <template v-if="toolView">
        <div class="item">
          <strong>{{ toolView.listing.description }}</strong>
          <div class="row" style="margin-top: 4px">
            <span class="pill">home custody: {{ toolView.custody.homeHolder ?? "—" }}</span>
            <span class="pill">current holder: {{ toolView.custody.holder ?? toolView.custody.homeHolder ?? "—" }}</span>
            <span class="pill">beacon epoch: {{ toolView.currentEpoch ?? 0 }}</span>
          </div>
          <div v-if="toolView.loan" class="row" style="margin-top: 4px">
            <span class="pill warn">borrower: {{ toolView.loan.borrower }}</span>
            <span class="pill" :class="toolView.loan.overdue ? 'danger' : 'warn'">
              due epoch: {{ toolView.loan.dueEpoch ?? "unleased" }}
              {{ toolView.loan.overdue ? "(OVERDUE)" : "" }}
            </span>
          </div>
        </div>

        <div class="item">
          <div class="item-head"><span>Condition Notes</span><span>{{ toolView.listing.conditionNotes.length }}</span></div>
          <div v-for="(note, idx) in toolView.listing.conditionNotes" :key="idx">• {{ note }}</div>
          <div class="row" style="margin-top: 6px">
            <input
              v-model="conditionNote"
              class="grow"
              data-testid="toolshed-note-input"
              placeholder="Add tool condition note…"
              @keyup.enter="addConditionNote"
            />
            <button
              data-testid="toolshed-note-submit"
              :disabled="busy || !toolCap('note_condition') || !conditionNote.trim()"
              @click="addConditionNote"
            >
              Add Note
            </button>
          </div>
        </div>

        <div class="row">
          <button
            class="primary"
            data-testid="toolshed-request-borrow-btn"
            :disabled="busy || !identity"
            @click="requestCustody('borrow')"
          >
            Request Borrow (:inbox)
          </button>
          <button
            data-testid="toolshed-request-return-btn"
            :disabled="busy || !identity"
            @click="requestCustody('return')"
          >
            Request Return (:inbox)
          </button>
          <button
            v-if="isCustodyHomeHolder"
            data-testid="toolshed-beacon-btn"
            :disabled="busy"
            @click="advanceBeaconEpoch"
          >
            Advance Beacon Epoch (+1)
          </button>
        </div>

        <div v-if="signedConsentPreview" class="notice-box">
          <strong>Recipient Consent Signature</strong> (for request
          <code>{{ signedConsentPreview.requestOpId.slice(0, 10) }}…</code>):
          <div class="mono" style="word-break: break-all; margin-top: 4px" data-testid="toolshed-consent-sig">
            {{ signedConsentPreview.signature }}
          </div>
        </div>

        <div class="list" data-testid="toolshed-requests">
          <div class="muted" style="font-size: 12px">
            Durable Requests Ledger (Q-06 Dispute Surface)
          </div>
          <div v-if="toolView.requests.length === 0" class="muted" style="font-size: 12.5px">
            No borrow/return requests yet. Switch to <code>neighbor</code> and click Request Borrow.
          </div>
          <div v-for="req in toolView.requests" :key="req.opId" class="item">
            <div class="item-head">
              <strong>{{ req.requestKind.toUpperCase() }} by {{ req.authorLabel }}</strong>
              <span class="pill" :class="req.resolved ? 'ok' : 'warn'">
                {{ req.resolved ? "resolved" : "pending" }}
              </span>
            </div>
            <div class="mono muted">request op: {{ req.opId.slice(0, 14) }}…</div>

            <div v-if="!req.resolved" class="row" style="margin-top: 6px">
              <button
                v-if="req.requestKind === 'borrow' && identity?.publicKeyBase64 === req.authorPubkey"
                class="ok"
                data-testid="toolshed-sign-consent-btn"
                :disabled="busy"
                @click="signRecipientConsent(req.opId)"
              >
                Sign Borrow Consent (Recipient)
              </button>

              <template v-if="req.requestKind === 'borrow' && isCustodyHomeHolder">
                <input
                  v-model="consentInput"
                  class="grow"
                  data-testid="toolshed-consent-input"
                  placeholder="Paste borrower's base64 consent sig…"
                />
                <input
                  v-model.number="dueEpoch"
                  type="number"
                  min="1"
                  style="width: 84px"
                  title="Due-back epoch lease"
                />
                <button
                  class="primary"
                  data-testid="toolshed-complete-handoff-btn"
                  :disabled="busy"
                  @click="completeBorrowTransfer(req.opId, req.authorPubkey, false)"
                >
                  Complete Dual-Signed Handoff
                </button>
                <button
                  class="danger"
                  data-testid="toolshed-unconsented-btn"
                  :disabled="busy"
                  @click="completeBorrowTransfer(req.opId, req.authorPubkey, true)"
                >
                  Test Unconsented (Quarantine)
                </button>
              </template>

              <button
                v-if="req.requestKind === 'return' && isCustodyHomeHolder"
                class="ok"
                data-testid="toolshed-resolve-return-btn"
                :disabled="busy"
                @click="resolveReturnTransfer(req.opId)"
              >
                Resolve Return (Tool Home)
              </button>
            </div>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>
