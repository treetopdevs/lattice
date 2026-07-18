import {
  assembleWitnessedSuccessionArtifact,
  authorAndPersistTownshipDelegation,
  authorAndPersistTownshipCommand,
  authorTownshipRevocation,
  carrierDelegationsFromFrames,
  carrierOpsToSemanticOps,
  createJsonLocalOpLogStore,
  deriveWitnessedSuccessionReview,
  exportWitnessedSuccessionArtifactJson,
  frontier,
  selectTownshipCapId,
  type CarrierOpFrame,
  type WitnessedSuccessionArtifactEvidence,
  type WitnessedSuccessionClaimEvidence,
  type WitnessedSuccessionReview,
  type TownshipCommand,
} from "@treetopdevs/lattice-client";
import {
  createTownshipNativeStorage,
  createTownshipNativeWorkflow,
  loadGovernanceWitnessPublicKey,
  signGovernanceWitnessClaim,
  TOWNSHIP_LOCAL_OP_LOG_KEY,
  TOWNSHIP_STORAGE_NAMESPACE,
  verifyGovernanceWitnessSignature,
  type TownshipNativeWorkflow,
  type TownshipNativeWorkflowOptions,
  withTownshipPersistenceWrite,
} from "./native_workflow";
import { townshipMatterSchema } from "./township_preview";

export const TOWNSHIP_REPLICA = "replica:matter:township-g1#root:QUB7owpVIsZn3IyoVLJbsFc5HLkozhi2PVBL5Lzhj3w";
export const TOWNSHIP_REALM_BY_PUBKEY: Record<string, string> = {
  "OMlRmFPtU6VkYbKW3MiZG4Il++Eb+GmRJyiGcbUDfSQ=": "resident",
  "ux8h/x3NkAWj/ejlP3T15/89nMJMvweh2kYZqcXYYPM=": "clerk",
};

const TOWNSHIP_ACTION_COMMANDS = [
  { command: "set_title", text: "" },
  { command: "set_summary", text: "" },
  { command: "post", text: "" },
  { command: "admit", member: "" },
  { command: "remove_member", member: "" },
  { command: "close_matter" },
  { command: "reopen_matter" },
] as const satisfies readonly TownshipCommand[];

export type TownshipPostFailureReason =
  | "author_failed"
  | "empty_post"
  | "missing_delegation"
  | "native_unavailable";

export type TownshipCommandFailureReason =
  | "author_failed"
  | "empty_member"
  | "empty_text"
  | "missing_delegation"
  | "native_unavailable";

export type TownshipDelegationFailureReason =
  | "author_failed"
  | "empty_audience"
  | "invalid_audience"
  | "missing_delegation"
  | "native_unavailable";

export type TownshipRevocationFailureReason =
  | "author_failed"
  | "empty_delegation"
  | "missing_delegation"
  | "native_unavailable"
  | "not_issuer"
  | "replica_mismatch";

interface TownshipCommandOptions extends TownshipNativeWorkflowOptions {
  replica?: string;
  realmByPubkey?: Record<string, string>;
  workflow?: TownshipNativeWorkflow;
}

export interface SubmitTownshipCommandOptions extends TownshipCommandOptions {
  command: TownshipCommand;
}

export interface SubmitTownshipPostOptions extends TownshipCommandOptions {
  text: string;
}

export interface LoadTownshipActionAvailabilityOptions extends TownshipCommandOptions {}

export interface SubmitTownshipDelegationOptions extends TownshipCommandOptions {
  audiencePubkey: string;
  ops?: readonly string[];
  roles?: readonly string[];
  live?: boolean;
}

export interface SubmitTownshipRevocationOptions extends TownshipCommandOptions {
  delegationId: string;
}

export interface TownshipCommandSuccess {
  ok: true;
  command: TownshipCommand;
  opId: string;
  frameId: string;
  capId: string;
  localOpCount: number;
  carrierFrameCount: number;
}

export interface TownshipCommandFailure {
  ok: false;
  reason: TownshipCommandFailureReason;
  commandName: TownshipCommand["command"];
  message: string;
}

export interface TownshipPostSuccess {
  ok: true;
  text: string;
  opId: string;
  frameId: string;
  capId: string;
  localOpCount: number;
  carrierFrameCount: number;
}

export interface TownshipPostFailure {
  ok: false;
  reason: TownshipPostFailureReason;
  message: string;
}

