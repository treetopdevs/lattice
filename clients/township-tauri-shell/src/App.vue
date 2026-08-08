<script setup lang="ts">
import { isTauri } from "@tauri-apps/api/core";
import type { WitnessedSuccessionReview } from "@treetopdevs/lattice-client";
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from "vue";
import {
  copyTownshipWitnessArtifactNative,
  createTownshipNativeWorkflow,
  createTownshipNativeStorage,
  loadTownshipNativeStatus,
  TOWNSHIP_TRACE_CARRIER_FEED_DOM_ERROR,
  TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX,
  TOWNSHIP_TRACE_CARRIER_HEALTH_STARTED,
  TOWNSHIP_TRACE_DEV_SHORTCUT_KEYDOWN_PREFIX,
  TOWNSHIP_TRACE_DEV_RUNTIME_READY,
  TOWNSHIP_TRACE_PAIRING_LINK_LOAD_SETTLED,
  TOWNSHIP_TRACE_PAIRING_CONFIG_SAVE_SUBMITTED,
  TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_STORAGE_NAMESPACE,
  traceTownshipDevEvent,
  type TownshipNativeStatus,
} from "./native_workflow";
import {
  exportTownshipWitnessArtifact,
  loadTownshipActionAvailability,
  loadTownshipWitnessArtifacts,
  loadTownshipWitnessReview,
  submitTownshipWitnessArtifact,
  submitTownshipDelegation,
  submitTownshipRevocation,
  submitTownshipCommand,
  submitTownshipPost,
  TOWNSHIP_WITNESS_INDEFINITE_VALIDITY_WARNING,
  type TownshipActionAvailability,
  type TownshipCommandName,
  type TownshipDelegationSubmission,
  type TownshipRevocationSubmission,
  type TownshipCommandSubmission,
  type TownshipPostSubmission,
  type TownshipStoredWitnessArtifact,
} from "./township_actions";
import { townshipMatterOps, townshipPreviewFromOps } from "./township_preview";
import {
  carrierVerifierAsOperationVerifier,
  checkTownshipCarrierPeerHealth,
  connectTownshipCarrierPeer,
  createWebCryptoCarrierVerifier,
  exportTownshipCarrierPairingHandoff,
  importTownshipCarrierPairingHandoff,
  loadTownshipCarrierPeerConfig,
  normalizeTownshipCarrierPeerConfig,
  saveTownshipCarrierPeerConfig,
  townshipCarrierPeerConfigsEqual,
  townshipCarrierPeerFingerprint,
  townshipCarrierPeerFromEnv,
  type TownshipCarrierPairingDraftOrigin,
  type TownshipCarrierPeerConfig,
  type TownshipCarrierPeerConfigInput,
  type TownshipCarrierHealthResult,
} from "./township_carrier_peer";
import {
  createTownshipFeedController,
  type TownshipFeedController,
  type TownshipFeedState,
} from "./township_feed";
import IntentReviewPanel from "./components/IntentReviewPanel.vue";
import {
  createOneShotTownshipPairingDeepLinkGate,
  parseTownshipPairingDeepLink,
  type TownshipPairingDeepLinkBlocked,
  type TownshipPairingDeepLinkGateConsumption,
  type TownshipPairingDeepLinkParse,
} from "./township_pairing_deeplink";
import { createTauriPairingDeepLinkSource } from "./township_pairing_deeplink_source";
import type { TownshipReviewableActionIntent } from "./township_action_intent";
import {
  actionIntentDevTraceEvent,
  actionIntentLabel,
  defineActionIntentRuntime,
  parseActionIntentDevRoute,
  type ActionIntentForVersion,
  type ActionIntentSlot,
  type ActionIntentStatus,
} from "./use_action_intent";
import {
  createTownshipParticipantDeepLinkDispatcher,
  type TownshipActionIntentRejection,
  type TownshipActionIntentTrace,
  type TownshipParticipantDeepLinkDispatcher,
} from "./township_deep_link_dispatcher";
import {
  createTownshipCanonicalProbeDeepLinkListener,
  logTownshipCanonicalProbe,
  parseTownshipCanonicalProbeDeepLink,
  type TownshipCanonicalProbeDeepLinkListener,
} from "./township_canonical_probe";
import { logTownshipReleaseBeamProbeFromEnv } from "./township_release_beam_probe";
import { logTownshipReleaseAuthorProbeFromEnv } from "./township_release_author_probe";
import {
  logTownshipReleaseRootOriginationProbeFromEnv,
  townshipReleaseRootOriginationProbeConfigFromEnv,
  type TownshipReleaseRootOriginationProbeEnv,
} from "./township_release_root_origination_probe";
import {
  logTownshipReleaseOnboardingProbeFromEnv,
  townshipReleaseOnboardingProbeConfigFromEnv,
  type TownshipReleaseOnboardingProbeEnv,
} from "./township_release_onboarding_probe";
import {
  logTownshipReleasePairingProbeFromEnv,
  townshipReleasePairingProbeConfigFromEnv,
  type TownshipReleasePairingProbeEnv,
} from "./township_release_pairing_probe";
import { logTownshipReleaseSyncProbeFromEnv } from "./township_release_sync_probe";
import { logTownshipReleaseTransportProbesFromEnv } from "./township_release_transport_probe";
import {
  TOWNSHIP_IOS_KEY_REUSE_CONTROL_KEY_ID,
  logTownshipIosKeyReuseProbeFromEnv,
  townshipIosKeyReuseProbeEnabled,
  type TownshipIosKeyReuseProbeEnv,
} from "./township_ios_key_reuse_probe";
import {
  createTownshipPairingDiscovery,
  type TownshipPairingDiscovery,
  type TownshipPairingDiscoveryAdvert,
  type TownshipPairingDiscoveryResult,
  type TownshipPairingDiscoverySource,
} from "./township_pairing_discovery";
import {
  advertiseTauriPairingHandoff,
  createTauriPairingDiscoverySource,
} from "./township_pairing_discovery_source";
import {
  decodeTownshipPairingQrImageData,
  renderTownshipPairingQrSvg,
  type TownshipPairingQrDecode,
} from "./township_pairing_qr";
import {
  createTownshipPairingQrCameraScanner,
  type TownshipPairingQrCameraFrame,
  type TownshipPairingQrCameraScanner,
  type TownshipPairingQrCameraSource,
} from "./township_pairing_qr_camera";
import { runTownshipPackagedOnboardingFromEnv } from "./township_packaged_onboarding_probe";
import {
  syncTownshipOutbox,
  TOWNSHIP_REALM_BY_PUBKEY,
  type TownshipOutboxSync,
} from "./township_sync";

