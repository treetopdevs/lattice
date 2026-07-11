import { isTauri } from "@tauri-apps/api/core";
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  createTownshipNativeStorage,
  loadTownshipNativeStatus,
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
  loadTownshipActionAvailability,
  submitTownshipDelegation,
  submitTownshipRevocation,
  submitTownshipCommand,
  submitTownshipPost,
  type TownshipActionAvailability,
  type TownshipCommandName,
  type TownshipDelegationSubmission,
  type TownshipRevocationSubmission,
  type TownshipCommandSubmission,
  type TownshipPostSubmission,
} from "./township_actions";
import { townshipPreview } from "./township_preview";
import {
  checkTownshipCarrierPeerHealth,
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
  createOneShotTownshipPairingDeepLinkGate,
  createTownshipPairingDeepLinkListener,
  parseTownshipPairingDeepLink,
  type TownshipPairingDeepLinkBlocked,
  type TownshipPairingDeepLinkGateConsumption,
  type TownshipPairingDeepLinkListener,
  type TownshipPairingDeepLinkParse,
  type TownshipPairingDeepLinkSource,
} from "./township_pairing_deeplink";
import { createTauriPairingDeepLinkSource } from "./township_pairing_deeplink_source";
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
import { syncTownshipOutbox, type TownshipOutboxSync } from "./township_sync";

export interface TownshipSessionAdapters {
  initialCarrierPeer(): TownshipCarrierPeerConfig | null;
  runtimeIsTauri(): boolean;
  scheduleHydration(callback: () => Promise<void>, delayMs: number): () => void;
  createPairingDeepLinkSource: typeof createTauriPairingDeepLinkSource;
  createPairingDeepLinkListener: typeof createTownshipPairingDeepLinkListener;
  createCanonicalProbeDeepLinkListener: typeof createTownshipCanonicalProbeDeepLinkListener;
  createNativeStorage: typeof createTownshipNativeStorage;
  loadNativeStatus: typeof loadTownshipNativeStatus;
  loadActionAvailability: typeof loadTownshipActionAvailability;
  submitPost: typeof submitTownshipPost;
  submitCommand: typeof submitTownshipCommand;
  submitDelegation: typeof submitTownshipDelegation;
  submitRevocation: typeof submitTownshipRevocation;
  syncOutbox: typeof syncTownshipOutbox;
  loadPairing: typeof loadTownshipCarrierPeerConfig;
  savePairing: typeof saveTownshipCarrierPeerConfig;
  checkHealth: typeof checkTownshipCarrierPeerHealth;
}

export const defaultTownshipSessionAdapters: TownshipSessionAdapters = {
  initialCarrierPeer: () => townshipCarrierPeerFromEnv(),
  runtimeIsTauri: () => isTauri(),
  scheduleHydration: (callback, delayMs) => {
    const timer = window.setTimeout(() => void callback(), delayMs);
    return () => window.clearTimeout(timer);
  },
  createPairingDeepLinkSource: createTauriPairingDeepLinkSource,
  createPairingDeepLinkListener: createTownshipPairingDeepLinkListener,
  createCanonicalProbeDeepLinkListener: createTownshipCanonicalProbeDeepLinkListener,
  createNativeStorage: () => createTownshipNativeStorage(),
  loadNativeStatus: () => loadTownshipNativeStatus(),
  loadActionAvailability: () => loadTownshipActionAvailability(),
  submitPost: submitTownshipPost,
  submitCommand: submitTownshipCommand,
  submitDelegation: submitTownshipDelegation,
  submitRevocation: submitTownshipRevocation,
  syncOutbox: syncTownshipOutbox,
  loadPairing: loadTownshipCarrierPeerConfig,
  savePairing: saveTownshipCarrierPeerConfig,
  checkHealth: checkTownshipCarrierPeerHealth,
};

export function useTownshipSession(overrides: Partial<TownshipSessionAdapters> = {}) {
  const session = createTownshipSession(overrides);

  onMounted(async () => {
    await session.lifecycle.mount();
  });
  onUnmounted(() => {
    session.lifecycle.unmount();
  });

  return {
    view: session.view,
    command: session.command,
    pairing: session.pairing,
    connection: session.connection,
  };
}