export interface TownshipDelegationSuccess {
  ok: true;
  audiencePubkey: string;
  ops: string[];
  opId: string;
  frameId: string;
  delegationId: string;
  parentId: string | null;
  localOpCount: number;
  carrierFrameCount: number;
  delegationFrameCount: number;
}

export interface TownshipDelegationFailure {
  ok: false;
  reason: TownshipDelegationFailureReason;
  message: string;
}

export interface TownshipRevocationSuccess {
  ok: true;
  delegationId: string;
  opId: string;
  frameId: string;
  localOpCount: number;
  carrierFrameCount: number;
}

export interface TownshipRevocationFailure {
  ok: false;
  reason: TownshipRevocationFailureReason;
  message: string;
}

export type TownshipCommandSubmission = TownshipCommandSuccess | TownshipCommandFailure;
export type TownshipPostSubmission = TownshipPostSuccess | TownshipPostFailure;
export type TownshipDelegationSubmission = TownshipDelegationSuccess | TownshipDelegationFailure;
export type TownshipRevocationSubmission = TownshipRevocationSuccess | TownshipRevocationFailure;
export type TownshipCommandName = TownshipCommand["command"];

export interface TownshipCommandAvailability {
  commandName: TownshipCommandName;
  allowed: boolean;
  capId: string | null;
}

export type TownshipCommandAvailabilityMap = Record<TownshipCommandName, TownshipCommandAvailability>;

export interface TownshipActionAvailabilityReady {
  ready: true;
  publicKeyBase64: string;
  commands: TownshipCommandAvailabilityMap;
}

export interface TownshipActionAvailabilityUnavailable {
  ready: false;
  reason: "native_unavailable";
  message: string;
}

export type TownshipActionAvailability =
  | TownshipActionAvailabilityReady
  | TownshipActionAvailabilityUnavailable;

const TOWNSHIP_DEFAULT_DELEGATION_OPS = ["admit", "post", "set_summary", "set_title"] as const;

export const TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX = "township:witness-artifact:v1:";
export const TOWNSHIP_WITNESS_ARTIFACT_INDEX_KEY = "township:witness-artifacts:v1:index";
export const TOWNSHIP_WITNESS_INDEFINITE_VALIDITY_WARNING =
  "This artifact has no expiry and may remain valid indefinitely. " +
  "Valid until the clerk or recovery policy changes; this app cannot revoke an exported signature.";

export type TownshipWitnessArtifactFailureReason =
  | "native_unavailable"
  | "replica_mismatch"
  | "malformed"
  | "stale"
  | "unpinned"
  | "cancelled"
  | "unavailable";

export interface TownshipWitnessArtifactFailure {
  ok: false;
  reason: TownshipWitnessArtifactFailureReason;
  message: string;
}

export interface TownshipWitnessReviewSuccess {
  ok: true;
  review: WitnessedSuccessionReview;
  warning: typeof TOWNSHIP_WITNESS_INDEFINITE_VALIDITY_WARNING;
}

export interface TownshipWitnessArtifactSuccess {
  ok: true;
  artifactId: string;
  storageKey: string;
  artifactJson: string;
  review: WitnessedSuccessionReview;
  warning: typeof TOWNSHIP_WITNESS_INDEFINITE_VALIDITY_WARNING;
}

export interface TownshipStoredWitnessArtifact {
  artifactId: string;
  artifactJson: string;
  review: WitnessedSuccessionReview;
}

export interface TownshipWitnessArtifactsLoaded {
  ok: true;
  artifacts: TownshipStoredWitnessArtifact[];
}

export interface TownshipWitnessArtifactExported extends TownshipWitnessArtifactSuccess {
  fileName: string;
  confirmation: string[];
}

interface TownshipWitnessActionOptions extends TownshipNativeWorkflowOptions {
  replica: string;
}

interface SubmitTownshipWitnessArtifactOptions extends TownshipWitnessActionOptions {
  priorReview: WitnessedSuccessionReview;
}

interface ExportTownshipWitnessArtifactOptions extends TownshipNativeWorkflowOptions {
  artifactId: string;
  event: { readonly isTrusted: boolean };
}

interface TownshipWitnessArtifactIndexEntry {
  artifactId: string;
  review: WitnessedSuccessionReview;
}

interface TownshipWitnessArtifactIndex {
  v: 1;
  entries: TownshipWitnessArtifactIndexEntry[];
}