const matter = ref(townshipPreviewFromOps(townshipMatterOps));
const carrierPeer = ref<TownshipCarrierPeerConfig | null>(townshipCarrierPeerFromEnv());
const feedState = shallowRef<TownshipFeedState>({
  phase: "unconfigured",
  projection: null,
  message: "No carrier pairing configured.",
});
const autosyncOnMount = truthy(import.meta.env.VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT);
const devTraceRuntime = truthy(import.meta.env.VITE_TOWNSHIP_DEV_TRACE);
const devTraceRuntimeReady = ref(false);
const nativeStatus = ref<TownshipNativeStatus>({
  ready: false,
  keyId: TOWNSHIP_NATIVE_KEY_ID,
  storageNamespace: TOWNSHIP_STORAGE_NAMESPACE,
  error: "Checking device key",
});
const actionOrder: readonly TownshipCommandName[] = [
  "set_title",
  "set_summary",
  "post",
  "admit",
  "remove_member",
  "close_matter",
  "reopen_matter",
];
const actionLabels: Record<TownshipCommandName, string> = {
  set_title: "Title",
  set_summary: "Summary",
  post: "Post",
  admit: "Admit member",
  remove_member: "Remove member",
  close_matter: "Close matter",
  reopen_matter: "Reopen matter",
};
type MatterStatusCommand = "close_matter" | "reopen_matter";
type MemberCommand = "admit" | "remove_member";
const actionAvailability = ref<TownshipActionAvailability>({
  ready: false,
  reason: "native_unavailable",
  message: "Checking local action permissions.",
});
const summaryDraft = ref(matter.value.summary);
const summaryStatus = ref<TownshipCommandSubmission | null>(null);
const summarySubmitting = ref(false);
const statusStatus = ref<TownshipCommandSubmission | null>(null);
const statusSubmitting = ref<MatterStatusCommand | null>(null);
const memberDraft = ref("");
const memberStatus = ref<TownshipCommandSubmission | null>(null);
const memberSubmitting = ref<MemberCommand | null>(null);
const grantAudienceDraft = ref("");
const grantStatus = ref<TownshipDelegationSubmission | null>(null);
const grantSubmitting = ref(false);
const revokeDelegationDraft = ref("");
const revokeStatus = ref<TownshipRevocationSubmission | null>(null);
const revokeSubmitting = ref(false);
const postDraft = ref("");
const postStatus = ref<TownshipPostSubmission | null>(null);
const pendingActionIntent = ref<TownshipReviewableActionIntent | null>(null);
type ActionIntentStatusSlot = "pending" | ActionIntentSlot;
type AcceptedIntentReview = Exclude<TownshipReviewableActionIntent, { v: 1 }>;
const pendingActionIntentStatus = ref<ActionIntentStatus | null>(null);
const activeActionIntentStatusSlot = ref<ActionIntentStatusSlot | null>(null);
const witnessReview = shallowRef<WitnessedSuccessionReview | null>(null);
const witnessReviewStatus = ref<ActionIntentStatus | null>(null);
const storedWitnessArtifacts = shallowRef<TownshipStoredWitnessArtifact[]>([]);
const selectedWitnessArtifactId = ref<string | null>(null);
const witnessExportStatus = ref<ActionIntentStatus | null>(null);
const selectedWitnessArtifact = computed(
  () =>
    storedWitnessArtifacts.value.find(
      (artifact) => artifact.artifactId === selectedWitnessArtifactId.value,
    ) ?? null,
);
const witnessArtifactConfirmation = computed(() => {
  const artifact = selectedWitnessArtifact.value;
  if (!artifact) return [];
  return [
    ...witnessReviewIdentityDetails(artifact.review),
    TOWNSHIP_WITNESS_INDEFINITE_VALIDITY_WARNING,
  ];
});
const actionIntentDescriptors = [
  defineActionIntentRuntime({
    slot: "post",
    version: 1,
    currentReplica: currentActionIntentReplica,
    submit: submitAcceptedPostIntent,
    acceptMessage: () => "Post request moved to the local draft.",
    dismissFallback: "Post request",
    onAccept: (intent) => {
      postDraft.value = intent.command.text;
    },
    onStatus: () => selectActionIntentStatus("post"),
  }),
  defineActionIntentRuntime({
    slot: "status",
    version: 2,
    reviewOrder: 2,
    currentReplica: currentActionIntentReplica,
    submit: submitAcceptedStatusIntent,
    acceptMessage: (intent) => `${actionIntentLabel(intent)} ready to sign on this device.`,
    dismissFallback: "Status request",
    allowed: (intent) => actionCommandAllowed(intent.command.command),
    busy: () => statusSubmitting.value !== null,
    signing: (intent) => statusSubmitting.value === intent.command.command,
    onStatus: () => selectActionIntentStatus("status"),
  }),
  defineActionIntentRuntime({
    slot: "field",
    version: 3,
    reviewOrder: 3,
    currentReplica: currentActionIntentReplica,
    submit: submitAcceptedFieldIntent,
    acceptMessage: (intent) => `${actionIntentLabel(intent)} ready to sign on this device.`,
    dismissFallback: "Field edit request",
    allowed: (intent) => actionCommandAllowed(intent.command.command),
    signing: (intent, submittingIntent) => submittingIntent?.command.command === intent.command.command,
    onStatus: () => selectActionIntentStatus("field"),
  }),
  defineActionIntentRuntime({
    slot: "roster",
    version: 4,
    reviewOrder: 1,
    currentReplica: currentActionIntentReplica,
    submit: submitAcceptedRosterIntent,
    acceptMessage: (intent) => `${actionIntentLabel(intent)} held for local review.`,
    dismissFallback: "Roster request",
    allowed: (intent) => actionCommandAllowed(intent.command.command),
    signing: (intent, submittingIntent) => submittingIntent?.command.command === intent.command.command,
    onStatus: () => selectActionIntentStatus("roster"),
  }),
  defineActionIntentRuntime({
    slot: "grant",
    version: 5,
    reviewOrder: 0,
    currentReplica: currentActionIntentReplica,
    submit: submitAcceptedGrantIntent,
    acceptMessage: (intent) => `${actionIntentLabel(intent)} held for local review.`,
    dismissFallback: "Grant access request",
    successMessage: () => "Grant signed and held for explicit Sync.",
    onStatus: () => selectActionIntentStatus("grant"),
  }),
  defineActionIntentRuntime({
    slot: "revoke",
    version: 6,
    reviewOrder: 4,
    currentReplica: currentActionIntentReplica,
    submit: submitAcceptedRevokeIntent,
    acceptMessage: (intent) => `${actionIntentLabel(intent)} held for local review.`,
    dismissFallback: "Revoke access request",
    successMessage: () => "Revoke signed and held for explicit Sync.",
    busy: () => revokeSubmitting.value,
    onStatus: () => selectActionIntentStatus("revoke"),
  }),
  defineActionIntentRuntime({
    slot: "witness",
    version: 7,
    reviewOrder: 5,
    currentReplica: currentActionIntentReplica,
    submit: submitAcceptedWitnessIntent,
    acceptMessage: () => "Witness recovery request held for local review.",
    dismissFallback: "Witness recovery request",
    successMessage: () => "Witness artifact signed and held for explicit export.",
    allowed: (intent) =>
      witnessReview.value?.claim.replica === intent.replica &&
      witnessReview.value.claim.role === intent.authority.role,
    onAccept: (intent) => void prepareAcceptedWitnessIntent(intent),
    onStatus: () => selectActionIntentStatus("witness"),
  }),
] as const;
const postActionIntent = actionIntentDescriptorForSlot("post");
const postSubmitting = postActionIntent.submitting;
const revokeIntentSubmitting = actionIntentDescriptorForSlot("revoke").submitting;
const actionIntentStatus = computed(() => statusForActionIntentSlot(activeActionIntentStatusSlot.value));
const acceptedIntentReviews = computed<AcceptedIntentReview[]>(() => {
  return actionIntentDescriptors
    .filter((descriptor) => descriptor.reviewOrder !== null)
    .sort((left, right) => (left.reviewOrder ?? 0) - (right.reviewOrder ?? 0))
    .map((descriptor) => descriptor.accepted())
    .filter(isAcceptedIntentReview);
});
const pairingDraft = ref<TownshipCarrierPeerConfigInput>(pairingDraftFromConfig(carrierPeer.value));
const pairingDraftOrigin = ref<TownshipCarrierPairingDraftOrigin>("manual");
const pairingSaveConfirmed = ref(false);
const pairingDeepLinkGate = createOneShotTownshipPairingDeepLinkGate();
const pairingDeepLinkImportArmed = ref(false);
const pairingDeepLinkImportState = ref<string | null>(null);
const pairingStatus = ref<{ ok: boolean; message: string } | null>(null);
const pairingSubmitting = ref(false);
const pairingHandoffDraft = ref("");
const pairingHandoffFingerprint = ref<string | null>(
  carrierPeer.value ? townshipCarrierPeerFingerprint(carrierPeer.value.expectedPeerPubkey) : null,
);
const pairingQrSvg = ref<string | null>(carrierPeer.value ? pairingQrSvgFromConfig(carrierPeer.value) : null);
const pairingQrImageStatus = ref<{ ok: boolean; message: string } | null>(null);
const pairingQrImporting = ref(false);
const pairingCameraStatus = ref<{ ok: boolean; message: string } | null>(null);
const pairingCameraScanning = ref(false);
const pairingDiscoveryStatus = ref<{ ok: boolean; message: string } | null>(null);
const pairingDiscoveryRunning = ref(false);
const pairingDiscoveryCandidate = ref<Extract<TownshipPairingDiscoveryResult, { ok: true }> | null>(null);
const pairingAdvertiseStatus = ref<{ ok: boolean; message: string } | null>(null);
const pairingAdvertiseSubmitting = ref(false);
let participantDeepLinkDispatcher: TownshipParticipantDeepLinkDispatcher | null = null;
let canonicalProbeDeepLinkListener: TownshipCanonicalProbeDeepLinkListener | null = null;
let pairingCameraScanner: TownshipPairingQrCameraScanner | null = null;
let pairingDiscovery: TownshipPairingDiscovery | null = null;
let townshipFeedController: TownshipFeedController | null = null;
let devTraceShortcutMounted = false;
let appUnmounted = false;
const healthStatus = ref<TownshipCarrierHealthResult | null>(null);
const healthSubmitting = ref(false);
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
const summaryStatusMessage = computed(() => {
  if (summaryStatus.value === null) return "Summary edits will be signed by this device key.";
  if (summaryStatus.value.ok) return `Saved signed frame ${summaryStatus.value.frameId.slice(0, 10)}...`;
  return summaryStatus.value.message;
});
const summaryStatusTone = computed(() => {
  if (summaryStatus.value === null) return "idle";
  return summaryStatus.value.ok ? "success" : summaryStatus.value.reason;
});
const statusStatusMessage = computed(() => {
  if (statusStatus.value === null) return "Close and reopen actions will be signed by this device key.";
  if (statusStatus.value.ok) return `Saved signed frame ${statusStatus.value.frameId.slice(0, 10)}...`;
  return statusStatus.value.message;
});
const statusStatusTone = computed(() => {
  if (statusStatus.value === null) return "idle";
  return statusStatus.value.ok ? "success" : statusStatus.value.reason;
});
const memberStatusMessage = computed(() => {
  if (memberStatus.value === null) return "Member changes will be signed by this device key.";
  if (memberStatus.value.ok) return `Saved signed frame ${memberStatus.value.frameId.slice(0, 10)}...`;
  return memberStatus.value.message;
});
const memberStatusTone = computed(() => {
  if (memberStatus.value === null) return "idle";
  return memberStatus.value.ok ? "success" : memberStatus.value.reason;
});
const grantStatusMessage = computed(() => {
  if (grantStatus.value === null) return "Resident access will be signed by this device key.";
  if (grantStatus.value.ok) {
    return `Saved grant frame ${grantStatus.value.frameId.slice(0, 10)}...; pending carrier sync.`;
  }
  return grantStatus.value.message;
});
const grantStatusTone = computed(() => {
  if (grantStatus.value === null) return "idle";
  return grantStatus.value.ok ? "success" : grantStatus.value.reason;
});
const revokeStatusMessage = computed(() => {
  if (revokeStatus.value === null) return "Revokes are saved locally; carrier sync reports acceptance.";
  if (revokeStatus.value.ok) {
    return `Saved revoke frame ${revokeStatus.value.frameId.slice(0, 10)}...; pending carrier sync.`;
  }
  return revokeStatus.value.message;
});
const revokeStatusTone = computed(() => {
  if (revokeStatus.value === null) return "idle";
  return revokeStatus.value.ok ? "success" : revokeStatus.value.reason;
});
const syncStatusMessage = computed(() => {
  if (syncStatus.value === null) return carrierPeer.value === null ? "Save a carrier pairing before syncing." : "Ready to sync outbox.";
  if (syncStatus.value.ok) {
    if (syncStatus.value.authorityRevokedCapabilityAttributionCount > 0) {
      const first = syncStatus.value.authorityRevokedCapabilityAttributions[0];
      if (first) {
        return revokedCapabilityAttributionMessage(
          syncStatus.value.authorityRevokedCapabilityAttributionCount,
          first.delegationId,
          syncStatus.value.authorityRevokedCapabilityUnattributedCount,
        );
      }
    }
    if (syncStatus.value.authorityRevokedCapabilityCount > 0) {
      return `${revokedCapCommandCount(syncStatus.value.authorityRevokedCapabilityCount)} blocked by local verification.`;
    }
    if (syncStatus.value.carrierAcceptedRevocationCount > 0) {
      return `${revokeFrameCount(syncStatus.value.carrierAcceptedRevocationCount)} carrier accepted; pending authority confirmation.`;
    }
    if (syncStatus.value.authorityQuarantinedRevocationCount > 0) {
      return `${revokeFrameCount(syncStatus.value.authorityQuarantinedRevocationCount)} authority-quarantined by carrier.`;
    }
    return `Pushed ${syncStatus.value.pushedFrameCount}, pulled ${syncStatus.value.pulledOpCount}, accepted ${syncStatus.value.acceptedCount}.`;
  }
  return syncStatus.value.message;
});
const syncStatusTone = computed(() => {
  if (syncStatus.value === null) return "idle";
  return syncStatus.value.ok ? "success" : syncStatus.value.reason;
});
const pairingStatusMessage = computed(() => {
  if (pairingStatus.value === null) {
    return carrierPeer.value === null ? "Enter the carrier peer details for this Township." : "Pairing config is ready for sync.";
  }
  return pairingStatus.value.message;
});
const pairingStatusTone = computed(() => {
  if (pairingStatus.value === null) return "idle";
  return pairingStatus.value.ok ? "success" : "sync_failed";
});
const normalizedPairingDraftConfig = computed(() => {
  const normalized = normalizeTownshipCarrierPeerConfig(pairingDraft.value);
  return normalized.ok ? normalized.config : null;
});
const currentPairingFingerprint = computed(() =>
  carrierPeer.value === null ? null : townshipCarrierPeerFingerprint(carrierPeer.value.expectedPeerPubkey),
);
const draftPairingFingerprint = computed(() =>
  normalizedPairingDraftConfig.value === null
    ? null
    : townshipCarrierPeerFingerprint(normalizedPairingDraftConfig.value.expectedPeerPubkey),
);
const pairingSaveConfirmationRequired = computed(() => {
  const draft = normalizedPairingDraftConfig.value;
  if (draft === null) return false;
  if (carrierPeer.value !== null && townshipCarrierPeerConfigsEqual(carrierPeer.value, draft)) return false;
  if (carrierPeer.value !== null) return true;
  return pairingDraftOrigin.value !== "manual";
});
const pairingSaveConfirmationLabel = computed(() =>
  carrierPeer.value === null
    ? "I verified this imported carrier pairing"
    : "I verified replacing the saved carrier pairing",
);
const pairingSaveConfirmationDetail = computed(() => {
  if (carrierPeer.value === null) {
    return draftPairingFingerprint.value === null
      ? "Verify the peer fingerprint before saving."
      : `Draft peer ${draftPairingFingerprint.value}.`;
  }

  const current = currentPairingFingerprint.value ?? "unknown";
  const draft = draftPairingFingerprint.value ?? "unknown";
  return `Current peer ${current}; draft peer ${draft}.`;
});
const pairingQrImageStatusTone = computed(() => {
  if (pairingQrImageStatus.value === null) return "idle";
  return pairingQrImageStatus.value.ok ? "success" : "sync_failed";
});
const pairingCameraStatusTone = computed(() => {
  if (pairingCameraStatus.value === null) return "idle";
  return pairingCameraStatus.value.ok ? "success" : "sync_failed";
});
const pairingDiscoveryStatusTone = computed(() => {
  if (pairingDiscoveryStatus.value === null) return "idle";
  return pairingDiscoveryStatus.value.ok ? "success" : "sync_failed";
});
const pairingAdvertiseStatusTone = computed(() => {
  if (pairingAdvertiseStatus.value === null) return "idle";
  return pairingAdvertiseStatus.value.ok ? "success" : "sync_failed";
});
const healthStatusMessage = computed(() => {
  if (healthStatus.value === null) {
    return carrierPeer.value === null ? "Save a carrier pairing to check health." : "Ready to check carrier health.";
  }
  if (healthStatus.value.ok) {
    return `Carrier session opened; peer status: ${healthStatus.value.phase}.`;
  }
  return healthStatus.value.message;
});
const healthStatusTone = computed(() => {
  if (healthStatus.value === null) return "idle";
  return healthStatus.value.ok ? "success" : healthStatus.value.reason;
});
const availableActions = computed(() => {
  const availability = actionAvailability.value;
  if (!availability.ready) return [];

  return actionOrder.map((name) => ({
    ...availability.commands[name],
    label: actionLabels[name],
  }));
});