export function createTownshipSession(overrides: Partial<TownshipSessionAdapters> = {}) {
  const adapters: TownshipSessionAdapters = {
    ...defaultTownshipSessionAdapters,
    ...overrides,
  };
  const env = ((import.meta as ImportMeta & { env?: ImportMetaEnv }).env ?? {});
  const matter = computed(() => townshipPreview());
  const carrierPeer = ref<TownshipCarrierPeerConfig | null>(adapters.initialCarrierPeer());
  const autosyncOnMount = truthy(env.VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT);
  const devTraceRuntime = truthy(env.VITE_TOWNSHIP_DEV_TRACE);
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
  const postSubmitting = ref(false);
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
  let pairingDeepLinkListener: TownshipPairingDeepLinkListener | null = null;
  let canonicalProbeDeepLinkListener: TownshipCanonicalProbeDeepLinkListener | null = null;
  let cancelNativeHydration: (() => void) | null = null;
  let pairingCameraScanner: TownshipPairingQrCameraScanner | null = null;
  let pairingDiscovery: TownshipPairingDiscovery | null = null;
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
        return `${revokedCapCommandCount(syncStatus.value.authorityRevokedCapabilityCount)} blocked by carrier authority.`;
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

  async function mount() {
    appUnmounted = false;
    const releasePairingProbeActive =
      isAndroidTauriShell() &&
      townshipReleasePairingProbeConfigFromEnv(env as TownshipReleasePairingProbeEnv) !== null;
    const releaseOnboardingProbeActive =
      isAndroidTauriShell() &&
      townshipReleaseOnboardingProbeConfigFromEnv(env as TownshipReleaseOnboardingProbeEnv & Record<string, string | undefined>) !==
        null;
    const releaseRootOriginationProbeActive =
      isAndroidTauriShell() &&
      townshipReleaseRootOriginationProbeConfigFromEnv(
        env as TownshipReleaseRootOriginationProbeEnv & Record<string, string | undefined>,
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
    if (!releasePairingProbeActive && !releaseOnboardingProbeActive && !releaseRootOriginationProbeActive) {
      await mountPairingDeepLinkListener();
      await mountCanonicalProbeDeepLinkListener();
    }
    if (devTraceRuntime) await mountDevTraceShortcut();
    await loadPairingConfig();
    if (autosyncOnMount && carrierPeer.value) await syncOutbox();
    if (devTraceRuntime) {
      const onboarding = await runTownshipPackagedOnboardingFromEnv(env);
      if (onboarding?.ok) {
        carrierPeer.value = onboarding.pairing;
        pairingDraft.value = pairingDraftFromConfig(onboarding.pairing);
        postStatus.value = onboarding.post;
        syncStatus.value = onboarding.finalSync;
      }
    }
    scheduleTownshipNativeHydration();
  }

  function unmount() {
    appUnmounted = true;
    cancelNativeHydration?.();
    cancelNativeHydration = null;
    if (devTraceShortcutMounted) window.removeEventListener("keydown", handleDevTraceShortcut);
    devTraceShortcutMounted = false;
    canonicalProbeDeepLinkListener?.stop();
    canonicalProbeDeepLinkListener = null;
    pairingDeepLinkListener?.stop();
    pairingDeepLinkListener = null;
    clearPairingDeepLinkImport();
    stopPairingQrCamera();
    stopPairingDiscovery();
  }

  async function submitPost() {
    postSubmitting.value = true;
    postStatus.value = await adapters.submitPost({ text: postDraft.value });
    if (postStatus.value.ok) postDraft.value = "";
    postSubmitting.value = false;
  }

  async function submitSummary() {
    summarySubmitting.value = true;
    summaryStatus.value = await adapters.submitCommand({
      command: { command: "set_summary", text: summaryDraft.value },
    });
    summarySubmitting.value = false;
  }

  async function submitMatterStatus(command: MatterStatusCommand) {
    statusSubmitting.value = command;
    statusStatus.value = await adapters.submitCommand({ command: { command } });
    statusSubmitting.value = null;
  }

  function statusActionAllowed(command: MatterStatusCommand): boolean {
    const availability = actionAvailability.value;
    return availability.ready && availability.commands[command].allowed;
  }

  async function submitMemberCommand(command: MemberCommand) {
    memberSubmitting.value = command;
    memberStatus.value = await adapters.submitCommand({
      command: { command, member: memberDraft.value },
    });
    if (memberStatus.value.ok) memberDraft.value = "";
    memberSubmitting.value = null;
  }

  function memberActionAllowed(command: MemberCommand): boolean {
    const availability = actionAvailability.value;
    return availability.ready && availability.commands[command].allowed;
  }

  async function submitGrant() {
    grantSubmitting.value = true;
    grantStatus.value = await adapters.submitDelegation({ audiencePubkey: grantAudienceDraft.value });
    if (grantStatus.value.ok) {
      grantAudienceDraft.value = "";
      actionAvailability.value = await adapters.loadActionAvailability();
    }
    grantSubmitting.value = false;
  }

  async function submitRevoke() {
    revokeSubmitting.value = true;
    revokeStatus.value = await adapters.submitRevocation({ delegationId: revokeDelegationDraft.value });
    if (revokeStatus.value.ok) {
      revokeDelegationDraft.value = "";
    }
    revokeSubmitting.value = false;
  }

  async function syncOutbox() {
    syncSubmitting.value = true;
    void traceTownshipDevEvent(TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED).catch(() => {});
    syncStatus.value = await adapters.syncOutbox(carrierPeer.value ? { peer: carrierPeer.value } : {});
    if (syncStatus.value.ok) actionAvailability.value = await adapters.loadActionAvailability();
    syncSubmitting.value = false;
  }

  async function loadPairingConfig() {
    try {
      const storage = adapters.createNativeStorage();
      carrierPeer.value = await adapters.loadPairing(storage);
      pairingDraft.value = pairingDraftFromConfig(carrierPeer.value);
      pairingQrSvg.value = carrierPeer.value ? pairingQrSvgFromConfig(carrierPeer.value) : null;
      resetPairingSaveState();
    } catch {
      carrierPeer.value = adapters.initialCarrierPeer();
      pairingDraft.value = pairingDraftFromConfig(carrierPeer.value);
      pairingQrSvg.value = carrierPeer.value ? pairingQrSvgFromConfig(carrierPeer.value) : null;
      resetPairingSaveState();
    }
  }

  function scheduleTownshipNativeHydration() {
    cancelNativeHydration?.();
    cancelNativeHydration = adapters.scheduleHydration(async () => {
      cancelNativeHydration = null;
      if (!appUnmounted) await hydrateTownshipNativeReadiness();
    }, 1_000);
  }

  async function hydrateTownshipNativeReadiness() {
    nativeStatus.value = await adapters.loadNativeStatus();
    actionAvailability.value = await adapters.loadActionAvailability();
    if (devTraceRuntime) void traceTownshipDevEvent("township-native-hydration-settled").catch(() => {});
  }

  async function submitPairing() {
    pairingSubmitting.value = true;
    void traceTownshipDevEvent(TOWNSHIP_TRACE_PAIRING_CONFIG_SAVE_SUBMITTED).catch(() => {});
    try {
      const storage = adapters.createNativeStorage();
      const saved = await adapters.savePairing(storage, pairingDraft.value, {
        origin: pairingDraftOrigin.value,
        confirmed: pairingSaveConfirmed.value,
      });
      if (saved.ok) {
        carrierPeer.value = saved.config;
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
    }
    pairingSubmitting.value = false;
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

  async function mountPairingDeepLinkListener() {
    if (pairingDeepLinkListener !== null) return;

    try {
      pairingDeepLinkListener = await adapters.createPairingDeepLinkListener({
        source: createTracingPairingDeepLinkSource(adapters.createPairingDeepLinkSource()),
        gate: {
          arm: () => {
            const state = pairingDeepLinkGate.arm();
            pairingDeepLinkImportState.value = state;
            return state;
          },
          disarm: clearPairingDeepLinkImport,
          armed: () => pairingDeepLinkGate.armed(),
          state: () => pairingDeepLinkGate.state(),
          consume: consumePairingDeepLinkImport,
        },
        apply: applyPairingDeepLink,
        onBlocked: handleBlockedPairingDeepLink,
      });
      void traceTownshipDevEvent("deep-link-listener-mounted").catch(() => {});
    } catch {
      pairingDeepLinkListener = null;
      void traceTownshipDevEvent("deep-link-listener-unavailable").catch(() => {});
    }
  }

  async function mountCanonicalProbeDeepLinkListener() {
    if (canonicalProbeDeepLinkListener !== null) return;

    try {
      canonicalProbeDeepLinkListener = await adapters.createCanonicalProbeDeepLinkListener({
        source: adapters.createPairingDeepLinkSource({ includeAndroidPairingIntent: false }),
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
      window.addEventListener("keydown", handleDevTraceShortcut);
      devTraceShortcutMounted = true;
    } catch {
      devTraceShortcutMounted = false;
    }
  }

  function handleDevTraceShortcut(event: KeyboardEvent) {
    const key = event.key.toLowerCase();
    void traceTownshipDevEvent(`${TOWNSHIP_TRACE_DEV_SHORTCUT_KEYDOWN_PREFIX}${key}`).catch(() => {});

    if (!event.isTrusted || !event.metaKey || !event.shiftKey || event.repeat) return;

    if (key !== "l" && key !== "h") return;

    event.preventDefault();
    if (key === "l") {
      armPairingDeepLinkImport(event);
    } else {
      void checkCarrierHealth();
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

  function createTracingPairingDeepLinkSource(source: TownshipPairingDeepLinkSource): TownshipPairingDeepLinkSource {
    return {
      async current(): Promise<readonly string[] | null> {
        const urls = await source.current();
        void tracePairingDeepLinkUrls(urls);
        const pairingUrls = await pairingDeepLinkUrls(urls);
        return pairingUrls.length > 0 ? pairingUrls : null;
      },
      async onOpenUrl(callback: (urls: readonly string[]) => void): Promise<(() => void) | void> {
        return source.onOpenUrl((urls) => {
          void tracePairingDeepLinkUrls(urls);
          void pairingDeepLinkUrls(urls).then((pairingUrls) => {
            if (pairingUrls.length > 0) callback(pairingUrls);
          });
        });
      },
    };
  }

  function isAndroidTauriShell(): boolean {
    return adapters.runtimeIsTauri() && /Android/i.test(navigator.userAgent);
  }

  async function pairingDeepLinkUrls(urls: readonly string[] | null): Promise<readonly string[]> {
    if (!urls) return [];

    const pairingUrls: string[] = [];
    for (const url of urls) {
      if (handleDevTraceControlDeepLink(url)) continue;
      if (parseTownshipCanonicalProbeDeepLink(url) !== null) continue;
      pairingUrls.push(url);
    }
    return pairingUrls;
  }

  function handleDevTraceControlDeepLink(value: string): boolean {
    if (!devTraceRuntime) return false;

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

    return false;
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
    healthStatus.value = await adapters.checkHealth(carrierPeer.value ? { peer: carrierPeer.value } : {});
    healthSubmitting.value = false;
  }

  function truthy(value: string | undefined): boolean {
    return value === "1" || value?.toLowerCase() === "true";
  }

  function tauriDeepLinkRuntimeAvailable(): boolean {
    return tauriNativeRuntimeAvailable();
  }

  function tauriNativeRuntimeAvailable(): boolean {
    return nativeStatus.value.ready || adapters.runtimeIsTauri();
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
      unattributedCount > 0 ? `; ${unattributedCount} more blocked by carrier authority.` : ".";

    if (count === 1) {
      return `${blockedCommandCount(count)} cited delegation ${shortId(firstDelegationId)} the carrier reports as revoked${unattributedSuffix}`;
    }

    return `${blockedCommandCount(count)} cited delegations the carrier reports as revoked, including ${shortId(firstDelegationId)}${unattributedSuffix}`;
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
        keyId: TOWNSHIP_NATIVE_KEY_ID,
      };
    }

    return {
      url: config.url,
      localRealm: config.localRealm,
      expectedPeerRealm: config.expectedPeerRealm,
      expectedPeerPubkey: config.expectedPeerPubkey,
      replica: config.replica,
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

  return {
    view: {
      matter,
      nativeStatus,
      actionAvailability,
      availableActions,
    },
    command: {
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
      submitPost,
      submitSummary,
      submitMatterStatus,
      statusActionAllowed,
      submitMemberCommand,
      memberActionAllowed,
      submitGrant,
      submitRevoke,
    },
    pairing: {
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
      pairingStatusMessage,
      pairingStatusTone,
      pairingSaveConfirmationRequired,
      pairingSaveConfirmationLabel,
      pairingSaveConfirmationDetail,
      pairingQrImageStatusTone,
      pairingCameraStatusTone,
      pairingDiscoveryStatusTone,
      pairingAdvertiseStatusTone,
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
    },
    connection: {
      carrierPeer,
      healthSubmitting,
      syncSubmitting,
      syncStatusMessage,
      syncStatusTone,
      healthStatusMessage,
      healthStatusTone,
      syncOutbox,
      checkCarrierHealth,
      syncStatus,
      healthStatus,
    },
    lifecycle: {
      mount,
      unmount,
      loadPairingConfig,
      hydrateTownshipNativeReadiness,
    },
  };
}
