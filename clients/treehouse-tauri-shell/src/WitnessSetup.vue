<script setup lang="ts">
import {computed, onBeforeUnmount, ref, shallowRef} from "vue";
import {WitnessAdapter, type PendingWitness, type WitnessResult} from "./witness_adapter";

const enabled = ref(false), busy = ref(false), cancelling = ref(false);
const replica = ref(""), enrollmentId = ref(""), recipient = ref("");
const generationRequest = ref(""), proofRequest = ref("");
const pending = shallowRef<PendingWitness | null>(null);
const result = shallowRef<WitnessResult | null>(null);
const message = ref(""), error = ref("");
let adapter: WitnessAdapter | null = null;
let generation = 0;
const exportable = computed(() => result.value !== null && "identity" in result.value);
const completed = computed(() => result.value !== null && "identity" in result.value && result.value.identity.phase === "generated_unvalidated");
const description = (reason: unknown): string => {
  const code = reason instanceof Error ? reason.message : "";
  const messages: Record<string, string> = {
    invalid_witness_request: "Check the public request values and try again.",
    invalid_witness_result: "The device returned a result that could not be verified. Nothing is ready to export from this action.",
    invalid_witness_pending_event: "The pending request could not be tracked safely. Use the device dialog to close it.",
    witness_pending_unavailable: "The device has not supplied a cancellation reference. Use the device dialog to cancel, or wait for it to close.",
    unsupported_platform: "Witness setup is not available on this platform.",
    invalid_witness_session: "Close and reopen the app before trying witness setup again.",
    storage_busy: "Another device action is still finishing. Wait before trying again.",
    witness_busy: "Finish or cancel the current action first.",
    witness_stopped: "Witness setup is closed.",
    stale_witness_operation: "That action has already finished or closed.",
  };
  return messages[code] ?? "The device could not complete this action. No witness eligibility has been granted.";
};
function setEnabled(value: boolean) {
  generation++;
  adapter?.stop(); adapter = null;
  enabled.value = value; busy.value = false; cancelling.value = false; pending.value = null; result.value = null; error.value = ""; message.value = "";
  if (value) {
    const current = generation;
    adapter = new WitnessAdapter(undefined, value => {if (current === generation) pending.value = value;});
  }
}
async function run(action: (bridge: WitnessAdapter) => Promise<WitnessResult>) {
  const bridge = adapter;
  if (!bridge || busy.value) return;
  busy.value = true; error.value = ""; message.value = "";
  try {
    const response = await action(bridge);
    if (adapter !== bridge) return;
    result.value = response;
    message.value = response.status === "missing" ? "No witness identity is saved on this device." :
      response.status === "incomplete" ? "Setup is saved but the witness identity is not complete." :
      response.status === "prepared" ? "Creation is prepared. Send the public result to your validator for a generation request." :
      response.status === "generated_unvalidated" ? "The key was created. It still needs independent validation." :
      response.status === "signed" ? "A signed public proof is ready to send to your validator." :
      response.status === "cancelled" ? "The action was cancelled." : "The saved public identity is available.";
  } catch (reason) {if (adapter === bridge) error.value = description(reason);}
  finally {if (adapter === bridge) busy.value = false;}
}
function parsed(text: string): unknown {
  try {if (new TextEncoder().encode(text).length > 131072) throw new Error(); return JSON.parse(text);} catch {throw new Error("invalid_witness_request");}
}
async function importRequest(event: Event, kind: "generation" | "proof") {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const current = generation;
  try {
    if (file.size > 131072) throw new Error("invalid_witness_request");
    const text = await file.text();
    parsed(text);
    if (current !== generation) return;
    if (kind === "generation") generationRequest.value = text; else proofRequest.value = text;
    error.value = ""; message.value = "Public request loaded. Continue when you are ready.";
  } catch (reason) {if (current === generation) error.value = description(reason);}
}
async function cancel() {
  const bridge = adapter;
  if (!bridge || cancelling.value) return;
  cancelling.value = true;
  try {
    const response = await bridge.cancel();
    if (adapter === bridge) message.value = response.status === "cancelled" ? "Cancellation recorded by the device." : "That pending action is no longer present.";
  } catch (reason) {if (adapter === bridge) error.value = description(reason);}
  finally {if (adapter === bridge) cancelling.value = false;}
}
function exportResult() {
  if (!exportable.value || !result.value) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(result.value, null, 2)], {type: "application/json"}));
  const link = document.createElement("a");
  link.href = url; link.download = "treehouse-witness-public.json"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