onMounted(async () => {
  appUnmounted = false;
  const releasePairingProbeActive =
    isAndroidTauriShell() &&
    townshipReleasePairingProbeConfigFromEnv(import.meta.env as TownshipReleasePairingProbeEnv) !== null;
  const releaseOnboardingProbeActive =
    isAndroidTauriShell() &&
    townshipReleaseOnboardingProbeConfigFromEnv(import.meta.env as TownshipReleaseOnboardingProbeEnv & Record<string, string | undefined>) !==
      null;
  const releaseRootOriginationProbeActive =
    isAndroidTauriShell() &&
    townshipReleaseRootOriginationProbeConfigFromEnv(
      import.meta.env as TownshipReleaseRootOriginationProbeEnv & Record<string, string | undefined>,
    ) !== null;
  if (isAndroidTauriShell()) {
    void logTownshipCanonicalProbe().catch(() => {});
    if (releaseRootOriginationProbeActive) {
      void logTownshipReleaseRootOriginationProbeFromEnv().catch(() => {});
    } else if (releaseOnboardingProbeActive) {
      void logTownshipReleaseOnboardingProbeFromEnv().catch(() => {});
    } else {
      void logTownshipReleaseBeamProbeFromEnv().catch(() => {});
      void logTownshipReleaseSyncProbeFromEnv().catch(() => {});
      void logTownshipReleaseAuthorProbeFromEnv().catch(() => {});
      void logTownshipReleasePairingProbeFromEnv().catch(() => {});
      void logTownshipReleaseTransportProbesFromEnv().catch(() => {});
    }
  }
  await loadPairingConfig();
  await mountTownshipFeed();
  if (!releasePairingProbeActive && !releaseOnboardingProbeActive && !releaseRootOriginationProbeActive) {
    await mountParticipantDeepLinkDispatcher();
    await mountCanonicalProbeDeepLinkListener();
  }
  if (devTraceRuntime) await mountDevTraceShortcut();
  if (autosyncOnMount && carrierPeer.value) await syncOutbox();
  if (devTraceRuntime) {
    const onboarding = await runTownshipPackagedOnboardingFromEnv(import.meta.env);
    if (onboarding?.ok) {
      carrierPeer.value = onboarding.pairing;
      pairingDraft.value = pairingDraftFromConfig(onboarding.pairing);
      postStatus.value = onboarding.post;
      syncStatus.value = onboarding.finalSync;
      await townshipFeedController?.replacePeer(onboarding.pairing);
    }
  }
  scheduleTownshipNativeHydration();
});

onUnmounted(() => {
  appUnmounted = true;
  void townshipFeedController?.stop();
  townshipFeedController = null;
  devTraceRuntimeReady.value = false;
  if (devTraceShortcutMounted) window.removeEventListener("keydown", handleDevTraceShortcut);
  devTraceShortcutMounted = false;
  canonicalProbeDeepLinkListener?.stop();
  canonicalProbeDeepLinkListener = null;
  participantDeepLinkDispatcher?.stop();
  participantDeepLinkDispatcher = null;
  clearPairingDeepLinkImport();
  clearActionIntents();
  stopPairingQrCamera();
  stopPairingDiscovery();
});

async function submitPost() {
  if (postActionIntent.accepted()) {
    await postActionIntent.sign();
    return;
  }
  if (postSubmitting.value) return;

  postSubmitting.value = true;
  try {
    postStatus.value = await submitTownshipPost({ text: postDraft.value });
    if (postStatus.value.ok) {
      postDraft.value = "";
      postActionIntent.clear();
      activeActionIntentStatusSlot.value = null;
    }
  } finally {
    postSubmitting.value = false;
  }
}

async function submitAcceptedPostIntent(intent: ActionIntentForVersion<1>) {
  const submission = await submitTownshipPost({ text: postDraft.value, replica: intent.replica });
  postStatus.value = submission;
  if (submission.ok) {
    postDraft.value = "";
    return { ok: true, message: "" };
  }
  return { ok: false, message: submission.message };
}

async function submitAcceptedStatusIntent(intent: ActionIntentForVersion<2>) {
  await submitMatterStatus(intent.command.command, intent.replica);
  const submission = statusStatus.value;
  if (!submission) return { ok: false, message: "Matter status action did not complete." };
  return submission.ok ? { ok: true, message: "" } : { ok: false, message: submission.message };
}

async function submitAcceptedFieldIntent(intent: ActionIntentForVersion<3>) {
  const submission = await submitTownshipCommand({ command: intent.command, replica: intent.replica });
  return submission.ok ? { ok: true, message: "" } : { ok: false, message: submission.message };
}

