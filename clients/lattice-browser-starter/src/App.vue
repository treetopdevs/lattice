<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import type { FeedState } from "@treetopdevs/lattice-shell-kit/sync";
import { createIdentityFromSeedHex, type DemoIdentity } from "./lib/custody";
import {
  BrowserEcosystemHost,
  type DemoEndpoint,
  type DemoEndpointsManifest,
} from "./lib/browser_host";
import TreehouseApp from "./components/TreehouseApp.vue";
import TownshipApp from "./components/TownshipApp.vue";
import ToolshedApp from "./components/ToolshedApp.vue";
import DagInspector from "./components/DagInspector.vue";

type AppTab = "treehouse" | "township" | "toolshed";
type DemoRole = "founder" | "neighbor" | "observer";

const initialRole = (() => {
  const param = new URLSearchParams(window.location.search).get("role");
  if (param === "founder" || param === "neighbor" || param === "observer") return param;
  return "founder";
})();

const activeTab = ref<AppTab>("treehouse");
const selectedRole = ref<DemoRole>(initialRole);
/** The role whose identity the host is configured with; the select snaps back to it when a switch fails. */
let activeRole: DemoRole | null = null;
const manifest = shallowRef<DemoEndpointsManifest | null>(null);
const identity = shallowRef<DemoIdentity | null>(null);
const feedState = shallowRef<FeedState>({ configured: false, routes: [] });
const framesByReplica = shallowRef<Record<string, CarrierOpFrame[]>>({});
const pendingByReplica = shallowRef<Record<string, number>>({});
const online = ref(false);
const loading = ref(false);
const bootError = ref("");

const host = new BrowserEcosystemHost({
  pollMs: 5_000,
  onStateChange: () => refreshSnapshots(),
  onFeedState: (next) => {
    feedState.value = next;
  },
});

function refreshSnapshots() {
  const nextFrames: Record<string, CarrierOpFrame[]> = {};
  const nextPending: Record<string, number> = {};
  for (const ep of host.getEndpoints()) {
    nextFrames[ep.replica] = [...host.getFrames(ep.replica)];
    nextPending[ep.replica] = host.getPendingCount(ep.replica);
  }
  framesByReplica.value = nextFrames;
  pendingByReplica.value = nextPending;
  online.value = host.isOnline();
}

const realmByPubkey = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  const participants = manifest.value?.participants ?? {};
  for (const p of Object.values(participants)) {
    map[p.pubkey] = p.realm;
  }
  if (identity.value) {
    map[identity.value.publicKeyBase64] = identity.value.realm;
  }
  return map;
});

const endpoints = computed<DemoEndpoint[]>(() => manifest.value?.endpoints ?? []);
const endpointByName = (name: string) =>
  endpoints.value.find((ep) => ep.name === name) ?? null;

async function connectAsRole(role: DemoRole) {
  loading.value = true;
  bootError.value = "";
  try {
    const epRes = await fetch("/demo-endpoints.json", { cache: "no-store" });
    if (!epRes.ok) {
      throw new Error(
        "Could not load /demo-endpoints.json. Start scripts/demo_ecosystem_relay.sh first.",
      );
    }
    const data = (await epRes.json()) as DemoEndpointsManifest;

    const seedRes = await fetch(`/demo-seed/${role}`, { cache: "no-store" });
    if (!seedRes.ok) {
      throw new Error(`Could not load local dev seed for role "${role}".`);
    }
    const seedData = (await seedRes.json()) as { realm: string; seedHex: string };
    const id = createIdentityFromSeedHex(seedData.realm, seedData.seedHex);

    // Published only once the host holds this identity: the product panels sign with what they are
    // given, and a failed switch leaves the host on the previous identity and profile.
    await host.configure(data.endpoints, id, `${id.realm}:${id.fingerprint}`);
    manifest.value = data;
    identity.value = id;
    activeRole = role;
    await host.goOnline();
  } catch (err) {
    bootError.value = err instanceof Error ? err.message : String(err);
    if (activeRole !== null) selectedRole.value = activeRole;
  } finally {
    loading.value = false;
    refreshSnapshots();
  }
}

async function toggleOnline() {
  loading.value = true;
  bootError.value = "";
  try {
    if (online.value) {
      await host.goOffline();
    } else {
      await host.goOnline();
    }
  } catch (err) {
    bootError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
    refreshSnapshots();
  }
}