export async function loadTownshipWitnessReview(
  options: TownshipWitnessActionOptions,
): Promise<TownshipWitnessReviewSuccess | TownshipWitnessArtifactFailure> {
  try {
    const witness = await loadGovernanceWitnessPublicKey(
      options.invoke === undefined ? {} : { invoke: options.invoke },
    );
    const ops = await loadTownshipWitnessOps(options);
    const derived = deriveWitnessedSuccessionReview(
      townshipMatterSchema,
      ops,
      { replica: options.replica, role: "clerk", witness },
      null,
    );
    if (!derived.ok) return witnessDerivationFailure(derived.reason);
    return {
      ok: true,
      review: derived.review,
      warning: TOWNSHIP_WITNESS_INDEFINITE_VALIDITY_WARNING,
    };
  } catch (error) {
    return witnessRuntimeFailure(error);
  }
}

export async function submitTownshipWitnessArtifact(
  options: SubmitTownshipWitnessArtifactOptions,
): Promise<TownshipWitnessArtifactSuccess | TownshipWitnessArtifactFailure> {
  if (options.replica !== options.priorReview.claim.replica) {
    return witnessFailure("replica_mismatch", "The witness review belongs to a different replica.");
  }

  let review: WitnessedSuccessionReview;
  try {
    const witness = await loadGovernanceWitnessPublicKey(
      options.invoke === undefined ? {} : { invoke: options.invoke },
    );
    const ops = await loadTownshipWitnessOps(options);
    const derived = deriveWitnessedSuccessionReview(
      townshipMatterSchema,
      ops,
      { replica: options.replica, role: "clerk", witness },
      options.priorReview,
    );
    if (!derived.ok) return witnessDerivationFailure(derived.reason);
    review = derived.review;
  } catch (error) {
    return witnessRuntimeFailure(error);
  }

  let artifact: WitnessedSuccessionArtifactEvidence;
  try {
    const signature = await signGovernanceWitnessClaim(
      review.claim,
      review.witness,
      options.invoke === undefined ? {} : { invoke: options.invoke },
    );
    artifact = assembleWitnessedSuccessionArtifact(review.claim, {
      witness: signature.witness,
      signature: signature.signature,
    });
  } catch (error) {
    return witnessSigningFailure(error);
  }

  const artifactJson = exportWitnessedSuccessionArtifactJson(artifact);
  const storage = createTownshipNativeStorage(options);
  const storageNamespace = options.storageNamespace ?? TOWNSHIP_STORAGE_NAMESPACE;
  try {
    await withTownshipPersistenceWrite({ storageNamespace }, async () => {
      const currentIndex = await loadWitnessArtifactIndex(storage);
      const nextIndex = addWitnessArtifactIndexEntry(currentIndex, {
        artifactId: artifact.artifactId,
        review,
      });
      const artifactKey = `${TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX}${artifact.artifactId}`;
      const existing = await storage.getItem(artifactKey);
      if (existing !== undefined && existing !== null && existing !== artifactJson) {
        throw new Error("witness artifact storage collision");
      }
      if (existing === undefined || existing === null) {
        await storage.setItem(artifactKey, artifactJson);
      }
      if (JSON.stringify(nextIndex) !== JSON.stringify(currentIndex)) {
        await storage.setItem(TOWNSHIP_WITNESS_ARTIFACT_INDEX_KEY, JSON.stringify(nextIndex));
      }
    });
  } catch (error) {
    return witnessRuntimeFailure(error, "Witness artifact persistence is unavailable.");
  }

  return {
    ok: true,
    artifactId: artifact.artifactId,
    storageKey: `${TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX}${artifact.artifactId}`,
    artifactJson,
    review,
    warning: TOWNSHIP_WITNESS_INDEFINITE_VALIDITY_WARNING,
  };
}

export async function loadTownshipWitnessArtifacts(
  options: TownshipNativeWorkflowOptions = {},
): Promise<TownshipWitnessArtifactsLoaded | TownshipWitnessArtifactFailure> {
  const storage = createTownshipNativeStorage(options);
  try {
    const witnessIndex = await loadWitnessArtifactIndex(storage);
    const artifacts = await Promise.all(
      witnessIndex.entries.map((entry) => loadStoredWitnessArtifact(storage, entry)),
    );
    return { ok: true, artifacts };
  } catch (error) {
    return witnessStorageFailure(error, "Stored witness artifacts are unavailable.");
  }
}