async function submitAcceptedRosterIntent(intent: ActionIntentForVersion<4>) {
  const submission = await submitTownshipCommand({ command: intent.command, replica: intent.replica });
  return submission.ok ? { ok: true, message: "" } : { ok: false, message: submission.message };
}

async function submitAcceptedGrantIntent(intent: ActionIntentForVersion<5>) {
  const submission = await submitTownshipDelegation({
    audiencePubkey: intent.authority.audience,
    ops: intent.authority.ops,
    roles: intent.authority.roles,
    live: intent.authority.live,
    replica: intent.replica,
  });
  return submission.ok ? { ok: true, message: "" } : { ok: false, message: submission.message };
}

async function submitAcceptedRevokeIntent(intent: ActionIntentForVersion<6>) {
  const submission = await submitTownshipRevocation({
    delegationId: intent.authority.delegation,
    replica: intent.replica,
  });
  return submission.ok ? { ok: true, message: "" } : { ok: false, message: submission.message };
}

async function submitSummary() {
  if (summarySubmitting.value) return;

  summarySubmitting.value = true;
  try {
    summaryStatus.value = await submitTownshipCommand({
      command: { command: "set_summary", text: summaryDraft.value },
    });
  } finally {
    summarySubmitting.value = false;
  }
}

async function submitMatterStatus(command: MatterStatusCommand, replica?: string) {
  if (statusSubmitting.value !== null) return;

  statusSubmitting.value = command;
  try {
    statusStatus.value = await submitTownshipCommand({
      command: { command },
      ...(replica ? { replica } : {}),
    });
  } finally {
    statusSubmitting.value = null;
  }
}

function statusActionAllowed(command: MatterStatusCommand): boolean {
  return actionCommandAllowed(command);
}

function actionCommandAllowed(command: TownshipCommandName): boolean {
  const availability = actionAvailability.value;
  return availability.ready && availability.commands[command].allowed;
}

async function submitMemberCommand(command: MemberCommand) {
  if (memberSubmitting.value !== null) return;

  memberSubmitting.value = command;
  try {
    memberStatus.value = await submitTownshipCommand({
      command: { command, member: memberDraft.value },
    });
    if (memberStatus.value.ok) memberDraft.value = "";
  } finally {
    memberSubmitting.value = null;
  }
}

function memberActionAllowed(command: MemberCommand): boolean {
  const availability = actionAvailability.value;
  return availability.ready && availability.commands[command].allowed;
}

async function submitGrant() {
  if (grantSubmitting.value) return;

  grantSubmitting.value = true;
  try {
    grantStatus.value = await submitTownshipDelegation({ audiencePubkey: grantAudienceDraft.value });
    if (grantStatus.value.ok) {
      grantAudienceDraft.value = "";
      actionAvailability.value = await loadTownshipActionAvailability();
    }
  } finally {
    grantSubmitting.value = false;
  }
}

async function submitRevoke() {
  if (revokeSubmitting.value || revokeIntentSubmitting.value) return;

  revokeSubmitting.value = true;
  try {
    revokeStatus.value = await submitTownshipRevocation({ delegationId: revokeDelegationDraft.value });
    if (revokeStatus.value.ok) {
      revokeDelegationDraft.value = "";
    }
  } finally {
    revokeSubmitting.value = false;
  }
}

async function mountTownshipFeed() {
  if (appUnmounted) return;

  const controller = createTownshipFeedController({
    async connect(peer) {
      const workflow = await createTownshipNativeWorkflow({
        ...(peer.keyId ? { keyId: peer.keyId } : {}),
      });
      const sessionVerifier = createWebCryptoCarrierVerifier();
      const client = await connectTownshipCarrierPeer({
        workflow,
        peer,
        verifier: sessionVerifier,
      });
      return {
        client,
        workflow,
        verifier: carrierVerifierAsOperationVerifier(sessionVerifier),
      };
    },
    onState: receiveTownshipFeedState,
    realmByPubkey: TOWNSHIP_REALM_BY_PUBKEY,
  });
  townshipFeedController = controller;
  await controller.replacePeer(carrierPeer.value);
}

function receiveTownshipFeedState(state: TownshipFeedState) {
  if (appUnmounted) return;

  feedState.value = state;
  if (state.phase === "fresh") matter.value = state.projection.matter;
  if (devTraceRuntime) {
    void traceRenderedTownshipFeed(state).catch(() => {
      void traceTownshipDevEvent(TOWNSHIP_TRACE_CARRIER_FEED_DOM_ERROR).catch(() => {});
    });
  }
}

async function traceRenderedTownshipFeed(state: TownshipFeedState) {
  await nextTick();
  if (appUnmounted || feedState.value !== state) return;

  const status = document.querySelector("#carrier-feed-status");
  const matterStatus = document.querySelector("#matter-render-status");
  const title = document.querySelector("#matter-title");
  const summary = document.querySelector("#matter-summary");
  if (!status || !matterStatus || !title || !summary) return;
  const titleText = title.textContent?.trim() ?? "";
  const summaryText = summary.textContent?.trim() ?? "";
  const postTexts = Array.from(
    document.querySelectorAll("#township-proceedings .post-list li"),
    (entry) => entry.textContent?.trim() ?? "",
  );
  const memberTexts = Array.from(
    document.querySelectorAll("#township-roster .member-list li"),
    (entry) => entry.textContent?.trim() ?? "",
  );
  const [titleDigest, summaryDigest, postDigests, memberDigests] = await Promise.all([
    digestTownshipTraceText(titleText),
    digestTownshipTraceText(summaryText),
    Promise.all(postTexts.map(digestTownshipTraceText)),
    Promise.all(memberTexts.map(digestTownshipTraceText)),
  ]);
  if (appUnmounted || feedState.value !== state) return;

  const rendered = {
    phase: status.getAttribute("data-phase"),
    generation: status.getAttribute("data-generation"),
    opCount: status.getAttribute("data-op-count"),
    postCount: status.getAttribute("data-post-count"),
    matterOpCount: matterStatus.getAttribute("data-op-count"),
    matterPostCount: matterStatus.getAttribute("data-post-count"),
    matterState: matterStatus.getAttribute("data-state"),
    titleDigest,
    summaryDigest,
    postDigests,
    memberDigests,
  };
  await traceTownshipDevEvent(`${TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX}${JSON.stringify(rendered)}`);
}

async function digestTownshipTraceText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function syncOutbox() {
  if (syncSubmitting.value) return;

  syncSubmitting.value = true;
  try {
    void traceTownshipDevEvent(TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED).catch(() => {});
    syncStatus.value = await syncTownshipOutbox(carrierPeer.value ? { peer: carrierPeer.value } : {});
    if (syncStatus.value.ok) actionAvailability.value = await loadTownshipActionAvailability();
  } finally {
    syncSubmitting.value = false;
  }
}

async function loadPairingConfig() {
  try {
    const storage = createTownshipNativeStorage();
    carrierPeer.value = await loadTownshipCarrierPeerConfig(storage);
    pairingDraft.value = pairingDraftFromConfig(carrierPeer.value);
    pairingQrSvg.value = carrierPeer.value ? pairingQrSvgFromConfig(carrierPeer.value) : null;
    resetPairingSaveState();
  } catch {
    carrierPeer.value = townshipCarrierPeerFromEnv();
    pairingDraft.value = pairingDraftFromConfig(carrierPeer.value);
    pairingQrSvg.value = carrierPeer.value ? pairingQrSvgFromConfig(carrierPeer.value) : null;
    resetPairingSaveState();
  }
}

function scheduleTownshipNativeHydration() {
  window.setTimeout(() => {
    void hydrateTownshipNativeReadiness();
  }, 1_000);
}

async function hydrateTownshipNativeReadiness() {
  nativeStatus.value = await loadTownshipNativeStatus();
  const iosProbeEnv = import.meta.env as TownshipIosKeyReuseProbeEnv;
  await logTownshipIosKeyReuseProbeFromEnv(nativeStatus.value, iosProbeEnv, { slot: "primary" }).catch(
    () => false,
  );
  if (townshipIosKeyReuseProbeEnabled(iosProbeEnv)) {
    const controlStatus = await loadTownshipNativeStatus({
      keyId: TOWNSHIP_IOS_KEY_REUSE_CONTROL_KEY_ID,
    });
    await logTownshipIosKeyReuseProbeFromEnv(controlStatus, iosProbeEnv, { slot: "control" }).catch(() => false);
  }
  actionAvailability.value = await loadTownshipActionAvailability();
  await hydrateTownshipWitnessArtifacts();
  if (devTraceRuntime) void traceTownshipDevEvent("township-native-hydration-settled").catch(() => {});
}

async function hydrateTownshipWitnessArtifacts(preferredArtifactId?: string) {
  const loaded = await loadTownshipWitnessArtifacts();
  if (!loaded.ok) {
    storedWitnessArtifacts.value = [];
    selectedWitnessArtifactId.value = null;
    witnessExportStatus.value = { ok: false, message: loaded.message };
    return;
  }

  storedWitnessArtifacts.value = loaded.artifacts;
  const selectedId = preferredArtifactId ?? selectedWitnessArtifactId.value;
  selectedWitnessArtifactId.value =
    loaded.artifacts.find((artifact) => artifact.artifactId === selectedId)?.artifactId ??
    loaded.artifacts[0]?.artifactId ??
    null;
  await nextTick();
  await traceWitnessArtifactDom();
}