onBeforeUnmount(() => {generation++; adapter?.stop(); adapter = null;});
</script>

<template>
  <section class="witness-setup" aria-labelledby="witness-heading">
    <h2 id="witness-heading">Witness setup</h2>
    <p>A witness key can provide a public proof for independent validation. Setup does not make this device eligible to act as a witness.</p>
    <label class="witness-opt-in">
      <input type="checkbox" :checked="enabled" @change="setEnabled(($event.target as HTMLInputElement).checked)" />
      Open witness setup on this device
    </label>
    <div v-if="enabled">
      <div class="actions">
        <button :disabled="busy" @click="run(bridge => bridge.publicIdentity())">Read saved identity</button>
        <button v-if="busy" :disabled="!pending || cancelling" @click="cancel">Cancel device action</button>
      </div>
      <p v-if="busy" role="status">{{ pending?.phase === "presence" ? "Complete or cancel the device presence check." : pending?.phase === "review" ? "Review the request in the device dialog." : "Waiting for the device. Cancellation becomes available when it supplies a pending reference." }}</p>
      <form @submit.prevent="run(bridge => bridge.prepareCreation({replica, enrollmentId, recipient}))">
        <h3>Prepare an enrollment</h3>
        <p>Use the public enrollment values supplied for your group.</p>
        <label for="witness-replica">Group reference</label><input id="witness-replica" v-model="replica" :disabled="busy" autocomplete="off" />
        <label for="witness-enrollment">Enrollment code</label><input id="witness-enrollment" v-model="enrollmentId" :disabled="busy" autocomplete="off" />
        <label for="witness-recipient">Member public key</label><input id="witness-recipient" v-model="recipient" :disabled="busy" autocomplete="off" />
        <button :disabled="busy">Prepare creation</button>
      </form>
      <form @submit.prevent="run(bridge => bridge.generate(parsed(generationRequest) as Parameters<WitnessAdapter['generate']>[0]))">
        <h3>Import a generation request</h3>
        <p>Paste the validator’s public request with the saved creation reference and generation challenge. The device controls key creation.</p>
        <label for="witness-generation-file">Generation request file</label><input id="witness-generation-file" type="file" accept="application/json,.json" :disabled="busy" @change="importRequest($event, 'generation')" />
        <details><summary>Paste a request instead</summary><label for="witness-generation">Generation request text</label><textarea id="witness-generation" v-model="generationRequest" :disabled="busy" rows="4" spellcheck="false" /></details>
        <button :disabled="busy || !generationRequest">Generate witness key</button>
      </form>
      <form @submit.prevent="run(bridge => bridge.proveBinding(parsed(proofRequest) as Parameters<WitnessAdapter['proveBinding']>[0]))">
        <h3>Import a proof request</h3>
        <p>Paste a fresh public request from your validator. Review and presence approval happen in the device dialog.</p>
        <label for="witness-proof-file">Proof request file</label><input id="witness-proof-file" type="file" accept="application/json,.json" :disabled="busy" @change="importRequest($event, 'proof')" />
        <details><summary>Paste a request instead</summary><label for="witness-proof">Proof request text</label><textarea id="witness-proof" v-model="proofRequest" :disabled="busy" rows="4" spellcheck="false" /></details>
        <button :disabled="busy || !proofRequest">Prove witness key</button>
      </form>
      <p v-if="message" role="status">{{ message }}</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div v-if="exportable" class="witness-export">
        <h3>{{ result?.status === "signed" ? "Public identity and proof" : completed ? "Public identity" : "Incomplete public setup record" }}</h3>
        <p>Send this public result to your validator. Exporting it does not approve witness eligibility.</p>
        <button :disabled="busy" @click="exportResult">Export public result</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.witness-setup {max-width: 780px; padding: 28px; border: 1px solid #a5b0a6; border-radius: 10px; background: #fff;}
.witness-opt-in {display: flex; align-items: center; gap: 10px; margin-bottom: 24px;}
.witness-opt-in input {width: auto; margin: 0;}
form, .witness-export {margin-top: 28px; padding-top: 22px; border-top: 1px solid #d6ddd5;}
textarea {font-family: ui-monospace, monospace; font-size: 13px;}
</style>