export async function exportTownshipWitnessArtifact(
  options: ExportTownshipWitnessArtifactOptions,
): Promise<TownshipWitnessArtifactExported | TownshipWitnessArtifactFailure> {
  if (!options.event.isTrusted) {
    return witnessFailure("unavailable", "Export requires a trusted user action.");
  }

  const storage = createTownshipNativeStorage(options);
  try {
    const witnessIndex = await loadWitnessArtifactIndex(storage);
    const entry = witnessIndex.entries.find((candidate) => candidate.artifactId === options.artifactId);
    if (!entry) return witnessFailure("unavailable", "No stored witness artifact is available.");
    const stored = await loadStoredWitnessArtifact(storage, entry);
    return {
      ok: true,
      artifactId: stored.artifactId,
      storageKey: `${TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX}${stored.artifactId}`,
      artifactJson: stored.artifactJson,
      review: stored.review,
      warning: TOWNSHIP_WITNESS_INDEFINITE_VALIDITY_WARNING,
      fileName: `township-witness-artifact-v1-${stored.artifactId}.json`,
      confirmation: witnessArtifactConfirmation(stored.review),
    };
  } catch (error) {
    return witnessStorageFailure(error, "Stored witness artifact is unavailable.");
  }
}

export async function loadTownshipActionAvailability(
  options: LoadTownshipActionAvailabilityOptions = {},
): Promise<TownshipActionAvailability> {
  let workflow: TownshipNativeWorkflow;
  try {
    workflow = options.workflow ?? (await createTownshipNativeWorkflow(options));
  } catch {
    return nativeUnavailableAvailability();
  }

  try {
    const delegationFrames = await loadDelegationFrames(workflow);
    const delegations = carrierDelegationsFromFrames(delegationFrames);
    const commands = Object.fromEntries(
      TOWNSHIP_ACTION_COMMANDS.map((command) => {
        const capId = selectTownshipCapId(command, delegations, workflow.signer.publicKey);
        return [
          command.command,
          {
            commandName: command.command,
            allowed: capId !== null,
            capId,
          },
        ];
      }),
    ) as TownshipCommandAvailabilityMap;

    return {
      ready: true,
      publicKeyBase64: bytesBase64(workflow.signer.publicKey),
      commands,
    };
  } catch {
    return nativeUnavailableAvailability();
  }
}

export async function submitTownshipDelegation(
  options: SubmitTownshipDelegationOptions,
): Promise<TownshipDelegationSubmission> {
  const audience = normalizeAudiencePubkey(options.audiencePubkey);
  if (!audience.ok) return audience.failure;

  let workflow: TownshipNativeWorkflow;
  try {
    workflow = options.workflow ?? (await createTownshipNativeWorkflow(options));
  } catch {
    return {
      ok: false,
      reason: "native_unavailable",
      message: "Open in the Tauri shell to grant access from this device key.",
    };
  }

  try {
    const persisted = await withTownshipPersistenceWrite(workflow, async () => {
      const authored = await authorAndPersistTownshipDelegation({
        replica: options.replica ?? TOWNSHIP_REPLICA,
        audiencePubkey: audience.value,
        ops: options.ops ?? TOWNSHIP_DEFAULT_DELEGATION_OPS,
        roles: options.roles ?? [],
        live: options.live ?? false,
        signer: workflow.signer,
        localLog: workflow.localLog,
        carrierFrames: workflow.carrierFrames,
        delegationFrames: workflow.delegationFrames,
        realmByPubkey: options.realmByPubkey ?? TOWNSHIP_REALM_BY_PUBKEY,
      });
      const [localOps, carrierFrames, delegationFrames] = await Promise.all([
        workflow.localLog.load(),
        workflow.carrierFrames.load(),
        workflow.delegationFrames.load(),
      ]);
      return { authored, localOps, carrierFrames, delegationFrames };
    });

    return {
      ok: true,
      audiencePubkey: audience.value,
      ops: [...persisted.authored.delegation.ops],
      opId: persisted.authored.op.id,
      frameId: persisted.authored.frame.id,
      delegationId: persisted.authored.delegation.id,
      parentId: persisted.authored.parentId,
      localOpCount: persisted.localOps.length,
      carrierFrameCount: persisted.carrierFrames.length,
      delegationFrameCount: persisted.delegationFrames.length,
    };
  } catch (error) {
    const message = errorMessage(error);
    if (message.startsWith("no local delegation authorizes")) {
      return {
        ok: false,
        reason: "missing_delegation",
        message: "No local delegation can grant access from this device key yet.",
      };
    }

    return { ok: false, reason: "author_failed", message };
  }
}