async function submitPairing() {
  if (pairingSubmitting.value) return;

  pairingSubmitting.value = true;
  try {
    void traceTownshipDevEvent(TOWNSHIP_TRACE_PAIRING_CONFIG_SAVE_SUBMITTED).catch(() => {});
    const storage = createTownshipNativeStorage();
    const saved = await saveTownshipCarrierPeerConfig(storage, pairingDraft.value, {
      origin: pairingDraftOrigin.value,
      confirmed: pairingSaveConfirmed.value,
    });
    if (saved.ok) {
      carrierPeer.value = saved.config;
      await townshipFeedController?.replacePeer(saved.config);
      pairingDraft.value = pairingDraftFromConfig(saved.config);
      pairingHandoffFingerprint.value = townshipCarrierPeerFingerprint(saved.config.expectedPeerPubkey);
      pairingQrSvg.value = pairingQrSvgFromConfig(saved.config);
      resetPairingSaveState();
      pairingStatus.value = { ok: true, message: "Pairing config saved for future sync." };
    } else {
      pairingStatus.value = { ok: false, message: saved.message };
    }
  } catch {
    pairingStatus.value = { ok: false, message: "Open in the Tauri shell to save carrier pairing." };
  } finally {
    pairingSubmitting.value = false;
  }
}

function clearPairingSaveConfirmation() {
  pairingSaveConfirmed.value = false;
}

function resetPairingSaveState() {
  pairingDraftOrigin.value = "manual";
  pairingSaveConfirmed.value = false;
}

function markImportedPairingDraft(origin: Exclude<TownshipCarrierPairingDraftOrigin, "manual" | "release_probe">) {
  pairingDraftOrigin.value = origin;
  pairingSaveConfirmed.value = false;
}

function exportPairingHandoff() {
  if (carrierPeer.value === null) {
    pairingStatus.value = { ok: false, message: "Save a carrier pairing before exporting a handoff." };
    return;
  }

  pairingHandoffDraft.value = exportTownshipCarrierPairingHandoff(carrierPeer.value);
  pairingHandoffFingerprint.value = townshipCarrierPeerFingerprint(carrierPeer.value.expectedPeerPubkey);
  const qr = renderTownshipPairingQrSvg(pairingHandoffDraft.value);
  pairingQrSvg.value = qr.ok ? qr.svg : null;
  pairingStatus.value = { ok: true, message: "Pairing handoff ready; verify peer fingerprint before sharing." };
}

function importPairingHandoff() {
  const imported = importPairingIngress(pairingHandoffDraft.value);
  if (!imported.ok) {
    pairingStatus.value = { ok: false, message: imported.message };
    return;
  }

  pairingDraft.value = {
    ...pairingDraft.value,
    ...imported.draft,
  };
  pairingHandoffDraft.value = imported.handoff;
  pairingHandoffFingerprint.value = imported.peerFingerprint;
  pairingQrSvg.value = null;
  markImportedPairingDraft("handoff");
  pairingStatus.value = { ok: true, message: "Pairing handoff loaded; save before sync." };
}

async function mountParticipantDeepLinkDispatcher() {
  if (participantDeepLinkDispatcher !== null) return;

  try {
    participantDeepLinkDispatcher = await createTownshipParticipantDeepLinkDispatcher({
      source: createTauriPairingDeepLinkSource({ includeAndroidPairingIntent: true }),
      expectedReplica: () => carrierPeer.value?.replica ?? null,
      stageAction: stageActionIntent,
      rejectAction: rejectActionIntent,
      routeOther: routeOtherParticipantDeepLink,
      traceAction: traceActionIntent,
    });
    void traceTownshipDevEvent("deep-link-listener-mounted").catch(() => {});
  } catch {
    participantDeepLinkDispatcher = null;
    void traceTownshipDevEvent("deep-link-listener-unavailable").catch(() => {});
  }
}

async function mountCanonicalProbeDeepLinkListener() {
  if (canonicalProbeDeepLinkListener !== null) return;

  try {
    canonicalProbeDeepLinkListener = await createTownshipCanonicalProbeDeepLinkListener({
      source: createTauriPairingDeepLinkSource({ includeAndroidPairingIntent: false }),
    });
  } catch {
    canonicalProbeDeepLinkListener = null;
  }
}

function armPairingDeepLinkImport(event?: Event) {
  if (event && !event.isTrusted) return;

  const state = pairingDeepLinkGate.arm();
  pairingDeepLinkImportArmed.value = true;
  pairingDeepLinkImportState.value = state;
  pairingStatus.value = { ok: true, message: "Pairing link import ready." };
  void traceTownshipDevEvent("pairing-link-import-armed").catch(() => {});
  if (devTraceRuntime) void traceTownshipDevEvent(`pairing-link-import-state:${state}`).catch(() => {});
}

function disarmPairingDeepLinkImport() {
  clearPairingDeepLinkImport();
  pairingStatus.value = { ok: true, message: "Pairing link import cancelled." };
}

function clearPairingDeepLinkImport() {
  pairingDeepLinkGate.disarm();
  pairingDeepLinkImportArmed.value = false;
  pairingDeepLinkImportState.value = null;
}

async function mountDevTraceShortcut() {
  try {
    await traceTownshipDevEvent(TOWNSHIP_TRACE_DEV_RUNTIME_READY);
    if (appUnmounted) return;
    devTraceRuntimeReady.value = true;
    window.addEventListener("keydown", handleDevTraceShortcut);
    devTraceShortcutMounted = true;
  } catch {
    devTraceRuntimeReady.value = false;
    devTraceShortcutMounted = false;
  }
}

function handleDevTraceShortcut(event: KeyboardEvent) {
  const key = event.key.toLowerCase();
  void traceTownshipDevEvent(`${TOWNSHIP_TRACE_DEV_SHORTCUT_KEYDOWN_PREFIX}${key}`).catch(() => {});

  if (!event.isTrusted || !event.metaKey || !event.shiftKey || event.repeat) return;

  if (key !== "l" && key !== "h" && key !== "e") return;

  event.preventDefault();
  if (key === "l") {
    armPairingDeepLinkImport(event);
  } else if (key === "h") {
    void checkCarrierHealth();
  } else {
    void exportSelectedWitnessArtifact(event);
  }
}

function consumePairingDeepLinkImport(parse: TownshipPairingDeepLinkParse): TownshipPairingDeepLinkGateConsumption {
  const accepted = pairingDeepLinkGate.consume(parse);
  pairingDeepLinkImportArmed.value = pairingDeepLinkGate.armed();
  pairingDeepLinkImportState.value = pairingDeepLinkGate.state();
  return accepted;
}

function handleBlockedPairingDeepLink(blocked: TownshipPairingDeepLinkBlocked) {
  if (blocked.reason === "state_mismatch") {
    pairingStatus.value = { ok: false, message: "Pairing link ignored; state token did not match." };
    void traceTownshipDevEvent("pairing-link-blocked:state-mismatch").catch(() => {});
    return;
  }

  pairingStatus.value = { ok: false, message: "Pairing link ignored; enable link import first." };
  void traceTownshipDevEvent("pairing-link-blocked:not-armed").catch(() => {});
}

function stageActionIntent(intent: TownshipReviewableActionIntent) {
  pendingActionIntent.value = intent;
  setPendingActionIntentStatus({ ok: true, message: `${actionIntentLabel(intent)} ready for review.` });
}

function rejectActionIntent(rejection: TownshipActionIntentRejection) {
  setPendingActionIntentStatus({ ok: false, message: rejection.message });
}

async function traceActionIntent(trace: TownshipActionIntentTrace): Promise<void> {
  await traceTownshipDevEvent(`action-intent:${trace.outcome}:${trace.intentId ?? "none"}`);
}

function acceptPendingActionIntent(event?: Event) {
  const intent = pendingActionIntent.value;
  if (!intent) return;
  const outcome = actionIntentDescriptorForVersion(intent.v).accept(intent, event);

  if (outcome === "accepted") pendingActionIntent.value = null;
}

function dismissPendingActionIntent(event?: Event) {
  if (event && !event.isTrusted) return;
  const intent = pendingActionIntent.value;
  pendingActionIntent.value = null;
  setPendingActionIntentStatus({
    ok: true,
    message: `${intent ? actionIntentLabel(intent) : "Action request"} dismissed.`,
  });
}

async function signAcceptedIntent(intent: AcceptedIntentReview, event?: Event) {
  await actionIntentDescriptorForVersion(intent.v).sign(event);
}

function dismissAcceptedIntent(intent: AcceptedIntentReview, event?: Event) {
  actionIntentDescriptorForVersion(intent.v).dismiss(event);
  if (intent.v === 7) {
    witnessReview.value = null;
    witnessReviewStatus.value = null;
  }
}

function reviewIntentBusy(intent: AcceptedIntentReview): boolean {
  return actionIntentDescriptorForVersion(intent.v).busy();
}

function reviewIntentSubmitting(intent: AcceptedIntentReview): boolean {
  return actionIntentDescriptorForVersion(intent.v).signing(intent);
}

function reviewIntentAllowed(intent: AcceptedIntentReview): boolean {
  return actionIntentDescriptorForVersion(intent.v).allowed(intent);
}

function clearActionIntents() {
  pendingActionIntent.value = null;
  pendingActionIntentStatus.value = null;
  witnessReview.value = null;
  witnessReviewStatus.value = null;
  for (const descriptor of actionIntentDescriptors) descriptor.clear();
  activeActionIntentStatusSlot.value = null;
}

async function prepareAcceptedWitnessIntent(intent: ActionIntentForVersion<7>) {
  witnessReview.value = null;
  witnessReviewStatus.value = null;
  const loaded = await loadTownshipWitnessReview({ replica: intent.replica });
  if (actionIntentDescriptorForSlot("witness").accepted()?.id !== intent.id) return;
  if (!loaded.ok) {
    witnessReviewStatus.value = { ok: false, message: loaded.message };
    return;
  }

  witnessReview.value = loaded.review;
  await nextTick();
  await traceWitnessReviewDom(intent.id, loaded.review);
}

