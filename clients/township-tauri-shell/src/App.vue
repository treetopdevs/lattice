<script setup lang="ts">
import { useTownshipSession } from "./township_session";

const {
  matter,
  carrierPeer,
  nativeStatus,
  actionAvailability,
  summaryDraft,
  summarySubmitting,
  statusSubmitting,
  memberDraft,
  memberSubmitting,
  grantAudienceDraft,
  grantSubmitting,
  revokeDelegationDraft,
  revokeSubmitting,
  postDraft,
  postSubmitting,
  pairingDraft,
  pairingSaveConfirmed,
  pairingDeepLinkImportArmed,
  pairingDeepLinkImportState,
  pairingSubmitting,
  pairingHandoffDraft,
  pairingHandoffFingerprint,
  pairingQrSvg,
  pairingQrImageStatus,
  pairingQrImporting,
  pairingCameraStatus,
  pairingCameraScanning,
  pairingDiscoveryStatus,
  pairingDiscoveryRunning,
  pairingDiscoveryCandidate,
  pairingAdvertiseStatus,
  pairingAdvertiseSubmitting,
  healthSubmitting,
  syncSubmitting,
  postStatusMessage,
  postStatusTone,
  summaryStatusMessage,
  summaryStatusTone,
  statusStatusMessage,
  statusStatusTone,
  memberStatusMessage,
  memberStatusTone,
  grantStatusMessage,
  grantStatusTone,
  revokeStatusMessage,
  revokeStatusTone,
  syncStatusMessage,
  syncStatusTone,
  pairingStatusMessage,
  pairingStatusTone,
  pairingSaveConfirmationRequired,
  pairingSaveConfirmationLabel,
  pairingSaveConfirmationDetail,
  pairingQrImageStatusTone,
  pairingCameraStatusTone,
  pairingDiscoveryStatusTone,
  pairingAdvertiseStatusTone,
  healthStatusMessage,
  healthStatusTone,
  availableActions,
  submitPost,
  submitSummary,
  submitMatterStatus,
  statusActionAllowed,
  submitMemberCommand,
  memberActionAllowed,
  submitGrant,
  submitRevoke,
  syncOutbox,
  submitPairing,
  clearPairingSaveConfirmation,
  exportPairingHandoff,
  importPairingHandoff,
  armPairingDeepLinkImport,
  disarmPairingDeepLinkImport,
  importPairingQrImage,
  startPairingQrCamera,
  stopPairingQrCamera,
  startPairingDiscovery,
  stopPairingDiscovery,
  loadDiscoveredPairing,
  advertisePairingHandoff,
  checkCarrierHealth,
} = useTownshipSession();
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
        <p>Carrier pairing</p>
        <span>Runtime config</span>
      </div>
      <form class="grant-form" @submit.prevent="submitPairing">
        <input
          v-model="pairingDraft.url"
          aria-label="Carrier URL"
          autocomplete="off"
          placeholder="Carrier URL"
          type="url"
          @input="clearPairingSaveConfirmation"
        />
        <input
          v-model="pairingDraft.localRealm"
          aria-label="Local realm"
          autocomplete="off"
          placeholder="Local realm"
          type="text"
          @input="clearPairingSaveConfirmation"
        />
        <input
          v-model="pairingDraft.expectedPeerRealm"
          aria-label="Peer realm"
          autocomplete="off"
          placeholder="Peer realm"
          type="text"
          @input="clearPairingSaveConfirmation"
        />
        <input
          v-model="pairingDraft.expectedPeerPubkey"
          aria-label="Peer public key"
          autocomplete="off"
          placeholder="Peer public key"
          type="text"
          @input="clearPairingSaveConfirmation"
        />
        <input
          v-model="pairingDraft.keyId"
          aria-label="Key id"
          autocomplete="off"
          placeholder="Key id"
          type="text"
          @input="clearPairingSaveConfirmation"
        />
        <textarea
          v-model="pairingHandoffDraft"
          aria-label="Pairing handoff"
          autocomplete="off"
          placeholder="Pairing handoff"
          rows="3"
        ></textarea>
        <small v-if="pairingHandoffFingerprint" class="fingerprint">
          peer fingerprint {{ pairingHandoffFingerprint }}. Verify peer fingerprint before saving.
        </small>
        <div v-if="pairingSaveConfirmationRequired" class="pairing-confirmation">
          <label>
            <input
              v-model="pairingSaveConfirmed"
              aria-label="Confirm carrier pairing save"
              type="checkbox"
            />
            <span>{{ pairingSaveConfirmationLabel }}</span>
          </label>
          <small>{{ pairingSaveConfirmationDetail }}</small>
        </div>
        <div v-if="pairingQrSvg" class="pairing-qr">
          <p>Pairing QR</p>
          <div class="pairing-qr-image" v-html="pairingQrSvg"></div>
          <small>QR carries the same public handoff; verify the peer fingerprint before saving.</small>
        </div>
        <label class="qr-file-control">
          <span>Pairing QR image</span>
          <input
            aria-label="Pairing QR image"
            accept="image/*"
            type="file"
            :disabled="pairingQrImporting"
            @change="importPairingQrImage"
          />
          <strong>{{ pairingQrImporting ? "Loading" : "Load QR image" }}</strong>
        </label>
        <p v-if="pairingQrImageStatus" class="post-message" :data-state="pairingQrImageStatusTone">
          {{ pairingQrImageStatus.message }}
        </p>
        <div class="qr-camera-control">
          <span>Pairing QR camera</span>
          <small>Public handoff metadata only; save before sync.</small>
          <div class="qr-camera-actions">
            <button type="button" :disabled="pairingCameraScanning" @click="startPairingQrCamera">
              {{ pairingCameraScanning ? "Camera running" : "Start camera" }}
            </button>
            <button type="button" :disabled="!pairingCameraScanning" @click="stopPairingQrCamera">
              Stop camera
            </button>
          </div>
        </div>
        <p v-if="pairingCameraStatus" class="post-message" :data-state="pairingCameraStatusTone">
          {{ pairingCameraStatus.message }}
        </p>
        <div class="pairing-discovery-control">
          <span>Pairing discovery</span>
          <small>Public handoff candidates only; load, verify, and save before sync.</small>
          <div class="pairing-discovery-actions">
            <button type="button" :disabled="pairingAdvertiseSubmitting || carrierPeer === null" @click="advertisePairingHandoff">
              {{ pairingAdvertiseSubmitting ? "Advertising" : "Advertise handoff" }}
            </button>
            <button type="button" :disabled="pairingDiscoveryRunning" @click="startPairingDiscovery">
              {{ pairingDiscoveryRunning ? "Discovery running" : "Start discovery" }}
            </button>
            <button type="button" :disabled="!pairingDiscoveryRunning" @click="stopPairingDiscovery">
              Stop discovery
            </button>
          </div>
          <div v-if="pairingDiscoveryCandidate" class="pairing-discovery-candidate">
            <strong>{{ pairingDiscoveryCandidate.label }}</strong>
            <small>peer fingerprint {{ pairingDiscoveryCandidate.peerFingerprint }}</small>
            <button type="button" @click="loadDiscoveredPairing">Load discovered handoff</button>
          </div>
        </div>
        <p v-if="pairingAdvertiseStatus" class="post-message" :data-state="pairingAdvertiseStatusTone">
          {{ pairingAdvertiseStatus.message }}
        </p>
        <p v-if="pairingDiscoveryStatus" class="post-message" :data-state="pairingDiscoveryStatusTone">
          {{ pairingDiscoveryStatus.message }}
        </p>
        <div class="grant-actions">
          <p class="post-message" :data-state="pairingStatusTone">{{ pairingStatusMessage }}</p>
          <button type="button" :disabled="carrierPeer === null" @click="exportPairingHandoff">Export handoff</button>
          <button type="button" @click="importPairingHandoff">Load handoff</button>
          <button type="button" :disabled="pairingDeepLinkImportArmed" @click="armPairingDeepLinkImport">
            {{ pairingDeepLinkImportArmed ? "Link import ready" : "Enable link import" }}
          </button>
          <button type="button" :disabled="!pairingDeepLinkImportArmed" @click="disarmPairingDeepLinkImport">
            Cancel link import
          </button>
          <small v-if="pairingDeepLinkImportState" class="fingerprint">
            link state {{ pairingDeepLinkImportState }}
          </small>
          <button type="submit" :disabled="pairingSubmitting">
            {{ pairingSubmitting ? "Saving" : "Save pairing" }}
          </button>
        </div>
      </form>
    </section>

    <section class="sync-panel">
      <div class="panel-heading">
        <p>Carrier</p>
        <span>Health and outbox sync</span>
      </div>
      <div class="sync-actions">
        <p class="sync-message" :data-state="healthStatusTone">{{ healthStatusMessage }}</p>
        <button type="button" :disabled="healthSubmitting" @click="checkCarrierHealth">
          {{ healthSubmitting ? "Checking" : "Check carrier" }}
        </button>
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