export async function submitTownshipRevocation(
  options: SubmitTownshipRevocationOptions,
): Promise<TownshipRevocationSubmission> {
  const delegationId = options.delegationId.trim();
  const replica = options.replica ?? TOWNSHIP_REPLICA;
  if (delegationId.length === 0) {
    return { ok: false, reason: "empty_delegation", message: "Enter a delegation id before revoking access." };
  }

  let workflow: TownshipNativeWorkflow;
  try {
    workflow = options.workflow ?? (await createTownshipNativeWorkflow(options));
  } catch {
    return {
      ok: false,
      reason: "native_unavailable",
      message: "Open in the Tauri shell to revoke access from this device key.",
    };
  }

  try {
    const delegationFrames = await loadDelegationFrames(workflow);
    const delegation = carrierDelegationsFromFrames(delegationFrames).find((candidate) => candidate.id === delegationId);
    if (!delegation) {
      return {
        ok: false,
        reason: "missing_delegation",
        message: "No local delegation evidence matches that id yet.",
      };
    }

    if (delegation.replica !== replica) {
      return {
        ok: false,
        reason: "replica_mismatch",
        message: "Local delegation evidence belongs to a different replica.",
      };
    }

    // UX guard only. Replica authority still enforces issuer/root revocation during sync.
    if (delegation.issuer !== bytesBase64(workflow.signer.publicKey)) {
      return {
        ok: false,
        reason: "not_issuer",
        message: "Only the device that issued this delegation can prepare this revoke from local evidence.",
      };
    }

    const persisted = await withTownshipPersistenceWrite(workflow, async () => {
      const localOps = await workflow.localLog.load();
      const frame = await authorTownshipRevocation({
        replica,
        deps: frontier(localOps),
        delegationId,
        signer: workflow.signer,
      });
      const op = carrierOpsToSemanticOps([frame], options.realmByPubkey ?? TOWNSHIP_REALM_BY_PUBKEY)[0];
      if (!op) throw new Error(`authored revocation frame ${frame.id} did not produce a semantic op`);

      await workflow.localLog.append(op);
      await workflow.carrierFrames.append(frame);

      const [savedLocalOps, carrierFrames] = await Promise.all([
        workflow.localLog.load(),
        workflow.carrierFrames.load(),
      ]);
      return { op, frame, savedLocalOps, carrierFrames };
    });

    return {
      ok: true,
      delegationId,
      opId: persisted.op.id,
      frameId: persisted.frame.id,
      localOpCount: persisted.savedLocalOps.length,
      carrierFrameCount: persisted.carrierFrames.length,
    };
  } catch (error) {
    return { ok: false, reason: "author_failed", message: errorMessage(error) };
  }
}

export async function submitTownshipCommand(
  options: SubmitTownshipCommandOptions,
): Promise<TownshipCommandSubmission> {
  const command = normalizeCommand(options.command);
  const invalid = invalidCommand(command);
  if (invalid) return invalid;

  let workflow: TownshipNativeWorkflow;
  try {
    workflow = options.workflow ?? (await createTownshipNativeWorkflow(options));
  } catch {
    return {
      ok: false,
      reason: "native_unavailable",
      commandName: command.command,
      message: `Open in the Tauri shell to sign and save ${commandLabel(command.command)} changes.`,
    };
  }

  try {
    const persisted = await withTownshipPersistenceWrite(workflow, async () => {
      const authored = await authorAndPersistTownshipCommand({
        replica: options.replica ?? TOWNSHIP_REPLICA,
        command,
        signer: workflow.signer,
        localLog: workflow.localLog,
        carrierFrames: workflow.carrierFrames,
        delegationFrames: workflow.delegationFrames,
        realmByPubkey: options.realmByPubkey ?? TOWNSHIP_REALM_BY_PUBKEY,
      });
      const [localOps, carrierFrames] = await Promise.all([
        workflow.localLog.load(),
        workflow.carrierFrames.load(),
      ]);
      return { authored, localOps, carrierFrames };
    });

    return {
      ok: true,
      command,
      opId: persisted.authored.op.id,
      frameId: persisted.authored.frame.id,
      capId: persisted.authored.capId,
      localOpCount: persisted.localOps.length,
      carrierFrameCount: persisted.carrierFrames.length,
    };
  } catch (error) {
    const message = errorMessage(error);
    if (message.startsWith("no local delegation authorizes")) {
      return {
        ok: false,
        reason: "missing_delegation",
        commandName: command.command,
        message: `No local delegation authorizes ${commandLabel(command.command)} from this device key yet.`,
      };
    }

    return { ok: false, reason: "author_failed", commandName: command.command, message };
  }
}