async function submitAcceptedWitnessIntent(intent: ActionIntentForVersion<7>) {
  const priorReview = witnessReview.value;
  if (!priorReview) {
    return {
      ok: false,
      message: "Witness signing is unavailable until verified recovery details are ready.",
    };
  }

  const submitted = await submitTownshipWitnessArtifact({
    replica: intent.replica,
    priorReview,
  });
  if (!submitted.ok) return submitted;

  await hydrateTownshipWitnessArtifacts(submitted.artifactId);
  witnessExportStatus.value = {
    ok: true,
    message: "Witness artifact signed and retained on this device until explicit export.",
  };
  return { ok: true, message: "Witness artifact signed and retained." };
}

async function exportSelectedWitnessArtifact(event: Event) {
  const artifact = selectedWitnessArtifact.value;
  if (!artifact) {
    witnessExportStatus.value = { ok: false, message: "No stored witness artifact is available." };
    traceWitnessExportFailure("no-artifact");
    return;
  }

  const exported = await exportTownshipWitnessArtifact({ artifactId: artifact.artifactId, event });
  if (!exported.ok) {
    witnessExportStatus.value = { ok: false, message: exported.message };
    traceWitnessExportFailure(`load:${exported.reason}`);
    return;
  }

  // Older WebKit builds reject the async clipboard API with NotAllowedError
  // once the packaged CSP applies, so fall back to the constrained native
  // clipboard sink (which re-reads the stored artifact by id) before failing.
  try {
    await navigator.clipboard.writeText(exported.artifactJson);
  } catch (clipboardError) {
    try {
      await copyTownshipWitnessArtifactNative(artifact.artifactId);
    } catch {
      witnessExportStatus.value = { ok: false, message: "The witness artifact could not be copied." };
      traceWitnessExportFailure(
        `clipboard:${clipboardError instanceof Error ? clipboardError.name : typeof clipboardError}`,
      );
      return;
    }
  }

  witnessExportStatus.value = {
    ok: true,
    message: `${exported.fileName} copied. Keep it with the full confirmation below.`,
  };
  if (devTraceRuntime) void traceTownshipDevEvent("witness-artifact-export:succeeded").catch(() => {});
}

// Byte-free export failure evidence: reason codes and error names only, so a
// blocked export fails closed and loudly instead of silently timing out.
function traceWitnessExportFailure(code: string) {
  if (devTraceRuntime) {
    void traceTownshipDevEvent(`witness-artifact-export:failed:${code}`).catch(() => {});
  }
}

async function traceWitnessReviewDom(intentId: string, review: WitnessedSuccessionReview) {
  if (!devTraceRuntime) return;
  const detailDigests = await Promise.all(witnessReviewDetails(review).map(digestTownshipTraceText));
  await traceTownshipDevEvent(
    `witness-review-dom:${JSON.stringify({ intentId, detailDigests })}`,
  );
}

async function traceWitnessArtifactDom() {
  if (!devTraceRuntime) return;
  const confirmationDigests = await Promise.all(
    witnessArtifactConfirmation.value.map(digestTownshipTraceText),
  );
  await traceTownshipDevEvent(
    `witness-artifact-dom:${JSON.stringify({
      artifactId: selectedWitnessArtifactId.value,
      storedCount: storedWitnessArtifacts.value.length,
      confirmationDigests,
    })}`,
  );
}

function witnessReviewDetails(review: WitnessedSuccessionReview): string[] {
  return [
    ...witnessReviewIdentityDetails(review),
    `Verified frontier: ${review.verifiedFrontier.join(", ")}`,
  ];
}

function witnessReviewIdentityDetails(review: WitnessedSuccessionReview): string[] {
  return [
    `Replica: ${review.claim.replica}`,
    `Role: ${review.claim.role}`,
    `Holder: ${review.claim.holder}`,
    `Holder epoch: ${review.claim.holderEpoch}`,
    `Successor: ${review.claim.successor}`,
    `Policy ID: ${review.claim.policyId}`,
    `Winning policy genesis operation ID: ${review.policyGenesisOperationId}`,
    `Witness key: ${review.witness}`,
    `Threshold: ${review.threshold}`,
  ];
}

function isAcceptedIntentReview(
  intent: TownshipReviewableActionIntent | null,
): intent is AcceptedIntentReview {
  return intent !== null && intent.v !== 1;
}

function actionIntentDescriptorForSlot(slot: ActionIntentSlot) {
  const descriptor = actionIntentDescriptors.find((candidate) => candidate.slot === slot);
  if (!descriptor) throw new Error(`Unsupported action intent slot: ${slot}`);
  return descriptor;
}

function actionIntentDescriptorForVersion(
  version: TownshipReviewableActionIntent["v"],
) {
  const descriptor = actionIntentDescriptors.find((candidate) => candidate.version === version);
  if (!descriptor) throw new Error(`Unsupported action intent version: ${version}`);
  return descriptor;
}

function currentActionIntentReplica(): string | null {
  return carrierPeer.value?.replica ?? null;
}

function selectActionIntentStatus(slot: ActionIntentStatusSlot) {
  activeActionIntentStatusSlot.value = slot;
}

function setPendingActionIntentStatus(status: ActionIntentStatus) {
  pendingActionIntentStatus.value = status;
  selectActionIntentStatus("pending");
}

function statusForActionIntentSlot(slot: ActionIntentStatusSlot | null): ActionIntentStatus | null {
  if (slot === "pending") return pendingActionIntentStatus.value;
  return slot === null ? null : actionIntentDescriptorForSlot(slot).status();
}

function routeOtherParticipantDeepLink(value: string) {
  if (handleDevTraceControlDeepLink(value)) return;
  if (parseTownshipCanonicalProbeDeepLink(value) !== null) return;

  void tracePairingDeepLinkUrls([value]);
  const parse = parseTownshipPairingDeepLink(value);
  const consumption = consumePairingDeepLinkImport(parse);

  if (!consumption.ok) {
    handleBlockedPairingDeepLink({ reason: consumption.reason, parse });
    return;
  }

  applyPairingDeepLink(parse);
}

function isAndroidTauriShell(): boolean {
  return isTauri() && /Android/i.test(navigator.userAgent);
}

function handleDevTraceControlDeepLink(value: string): boolean {
  if (!devTraceRuntime || !devTraceRuntimeReady.value) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "township:" || url.hostname !== "dev") return false;

  const route = url.pathname.replace(/^\/+/, "");
  if (route === "pairing-import/arm") {
    armPairingDeepLinkImport();
    return true;
  }
  if (route === "carrier-health/check") {
    void checkCarrierHealth();
    return true;
  }
  if (route === "action-intent/submit") {
    void submitPendingPostIntentFromDevTrace();
    return true;
  }
  const actionRoute = parseActionIntentDevRoute(route);
  if (actionRoute) {
    if (actionRoute.step === "use") void usePendingActionIntentFromDevTrace(actionRoute.slot);
    else void signAcceptedActionIntentFromDevTrace(actionRoute.slot);
    return true;
  }
  if (route === "carrier/sync") {
    void syncStatusIntentFromDevTrace();
    return true;
  }

  return false;
}

async function submitPendingPostIntentFromDevTrace() {
  if (postSubmitting.value || syncSubmitting.value) return;

  const intent = pendingActionIntent.value;
  if (!intent || intent.v !== 1) {
    await traceActionIntentDevSubmit("missing");
    return;
  }

  acceptPendingActionIntent();
  if (postActionIntent.accepted()?.id !== intent.id) {
    await traceActionIntentDevSubmit("rejected");
    return;
  }

  await submitPost();
  if (!postStatus.value?.ok) {
    await traceActionIntentDevSubmit("author-failed");
    return;
  }

  await syncOutbox();
  await traceActionIntentDevSubmit(syncStatus.value?.ok ? "synced" : "sync-failed");
}

async function traceActionIntentDevSubmit(outcome: string): Promise<void> {
  try {
    await traceTownshipDevEvent(`action-intent-dev-submit:${outcome}`);
  } catch {
    // Test-only observability must not change the production action functions.
  }
}

async function usePendingActionIntentFromDevTrace(slot: ActionIntentSlot) {
  const descriptor = actionIntentDescriptorForSlot(slot);
  const intent = pendingActionIntent.value;
  if (!intent || intent.v !== descriptor.version) {
    await traceActionIntentDevControl(slot, "use", "missing");
    return;
  }

  acceptPendingActionIntent();
  await traceActionIntentDevControl(
    slot,
    "use",
    descriptor.accepted()?.id === intent.id ? "accepted" : "rejected",
  );
}

async function signAcceptedActionIntentFromDevTrace(slot: ActionIntentSlot) {
  const descriptor = actionIntentDescriptorForSlot(slot);
  if (descriptor.busy()) return;

  const intent = descriptor.accepted();
  if (!intent) {
    await traceActionIntentDevControl(slot, "sign", "missing");
    return;
  }
  if (!descriptor.allowed(intent)) {
    await traceActionIntentDevControl(slot, "sign", "blocked");
    return;
  }

  const outcome = await descriptor.sign();
  await traceActionIntentDevControl(slot, "sign", outcome === "signed" ? "signed" : "failed");
}

async function syncStatusIntentFromDevTrace() {
  if (syncSubmitting.value) return;

  await syncOutbox();
  const outcome = syncStatus.value?.ok ? "synced" : "failed";
  for (const { slot } of actionIntentDescriptors) {
    await traceActionIntentDevControl(slot, "sync", outcome);
  }
}

