// @treetopdevs/lattice-client — a framework-agnostic TypeScript realm.
//
// This is the client half of a Lattice realm: it stores an op-DAG, reduces it
// to replica state (byte-for-byte the same result Elixir's Sim produces), and
// reconciles with a peer over the carrier. It is UI-framework-neutral on
// purpose — the Tauri (Vue 3.5) and Expo (React Native) shells both consume it.
//
// Tier A (available now, conformance-tested against Sim): op model, DAG,
// CRDT reduction, the shared quarantine predicate, materialization, sync.
// Tier B/E1: canonical encoding, op hashing/signature verification, and
// shell bridge seams — see codec.ts / identity.ts / tauri_bridge.ts.

export * from "./op";
export * from "./schema";
export * from "./dag";
export * from "./quarantine";
export * from "./capability";
export * from "./consent";
export * from "./policy";
// Keep the unauthenticating application predicate internal to the module graph.
export {
  resolveContinuationProfileFromFrames, analyzeAuthority, continuationFamily, deriveContinuationReview,
  deriveWitnessedSuccessionReview, assembleWitnessedSuccessionArtifact, exportWitnessedSuccessionArtifactJson,
  witnessedRecoveryPolicyId, verifyWitnessedSuccessionCertificate, witnessedBeaconHorizon,
} from "./authority";
export type {
  ContinuationProfileObservation, HonoredAcquire, DelegationValidation, AuthorityDelegationRecord,
  AuthorityRootEvidence, EffectiveBeaconEvidence, EffectiveRevokeEvidence, AuthoritySecurityProjection,
  RecoveryPolicyProjection, AuthorityAnalysis, WitnessedSuccessionReviewSelector, WitnessedSuccessionReview,
  WitnessedSuccessionReviewRefusal, WitnessedSuccessionReviewResult, ContinuationFamily,
  WitnessedSuccessionVerificationReason, WitnessedSuccessionVerification,
} from "./authority";
export * from "./crdt/reducers";
export * from "./materialize";
export * from "./sync";
export * from "./carrier";
export * from "./codec";
export * from "./continuation";
export * from "./continuation_authoring";
export * from "./identity";
export * from "./local_log";
export * from "./tauri_bridge";
export * from "./township";
export * from "./treehouse";

export { deriveTreehouseCatalogCutoff } from "./treehouse_catalog_cutoff";
export type { TreehouseCatalogCutoffInput, TreehouseCatalogCutoffResult, TreehouseCutoffOp, TreehouseCutoffRejectedOp } from "./treehouse_catalog_cutoff";

// Decisions are pure candidates; only a trusted adapter can establish installation.
export {
  prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust, resolveTreehouseCatalogRoute,
} from "./treehouse_catalog_trust";
export type {
  TreehouseCatalogRawHistory, TreehouseCatalogBootstrapReview, TreehouseCatalogCutoffProof,
  TreehouseCatalogEvidencePage, TreehouseCatalogStoreToken, TreehouseCatalogWatermark,
  TreehouseCatalogOverflowTrigger, TreehouseCatalogBlock, InstalledTreehouseCatalogTrustV1,
  TreehouseCatalogTrustReason, TreehouseCatalogRefusalDetail, VerifiedTreehouseCatalogRoute,
  TreehouseCatalogTrustDecision, TreehouseCatalogRouteDecision,
} from "./treehouse_catalog_trust";

// Cryptographic codec utilities only; these do not admit a member or activate a command.
export * from "./treehouse_member_continuity_codec";

// Authenticated complete-history continuity APIs; attestation grants no membership or rights.
export { observeMemberContinuityFromFrames, reviewMemberContinuityFromFrames, assembleMemberContinuityFromFrames } from "./treehouse_member_continuity";
export type { MemberContinuityObservation, MemberContinuityReviewRequest, MemberContinuityReview, MemberContinuityReviewResult, MemberContinuityAssemblyResult } from "./treehouse_member_continuity";