export async function submitTownshipPost(
  options: SubmitTownshipPostOptions,
): Promise<TownshipPostSubmission> {
  const submitted = await submitTownshipCommand({
    ...options,
    command: { command: "post", text: options.text },
  });

  if (!submitted.ok && submitted.reason === "empty_text") {
    return { ok: false, reason: "empty_post", message: "Write an update before posting." };
  }
  if (!submitted.ok && submitted.reason === "native_unavailable") {
    return {
      ok: false,
      reason: "native_unavailable",
      message: "Open in the Tauri shell to sign and save local posts.",
    };
  }
  if (!submitted.ok) {
    const reason: TownshipPostFailureReason =
      submitted.reason === "missing_delegation" || submitted.reason === "author_failed"
        ? submitted.reason
        : "author_failed";
    return { ok: false, reason, message: submitted.message };
  }

  return {
    ok: true,
    text: submitted.command.command === "post" ? submitted.command.text : options.text.trim(),
    opId: submitted.opId,
    frameId: submitted.frameId,
    capId: submitted.capId,
    localOpCount: submitted.localOpCount,
    carrierFrameCount: submitted.carrierFrameCount,
  };
}

async function loadTownshipWitnessOps(options: TownshipNativeWorkflowOptions) {
  const storage = createTownshipNativeStorage(options);
  return createJsonLocalOpLogStore(storage, TOWNSHIP_LOCAL_OP_LOG_KEY).load();
}

async function loadWitnessArtifactIndex(
  storage: ReturnType<typeof createTownshipNativeStorage>,
): Promise<TownshipWitnessArtifactIndex> {
  const raw = await storage.getItem(TOWNSHIP_WITNESS_ARTIFACT_INDEX_KEY);
  if (raw === undefined || raw === null) return { v: 1, entries: [] };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("malformed witness artifact index");
  }
  if (!isWitnessArtifactIndex(value)) throw new Error("malformed witness artifact index");
  return value;
}

function addWitnessArtifactIndexEntry(
  current: TownshipWitnessArtifactIndex,
  entry: TownshipWitnessArtifactIndexEntry,
): TownshipWitnessArtifactIndex {
  const existing = current.entries.find((candidate) => candidate.artifactId === entry.artifactId);
  if (
    existing &&
    (existing.review.witness !== entry.review.witness ||
      !sameWitnessClaim(existing.review.claim, entry.review.claim))
  ) {
    throw new Error("witness artifact index collision");
  }
  if (existing) return current;

  return {
    v: 1,
    entries: [...current.entries, entry].sort(compareWitnessArtifactIndexEntries),
  };
}

function compareWitnessArtifactIndexEntries(
  left: TownshipWitnessArtifactIndexEntry,
  right: TownshipWitnessArtifactIndexEntry,
): number {
  return left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0;
}

async function loadStoredWitnessArtifact(
  storage: ReturnType<typeof createTownshipNativeStorage>,
  entry: TownshipWitnessArtifactIndexEntry,
): Promise<TownshipStoredWitnessArtifact> {
  const raw = await storage.getItem(`${TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX}${entry.artifactId}`);
  if (raw === undefined || raw === null) throw new Error("missing indexed witness artifact");
  const artifact = parseWitnessArtifact(raw);
  if (
    artifact === null ||
    artifact.artifactId !== entry.artifactId ||
    artifact.witness !== entry.review.witness ||
    !sameWitnessClaim(artifact.claim, entry.review.claim) ||
    !verifyGovernanceWitnessSignature(artifact.claim, artifact.witness, artifact.signature)
  ) {
    throw new Error("malformed indexed witness artifact");
  }
  return { artifactId: entry.artifactId, artifactJson: raw, review: entry.review };
}

function parseWitnessArtifact(raw: string): WitnessedSuccessionArtifactEvidence | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !exactObjectKeys(value, ["v", "artifactId", "claim", "witness", "signature"])
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1 ||
    typeof record.artifactId !== "string" ||
    typeof record.witness !== "string" ||
    typeof record.signature !== "string"
  ) {
    return null;
  }
  try {
    const artifact = assembleWitnessedSuccessionArtifact(
      record.claim as WitnessedSuccessionClaimEvidence,
      { witness: record.witness, signature: record.signature },
    );
    return artifact.artifactId === record.artifactId ? artifact : null;
  } catch {
    return null;
  }
}