async function traceActionIntentDevControl(slot: ActionIntentSlot, step: string, outcome: string): Promise<void> {
  try {
    await traceTownshipDevEvent(actionIntentDevTraceEvent(slot, step, outcome));
  } catch {
    // Test-only observability must not change the production action functions.
  }
}

async function tracePairingDeepLinkUrls(urls: readonly string[] | null): Promise<void> {
  if (!urls) return;
  for (const url of urls) {
    try {
      await traceTownshipDevEvent(`deep-link:${url}`);
    } catch {
      // Development trace is optional and must not block pairing.
    }
  }
}

function applyPairingDeepLink(imported: TownshipPairingDeepLinkParse) {
  if (!imported.ok) {
    pairingStatus.value = { ok: false, message: imported.message };
    return;
  }

  pairingDraft.value = {
    ...pairingDraft.value,
    ...imported.draft,
  };
  pairingHandoffDraft.value = imported.handoff;
  pairingHandoffFingerprint.value = imported.peerFingerprint;
  pairingQrSvg.value = null;
  markImportedPairingDraft("deep_link");
  void tracePairingLinkLoaded(imported.peerFingerprint);
  pairingStatus.value = { ok: true, message: "Pairing link loaded; save before sync." };
}

async function tracePairingLinkLoaded(peerFingerprint: string): Promise<void> {
  try {
    await traceTownshipDevEvent(`pairing-link-loaded:${peerFingerprint}`);
    await traceTownshipDevEvent(TOWNSHIP_TRACE_PAIRING_LINK_LOAD_SETTLED);
  } catch {
    // Development trace is optional and must not block pairing.
  }
}

async function importPairingQrImage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  pairingQrImporting.value = true;
  try {
    const decoded = await decodePairingQrImageFile(file);
    if (decoded.ok) {
      pairingDraft.value = {
        ...pairingDraft.value,
        ...decoded.draft,
      };
      pairingHandoffDraft.value = decoded.handoff;
      pairingHandoffFingerprint.value = decoded.peerFingerprint;
      pairingQrSvg.value = null;
      markImportedPairingDraft("qr_image");
      pairingQrImageStatus.value = { ok: true, message: "Pairing QR image loaded; save before sync." };
    } else {
      pairingQrImageStatus.value = { ok: false, message: decoded.message };
    }
  } catch {
    pairingQrImageStatus.value = { ok: false, message: "Load an image containing a Township pairing QR." };
  } finally {
    pairingQrImporting.value = false;
    input.value = "";
  }
}

async function startPairingQrCamera() {
  if (pairingCameraScanner !== null) return;

  pairingCameraScanning.value = true;
  try {
    pairingCameraScanner = await createTownshipPairingQrCameraScanner({
      source: createBrowserPairingQrCameraSource(),
      apply: applyPairingQrCameraCapture,
    });
    pairingCameraStatus.value = { ok: true, message: "Camera ready; waiting for Township pairing QR." };
  } catch {
    pairingCameraScanner = null;
    pairingCameraScanning.value = false;
    pairingCameraStatus.value = { ok: false, message: "Camera unavailable; load a QR image instead." };
  }
}

function stopPairingQrCamera() {
  pairingCameraScanner?.stop();
  pairingCameraScanner = null;
  pairingCameraScanning.value = false;
}

function applyPairingQrCameraCapture(decoded: TownshipPairingQrDecode) {
  if (!decoded.ok) {
    pairingCameraStatus.value = { ok: false, message: decoded.message };
    stopPairingQrCamera();
    return;
  }

  pairingDraft.value = {
    ...pairingDraft.value,
    ...decoded.draft,
  };
  pairingHandoffDraft.value = decoded.handoff;
  pairingHandoffFingerprint.value = decoded.peerFingerprint;
  pairingQrSvg.value = null;
  markImportedPairingDraft("qr_camera");
  pairingCameraStatus.value = { ok: true, message: "Pairing camera loaded; save before sync." };
  stopPairingQrCamera();
}

async function startPairingDiscovery() {
  if (pairingDiscovery !== null) return;

  pairingDiscoveryRunning.value = true;
  pairingDiscoveryCandidate.value = null;
  const preferNativeDiscovery = tauriNativeRuntimeAvailable();
  try {
    pairingDiscovery = await createTownshipPairingDiscovery({
      source: preferNativeDiscovery ? createTauriPairingDiscoverySource() : createBrowserPairingDiscoverySource(),
      apply: applyPairingDiscoveryResult,
    });
    pairingDiscoveryStatus.value = { ok: true, message: "Discovery running; waiting for public pairing handoff." };
  } catch {
    if (preferNativeDiscovery) {
      try {
        pairingDiscovery = await createTownshipPairingDiscovery({
          source: createBrowserPairingDiscoverySource(),
          apply: applyPairingDiscoveryResult,
        });
        pairingDiscoveryStatus.value = { ok: true, message: "Discovery running; waiting for public pairing handoff." };
        return;
      } catch {
        pairingDiscovery = null;
      }
    }
    pairingDiscovery = null;
    pairingDiscoveryRunning.value = false;
    pairingDiscoveryStatus.value = { ok: false, message: "Discovery unavailable; load a handoff or QR instead." };
  }
}

function stopPairingDiscovery() {
  pairingDiscovery?.stop();
  pairingDiscovery = null;
  pairingDiscoveryRunning.value = false;
}

function applyPairingDiscoveryResult(result: TownshipPairingDiscoveryResult) {
  if (!result.ok) {
    pairingDiscoveryStatus.value = { ok: false, message: result.message };
    return;
  }

  pairingDiscoveryCandidate.value = result;
  pairingDiscoveryStatus.value = { ok: true, message: "Discovered public pairing handoff; verify before loading." };
}

function loadDiscoveredPairing() {
  const candidate = pairingDiscoveryCandidate.value;
  if (candidate === null) {
    pairingDiscoveryStatus.value = { ok: false, message: "Start discovery before loading a handoff." };
    return;
  }

  pairingDraft.value = {
    ...pairingDraft.value,
    ...candidate.draft,
  };
  pairingHandoffDraft.value = candidate.handoff;
  pairingHandoffFingerprint.value = candidate.peerFingerprint;
  pairingQrSvg.value = null;
  markImportedPairingDraft("discovery");
  pairingDiscoveryStatus.value = { ok: true, message: "Discovered pairing loaded; save before sync." };
}

async function advertisePairingHandoff() {
  if (carrierPeer.value === null) {
    pairingAdvertiseStatus.value = { ok: false, message: "Save a carrier pairing before advertising a handoff." };
    return;
  }

  pairingAdvertiseSubmitting.value = true;
  try {
    const handoff = exportTownshipCarrierPairingHandoff(carrierPeer.value);
    const label = `${carrierPeer.value.expectedPeerRealm} carrier`;
    pairingHandoffDraft.value = handoff;
    pairingHandoffFingerprint.value = townshipCarrierPeerFingerprint(carrierPeer.value.expectedPeerPubkey);
    const qr = renderTownshipPairingQrSvg(handoff);
    pairingQrSvg.value = qr.ok ? qr.svg : null;

    if (tauriNativeRuntimeAvailable()) {
      await advertiseTauriPairingHandoff({ handoff, label });
    } else {
      advertiseBrowserPairingHandoff({ handoff, label });
    }

    pairingAdvertiseStatus.value = {
      ok: true,
      message: "Public pairing handoff advertised; verify peer fingerprint before saving on another device.",
    };
  } catch {
    pairingAdvertiseStatus.value = {
      ok: false,
      message: "Pairing advertisement unavailable; share the handoff or QR instead.",
    };
  } finally {
    pairingAdvertiseSubmitting.value = false;
  }
}

async function checkCarrierHealth() {
  healthSubmitting.value = true;
  void traceTownshipDevEvent(TOWNSHIP_TRACE_CARRIER_HEALTH_STARTED).catch(() => {});
  healthStatus.value = await checkTownshipCarrierPeerHealth(carrierPeer.value ? { peer: carrierPeer.value } : {});
  healthSubmitting.value = false;
}

function truthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function tauriDeepLinkRuntimeAvailable(): boolean {
  return tauriNativeRuntimeAvailable();
}

function tauriNativeRuntimeAvailable(): boolean {
  return nativeStatus.value.ready || isTauri();
}

function revokeFrameCount(count: number): string {
  return `${count} revoke frame${count === 1 ? "" : "s"}`;
}

function revokedCapCommandCount(count: number): string {
  return `${count} revoked-cap command${count === 1 ? "" : "s"}`;
}

function blockedCommandCount(count: number): string {
  return `${count} blocked command${count === 1 ? "" : "s"}`;
}

function revokedCapabilityAttributionMessage(
  count: number,
  firstDelegationId: string,
  unattributedCount: number,
): string {
  const unattributedSuffix =
    unattributedCount > 0 ? `; ${unattributedCount} more blocked by local verification.` : ".";

  if (count === 1) {
    return `${blockedCommandCount(count)} cited delegation ${shortId(firstDelegationId)}; local verification classified it as revoked-capability${unattributedSuffix}`;
  }

  return `${blockedCommandCount(count)} cited delegations; local verification classified them as revoked-capability, including ${shortId(firstDelegationId)}${unattributedSuffix}`;
}

function shortId(id: string): string {
  return `${id.slice(0, 10)}...`;
}