async function manualSync() {
  loading.value = true;
  bootError.value = "";
  try {
    await host.syncNow();
    refreshSnapshots();
  } catch (err) {
    bootError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function resetLocalCache() {
  await host.clearLocalStorage();
  if (online.value) await host.syncNow();
  refreshSnapshots();
}

async function handleAppendFrames(replica: string, frames: CarrierOpFrame[]) {
  await host.appendLocalFrames(replica, frames);
  refreshSnapshots();
}

const handleAppendFrame = (replica: string, frame: CarrierOpFrame) =>
  handleAppendFrames(replica, [frame]);

onMounted(() => {
  void connectAsRole(selectedRole.value);
});

onBeforeUnmount(() => {
  void host.dispose();
});
</script>

<template>
  <div class="shell">
    <div class="banner">
      <span>
        <strong>Assisted Local Demo</strong> — Browser IndexedDB Custody · Plaintext Loopback Relay ·
        Static Routes · No E2EE or Native Keychain
      </span>
      <span class="mono">
        Tip: open a second tab with <a href="?role=neighbor" target="_blank">?role=neighbor</a>
      </span>
    </div>

    <header class="topbar">
      <div class="brand">
        <h1>Lattice Multi-App Ecosystem</h1>
        <p>
          One signed op-log substrate · <code>@treetopdevs/lattice-client</code> +
          <code>@treetopdevs/lattice-shell-kit</code>
        </p>
      </div>

      <div class="controls">
        <label class="row" style="gap: 6px">
          <span class="muted">Identity:</span>
          <select
            v-model="selectedRole"
            data-testid="role-select"
            :disabled="loading"
            @change="connectAsRole(selectedRole)"
          >
            <option value="founder">demo-founder (root/clerk/steward)</option>
            <option value="neighbor">demo-neighbor (member/borrower)</option>
            <option value="observer">demo-observer (read-only)</option>
          </select>
        </label>

        <span v-if="identity" class="pill mono" data-testid="active-identity">
          {{ identity.realm }} · {{ identity.fingerprint }}
        </span>

        <button
          :class="online ? 'ok' : 'warn'"
          data-testid="online-toggle"
          :disabled="loading || !identity"
          @click="toggleOnline"
        >
          {{ online ? "Online (Live Push)" : "Offline (Local Outbox)" }}
        </button>

        <button data-testid="sync-now-btn" :disabled="loading || !identity" @click="manualSync">
          Sync Now
        </button>

        <button :disabled="loading || !identity" @click="resetLocalCache">Clear Cache</button>
      </div>
    </header>

    <div v-if="bootError" class="error-box" data-testid="boot-error">{{ bootError }}</div>

    <div v-if="feedState.routes.length > 0" class="route-bar" data-testid="route-status-bar">
      <span
        v-for="r in feedState.routes"
        :key="r.replica"
        class="pill"
        :class="r.connection === 'live' ? 'ok' : r.connection === 'refused' ? 'danger' : 'warn'"
      >
        {{ endpoints.find((e) => e.replica === r.replica)?.name ?? r.replica.slice(0, 16) }}:
        {{ r.connection }}
        <template v-if="r.generation !== null"> · gen#{{ r.generation }}</template>
        <template v-if="r.pending > 0"> · pending:{{ r.pending }}</template>
      </span>
    </div>

    <nav class="tabs" aria-label="Demo apps">
      <button
        class="tab"
        :class="{ active: activeTab === 'treehouse' }"
        data-testid="tab-treehouse"
        @click="activeTab = 'treehouse'"
      >
        Treehouse (Group Chat)
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'township' }"
        data-testid="tab-township"
        @click="activeTab = 'township'"
      >
        Township (Civic Matter)
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'toolshed' }"
        data-testid="tab-toolshed"
        @click="activeTab = 'toolshed'"
      >
        Toolshed (Tool Lending)
      </button>
    </nav>

    <TreehouseApp
      v-if="activeTab === 'treehouse'"
      :space-endpoint="endpointByName('treehouse_space')"
      :thread-endpoint="endpointByName('treehouse_thread')"
      :space-frames="framesByReplica[endpointByName('treehouse_space')?.replica ?? ''] ?? []"
      :thread-frames="framesByReplica[endpointByName('treehouse_thread')?.replica ?? ''] ?? []"
      :identity="identity"
      :realm-by-pubkey="realmByPubkey"
      :pending-count="pendingByReplica[endpointByName('treehouse_thread')?.replica ?? ''] ?? 0"
      :on-append-frame="handleAppendFrame"
    />

    <TownshipApp
      v-if="activeTab === 'township'"
      :endpoint="endpointByName('township_matter')"
      :frames="framesByReplica[endpointByName('township_matter')?.replica ?? ''] ?? []"
      :identity="identity"
      :realm-by-pubkey="realmByPubkey"
      :pending-count="pendingByReplica[endpointByName('township_matter')?.replica ?? ''] ?? 0"
      :on-append-frame="handleAppendFrame"
    />

    <ToolshedApp
      v-if="activeTab === 'toolshed'"
      :shed-endpoint="endpointByName('toolshed_shed')"
      :tool-endpoint="endpointByName('toolshed_tool')"
      :shed-frames="framesByReplica[endpointByName('toolshed_shed')?.replica ?? ''] ?? []"
      :tool-frames="framesByReplica[endpointByName('toolshed_tool')?.replica ?? ''] ?? []"
      :identity="identity"
      :realm-by-pubkey="realmByPubkey"
      :on-append-frame="handleAppendFrame"
      :on-append-frames="handleAppendFrames"
    />

    <DagInspector
      :endpoints="endpoints"
      :frames-by-replica="framesByReplica"
      :realm-by-pubkey="realmByPubkey"
    />
  </div>
</template>