function isWitnessArtifactIndex(value: unknown): value is TownshipWitnessArtifactIndex {
  if (
    typeof value !== "object" ||
    value === null ||
    !exactObjectKeys(value, ["v", "entries"])
  ) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || !Array.isArray(record.entries)) return false;

  let priorId = "";
  for (const entryValue of record.entries) {
    if (
      typeof entryValue !== "object" ||
      entryValue === null ||
      !exactObjectKeys(entryValue, ["artifactId", "review"])
    ) {
      return false;
    }
    const entry = entryValue as Record<string, unknown>;
    if (
      typeof entry.artifactId !== "string" ||
      !canonicalDigest(entry.artifactId) ||
      entry.artifactId <= priorId ||
      !isWitnessReview(entry.review)
    ) {
      return false;
    }
    priorId = entry.artifactId;
  }
  return true;
}

function isWitnessReview(value: unknown): value is WitnessedSuccessionReview {
  if (
    typeof value !== "object" ||
    value === null ||
    !exactObjectKeys(value, [
      "claim",
      "policyGenesisOperationId",
      "witness",
      "threshold",
      "verifiedFrontier",
    ])
  ) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isWitnessClaim(record.claim) &&
    typeof record.policyGenesisOperationId === "string" &&
    canonicalDigest(record.policyGenesisOperationId) &&
    typeof record.witness === "string" &&
    canonicalBase64Key(record.witness) &&
    Number.isSafeInteger(record.threshold) &&
    (record.threshold as number) > 0 &&
    Array.isArray(record.verifiedFrontier) &&
    record.verifiedFrontier.every(
      (operationId) => typeof operationId === "string" && canonicalDigest(operationId),
    )
  );
}

function isWitnessClaim(value: unknown): value is WitnessedSuccessionClaimEvidence {
  if (
    typeof value !== "object" ||
    value === null ||
    !exactObjectKeys(value, [
      "version",
      "replica",
      "role",
      "holder",
      "holderEpoch",
      "successor",
      "policyId",
    ])
  ) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.replica === "string" &&
    record.replica.length > 0 &&
    record.role === "clerk" &&
    typeof record.holder === "string" &&
    canonicalBase64Key(record.holder) &&
    typeof record.holderEpoch === "string" &&
    canonicalDigest(record.holderEpoch) &&
    typeof record.successor === "string" &&
    canonicalBase64Key(record.successor) &&
    typeof record.policyId === "string" &&
    canonicalDigest(record.policyId)
  );
}

function canonicalBase64Key(value: string): boolean {
  const bytes = base64Bytes(value);
  return bytes !== null && bytes.byteLength === 32 && bytesBase64(bytes) === value;
}

function canonicalDigest(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const encoded = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
  const bytes = base64Bytes(encoded);
  return (
    bytes !== null &&
    bytes.byteLength === 32 &&
    bytesBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") === value
  );
}

function exactObjectKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function sameWitnessClaim(
  left: WitnessedSuccessionClaimEvidence,
  right: WitnessedSuccessionClaimEvidence,
): boolean {
  return (
    left.version === right.version &&
    left.replica === right.replica &&
    left.role === right.role &&
    left.holder === right.holder &&
    left.holderEpoch === right.holderEpoch &&
    left.successor === right.successor &&
    left.policyId === right.policyId
  );
}

function witnessArtifactConfirmation(review: WitnessedSuccessionReview): string[] {
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
    TOWNSHIP_WITNESS_INDEFINITE_VALIDITY_WARNING,
  ];
}

function witnessDerivationFailure(reason: string): TownshipWitnessArtifactFailure {
  if (reason === "replica_mismatch") {
    return witnessFailure("replica_mismatch", "Verified operations belong to a different replica.");
  }
  if (reason === "witness_not_pinned") {
    return witnessFailure("unpinned", "This governance witness is not pinned by the recovery policy.");
  }
  if (reason === "stale_verified_state") {
    return witnessFailure("stale", "Verified holder or recovery policy details changed before signing.");
  }
  return witnessFailure("malformed", "Verified recovery details cannot produce a witness artifact.");
}

