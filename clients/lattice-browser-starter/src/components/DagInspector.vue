<script setup lang="ts">
import { computed, ref } from "vue";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import type { DemoEndpoint } from "../lib/browser_host";
import { inspectReplicaLog } from "../lib/products";

const props = defineProps<{
  endpoints: DemoEndpoint[];
  framesByReplica: Record<string, CarrierOpFrame[]>;
  realmByPubkey: Record<string, string>;
}>();

const selectedReplica = ref<string>("");

const activeEndpoint = computed(
  () =>
    props.endpoints.find((ep) => ep.replica === selectedReplica.value) ??
    props.endpoints[0] ??
    null,
);

const inspection = computed(() => {
  const ep = activeEndpoint.value;
  if (!ep) return null;
  const frames = props.framesByReplica[ep.replica] ?? [];
  return inspectReplicaLog(ep.product, frames, props.realmByPubkey);
});
</script>

<template>
  <section class="card" data-testid="dag-inspector">
    <h2>
      <span>Live DAG, Authority &amp; Quarantine Inspector</span>
      <select
        v-if="endpoints.length > 0"
        :value="activeEndpoint?.replica"
        @change="selectedReplica = ($event.target as HTMLSelectElement).value"
      >
        <option v-for="ep in endpoints" :key="ep.replica" :value="ep.replica">
          {{ ep.product }} ({{ ep.name }})
        </option>
      </select>
    </h2>

    <template v-if="inspection">
      <div class="row">
        <span class="pill">ops: {{ inspection.opCount }}</span>
        <span class="pill ok">honored: {{ inspection.honoredCount }}</span>
        <span class="pill" :class="inspection.quarantinedCount > 0 ? 'danger' : ''">
          quarantined: {{ inspection.quarantinedCount }}
        </span>
        <span v-if="inspection.currentEpoch !== null" class="pill warn">
          beacon epoch: {{ inspection.currentEpoch }}
        </span>
        <span
          v-for="(holder, role) in inspection.holders"
          :key="role"
          class="pill ok"
        >
          {{ role }}: {{ holder }}
        </span>
      </div>

      <div v-if="inspection.delegations.length > 0">
        <div class="muted" style="margin-bottom: 6px; font-size: 12px">
          Active &amp; Historical Delegations
        </div>
        <div class="list">
          <div v-for="d in inspection.delegations" :key="d.id" class="item">
            <div class="item-head">
              <span class="mono">{{ d.id.slice(0, 12) }}…</span>
              <span>{{ d.issuer }} → {{ d.audience }}</span>
              <span v-if="d.revoked" class="pill danger">revoked</span>
              <span v-else-if="d.expiresEpoch !== null" class="pill warn">
                lease ≤ epoch {{ d.expiresEpoch }}
              </span>
              <span v-else class="pill ok">unleased</span>
            </div>
            <div class="mono muted">
              ops=[{{ d.ops.join(", ") }}] roles=[{{ d.roles.join(", ") }}]
            </div>
          </div>
        </div>
      </div>

      <div style="overflow-x: auto">
        <table>
          <thead>
            <tr>
              <th>Op ID</th>
              <th>Author</th>
              <th>Kind</th>
              <th>Command</th>
              <th>Cap</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="op in inspection.ops" :key="op.id">
              <td class="mono">{{ op.shortId }}…</td>
              <td>{{ op.author }}</td>
              <td class="mono">{{ op.kind }}</td>
              <td class="mono">{{ op.command }}</td>
              <td class="mono">{{ op.cap ?? "—" }}</td>
              <td>
                <span v-if="op.quarantined" class="pill danger">
                  quarantined: {{ op.reason }}
                </span>
                <span v-else class="pill ok">honored</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>