function pairingDraftFromConfig(config: TownshipCarrierPeerConfig | null): TownshipCarrierPeerConfigInput {
  if (config === null) {
    return {
      url: "",
      localRealm: "",
      expectedPeerRealm: "",
      expectedPeerPubkey: "",
      submission: "push",
      keyId: TOWNSHIP_NATIVE_KEY_ID,
    };
  }

  return {
    url: config.url,
    localRealm: config.localRealm,
    expectedPeerRealm: config.expectedPeerRealm,
    expectedPeerPubkey: config.expectedPeerPubkey,
    replica: config.replica,
    submission: config.submission ?? "push",
    keyId: config.keyId ?? TOWNSHIP_NATIVE_KEY_ID,
  };
}

function pairingQrSvgFromConfig(config: TownshipCarrierPeerConfig): string | null {
  const qr = renderTownshipPairingQrSvg(exportTownshipCarrierPairingHandoff(config));
  return qr.ok ? qr.svg : null;
}

function importPairingIngress(value: string): TownshipPairingDeepLinkParse {
  const deepLink = parseTownshipPairingDeepLink(value);
  // Raw handoffs start with "township-pairing:", so only township: URLs short-circuit here.
  if (deepLink.ok || value.trim().startsWith("township:")) return deepLink;

  const imported = importTownshipCarrierPairingHandoff(value);
  if (!imported.ok) {
    return {
      ok: false,
      reason: imported.errors[0] ?? "invalid_pairing_format",
      message: imported.message,
    };
  }

  return {
    ok: true,
    handoff: value,
    state: null,
    draft: imported.draft,
    peerFingerprint: imported.peerFingerprint,
  };
}

async function decodePairingQrImageFile(file: File): Promise<TownshipPairingQrDecode> {
  const image = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return {
        ok: false,
        reason: "invalid_pairing_qr",
        message: "Load an image containing a Township pairing QR.",
      };
    }

    context.drawImage(image, 0, 0);
    const imageData = context.getImageData(0, 0, image.width, image.height);
    return decodeTownshipPairingQrImageData(imageData.data, imageData.width, imageData.height);
  } finally {
    image.close();
  }
}

function createBrowserPairingQrCameraSource(): TownshipPairingQrCameraSource {
  return {
    async start(onFrame: (frame: TownshipPairingQrCameraFrame) => void): Promise<() => void> {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("camera unavailable");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "environment" },
      });
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();

      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("camera canvas unavailable");
      }

      let animationFrame = 0;
      const capture = () => {
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (width > 0 && height > 0) {
          canvas.width = width;
          canvas.height = height;
          context.drawImage(video, 0, 0, width, height);
          const imageData = context.getImageData(0, 0, width, height);
          onFrame({ data: imageData.data, width: imageData.width, height: imageData.height });
        }
        animationFrame = window.requestAnimationFrame(capture);
      };

      animationFrame = window.requestAnimationFrame(capture);

      return () => {
        if (animationFrame !== 0) window.cancelAnimationFrame(animationFrame);
        video.pause();
        video.srcObject = null;
        stream.getTracks().forEach((track) => track.stop());
      };
    },
  };
}

function createBrowserPairingDiscoverySource(): TownshipPairingDiscoverySource {
  return {
    async start(onAdvert: (advert: TownshipPairingDiscoveryAdvert) => void): Promise<() => void> {
      if (typeof BroadcastChannel === "undefined") {
        throw new Error("discovery unavailable");
      }

      const channel = new BroadcastChannel("township-pairing-discovery");
      const onMessage = (event: MessageEvent<unknown>) => {
        const advert = pairingDiscoveryAdvertFromMessage(event.data);
        if (advert) onAdvert(advert);
      };
      channel.addEventListener("message", onMessage);

      return () => {
        channel.removeEventListener("message", onMessage);
        channel.close();
      };
    },
  };
}

function advertiseBrowserPairingHandoff(advert: TownshipPairingDiscoveryAdvert) {
  if (typeof BroadcastChannel === "undefined") {
    throw new Error("discovery unavailable");
  }

  const channel = new BroadcastChannel("township-pairing-discovery");
  try {
    channel.postMessage({
      type: "township-pairing-discovery",
      label: advert.label,
      handoff: advert.handoff,
    });
  } finally {
    channel.close();
  }
}

function pairingDiscoveryAdvertFromMessage(value: unknown): TownshipPairingDiscoveryAdvert | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "township-pairing-discovery") return null;
  if (typeof record.handoff !== "string") return null;
  return {
    label: typeof record.label === "string" ? record.label : undefined,
    handoff: record.handoff,
  };
}
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">Township</p>
        <h1 id="matter-title">{{ matter.title }}</h1>
      </div>
      <div class="status-stack">
        <div
          id="matter-render-status"
          class="status-strip"
          :data-state="matter.status.toLowerCase()"
          :data-op-count="matter.opCount"
          :data-post-count="matter.posts.length"
        >
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
        <p id="matter-summary" class="summary">{{ matter.summary }}</p>
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

      <aside id="township-roster" class="roster-panel">
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
          <button type="submit" :disabled="revokeSubmitting || revokeIntentSubmitting || revokeDelegationDraft.trim().length === 0">
            {{ revokeSubmitting || revokeIntentSubmitting ? "Signing" : "Revoke access" }}
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

    <section v-if="pendingActionIntent" id="participant-action-request" class="incoming-action-panel" aria-live="polite">
      <div class="panel-heading">
        <p>{{ actionIntentLabel(pendingActionIntent) }}</p>
        <span>Unsigned browser handoff</span>
      </div>
      <p v-if="pendingActionIntent.v === 1 || pendingActionIntent.v === 3" class="incoming-action-text">{{ pendingActionIntent.command.text }}</p>
      <p v-if="pendingActionIntent.v === 4" class="incoming-action-text">{{ pendingActionIntent.command.member }}</p>
      <p v-if="pendingActionIntent.v === 6" class="incoming-action-text">{{ pendingActionIntent.authority.delegation }}</p>
      <p v-if="pendingActionIntent.v === 7" class="incoming-action-text">Requested role: {{ pendingActionIntent.authority.role }}</p>
      <div class="incoming-action-controls">
        <button type="button" @click="acceptPendingActionIntent">Use request</button>
        <button type="button" class="secondary-action" @click="dismissPendingActionIntent">Dismiss</button>
      </div>
    </section>

    <IntentReviewPanel
      v-for="intent in acceptedIntentReviews"
      :key="`${intent.v}:${intent.id}`"
      :intent="intent"
      :busy="reviewIntentBusy(intent)"
      :submitting="reviewIntentSubmitting(intent)"
      :allowed="reviewIntentAllowed(intent)"
      :witness-review="intent.v === 7 ? witnessReview : null"
      @sign="signAcceptedIntent(intent, $event)"
      @dismiss="dismissAcceptedIntent(intent, $event)"
    />

    <p
      v-if="witnessReviewStatus"
      id="witness-review-status"
      class="post-message"
      :data-state="witnessReviewStatus.ok ? 'success' : 'author_failed'"
      aria-live="polite"
    >
      {{ witnessReviewStatus.message }}
    </p>

    <section
      v-if="selectedWitnessArtifact"
      id="participant-witness-artifact"
      class="incoming-action-panel"
      aria-live="polite"
    >
      <div class="panel-heading">
        <p>Witness artifact ready to export</p>
        <span>{{ storedWitnessArtifacts.length }} retained on this device</span>
      </div>
      <label for="witness-artifact-selection">Retained artifact</label>
      <select
        id="witness-artifact-selection"
        v-model="selectedWitnessArtifactId"
        aria-label="Retained witness artifact"
        @change="witnessExportStatus = null"
      >
        <option
          v-for="artifact in storedWitnessArtifacts"
          :key="artifact.artifactId"
          :value="artifact.artifactId"
        >
          {{ artifact.artifactId }}
        </option>
      </select>
      <p
        v-for="confirmation in witnessArtifactConfirmation"
        :key="confirmation"
        class="incoming-action-text"
      >
        {{ confirmation }}
      </p>
      <p
        v-if="witnessExportStatus"
        class="post-message"
        :data-state="witnessExportStatus.ok ? 'success' : 'author_failed'"
      >
        {{ witnessExportStatus.message }}
      </p>
      <div class="incoming-action-controls">
        <button type="button" @click="exportSelectedWitnessArtifact">Copy trusted export</button>
      </div>
    </section>

    <section class="compose-panel">
      <div class="panel-heading">
        <p>Post update</p>
        <span>Signed local action</span>
      </div>
      <p v-if="actionIntentStatus" class="post-message" :data-state="actionIntentStatus.ok ? 'success' : 'author_failed'" aria-live="polite">
        {{ actionIntentStatus.message }}
      </p>
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
        <select
          v-model="pairingDraft.submission"
          aria-label="Carrier submission"
          @change="clearPairingSaveConfirmation"
        >
          <option value="push">Generic push</option>
          <option value="relay">One-op relay</option>
        </select>
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
        <p
          id="carrier-feed-status"
          class="sync-message"
          :data-state="feedState.phase"
          :data-phase="feedState.phase"
          :data-generation="feedState.projection?.generation ?? ''"
          :data-op-count="feedState.projection?.matter.opCount ?? ''"
          :data-post-count="feedState.projection?.matter.posts.length ?? ''"
          aria-live="polite"
        >
          {{ feedState.message }}
        </p>
        <p class="sync-message" :data-state="healthStatusTone">{{ healthStatusMessage }}</p>
        <button type="button" :disabled="healthSubmitting" @click="checkCarrierHealth">
          {{ healthSubmitting ? "Checking" : "Check carrier" }}
        </button>
        <p id="carrier-sync-status" class="sync-message" :data-state="syncStatusTone">
          {{ syncStatusMessage }}
        </p>
        <button type="button" :disabled="syncSubmitting" @click="syncOutbox">
          {{ syncSubmitting ? "Syncing" : "Sync outbox" }}
        </button>
      </div>
    </section>

    <section id="township-proceedings" class="posts-panel">
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