function witnessSigningFailure(error: unknown): TownshipWitnessArtifactFailure {
  const message = errorMessage(error);
  if (message.includes("cancelled")) return witnessFailure("cancelled", "Witness signing was cancelled.");
  if (message.includes("native shell")) return witnessFailure("native_unavailable", "Native witness custody is unavailable.");
  if (message.includes("unavailable")) return witnessFailure("unavailable", "Witness signing is unavailable.");
  return witnessFailure("malformed", "The native witness response failed local verification.");
}

function witnessRuntimeFailure(
  error: unknown,
  fallback = "Witness recovery details are unavailable.",
): TownshipWitnessArtifactFailure {
  const message = errorMessage(error);
  if (message.includes("native shell")) return witnessFailure("native_unavailable", fallback);
  return witnessFailure("unavailable", fallback);
}

function witnessStorageFailure(
  error: unknown,
  fallback: string,
): TownshipWitnessArtifactFailure {
  const message = errorMessage(error);
  if (
    message.includes("malformed") ||
    message.includes("missing indexed") ||
    message.includes("collision")
  ) {
    return witnessFailure("malformed", "Stored witness evidence is malformed.");
  }
  if (message.includes("native shell")) return witnessFailure("native_unavailable", fallback);
  return witnessFailure("unavailable", fallback);
}

function witnessFailure(
  reason: TownshipWitnessArtifactFailureReason,
  message: string,
): TownshipWitnessArtifactFailure {
  return { ok: false, reason, message };
}

async function loadDelegationFrames(workflow: TownshipNativeWorkflow): Promise<CarrierOpFrame[]> {
  const delegationFrames = await workflow.delegationFrames.load();
  if (delegationFrames.length > 0) return delegationFrames;

  return workflow.carrierFrames.load();
}

function normalizeCommand(command: TownshipCommand): TownshipCommand {
  switch (command.command) {
    case "set_title":
    case "set_summary":
    case "post":
      return { ...command, text: command.text.trim() };
    case "admit":
    case "remove_member":
      return { ...command, member: command.member.trim() };
    case "close_matter":
    case "reopen_matter":
      return command;
  }
}

function invalidCommand(command: TownshipCommand): TownshipCommandFailure | null {
  switch (command.command) {
    case "set_title":
    case "set_summary":
    case "post":
      if (command.text.length > 0) return null;
      return {
        ok: false,
        reason: "empty_text",
        commandName: command.command,
        message: `Write ${commandLabel(command.command)} text before saving.`,
      };
    case "admit":
    case "remove_member":
      if (command.member.length > 0) return null;
      return {
        ok: false,
        reason: "empty_member",
        commandName: command.command,
        message: `Choose a member before saving ${commandLabel(command.command)}.`,
      };
    case "close_matter":
    case "reopen_matter":
      return null;
  }
}

function commandLabel(command: TownshipCommand["command"]): string {
  return command.replaceAll("_", " ");
}

function nativeUnavailableAvailability(): TownshipActionAvailabilityUnavailable {
  return {
    ready: false,
    reason: "native_unavailable",
    message: "Open in the Tauri shell to inspect local action permissions.",
  };
}

function normalizeAudiencePubkey(
  value: string,
): { ok: true; value: string } | { ok: false; failure: TownshipDelegationFailure } {
  const trimmed = trimAsciiEdges(value);
  if (trimmed.length === 0) {
    return {
      ok: false,
      failure: { ok: false, reason: "empty_audience", message: "Enter a device public key before granting access." },
    };
  }

  const bytes = base64Bytes(trimmed);
  if (!bytes || bytes.byteLength !== 32 || bytesBase64(bytes) !== trimmed) {
    return {
      ok: false,
      failure: { ok: false, reason: "invalid_audience", message: "Enter a 32-byte base64 device public key." },
    };
  }

  return { ok: true, value: trimmed };
}

function trimAsciiEdges(value: string): string {
  return value.replace(/^[\u0009-\u000D\u0020]+|[\u0009-\u000D\u0020]+$/g, "");
}

function base64Bytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;

  try {
    const atobFn = (globalThis as unknown as { atob?: (encoded: string) => string }).atob;
    if (!atobFn) return null;
    return Uint8Array.from(atobFn(value), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function bytesBase64(bytes: Uint8Array): string {
  const btoaFn = (globalThis as unknown as { btoa?: (decoded: string) => string }).btoa;
  if (!btoaFn) throw new Error("base64 encoding unavailable");
  return btoaFn(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
