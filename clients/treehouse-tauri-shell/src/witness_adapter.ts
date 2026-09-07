import {invoke} from "@tauri-apps/api/core";
import {getCurrentWebviewWindow} from "@tauri-apps/api/webviewWindow";
import {ed25519} from "@noble/curves/ed25519.js";
import {canonicalBase64Bytes} from "@treetopdevs/lattice-client";
import {canonicalBytesForWitnessBinding} from "./witness_binding";

export interface PrepareCreation {replica: string; enrollmentId: string; recipient: string}
export interface GenerateWitness {creationAttemptId: string; generationChallenge: string}
export interface ProveBinding extends PrepareCreation {freshValidatorNonce: string}
export interface PendingWitness {version: 1; attemptId: string; phase: "review" | "presence"}
export interface WitnessMetadata {publicKey: string; spki: string; appSignerSha256: string; creationVersionCode: string; certificateChain: string[]}
export interface WitnessIdentity {creationAttemptId: string; phase: "prepared" | "generation_started" | "generated_unvalidated";
  generationChallenge: string | null; metadata: WitnessMetadata | null; revision: string}
export interface WitnessEnrollment extends PrepareCreation {creationAttemptId: string}
export interface PublicBindingClaim extends ProveBinding {domain: "lattice-witness-binding-challenge-v1"; version: 1;
  product: "treehouse"; appId: "dev.treetop.lattice.treehouse"; creationAttemptId: string; actualWitnessPublicKey: string;
  generationChallengeDigest: string; nativeRandomNonce: string; nativeCallerSessionDigest: string}
export type Missing = {version: 1; status: "missing"};
export type Cancelled = {version: 1; status: "cancelled"};
export type IdentityResult = {version: 1; status: "identity" | "incomplete"; eligible: false; identity: WitnessIdentity};
export type PreparedResult = {version: 1; status: "prepared"; eligible: false; identity: WitnessIdentity; enrollment: WitnessEnrollment};
export type GeneratedResult = {version: 1; status: "generated_unvalidated"; eligible: false; identity: WitnessIdentity};
export type ProofResult = {version: 1; status: "signed"; eligible: false; identity: WitnessIdentity; binding: {claim: PublicBindingClaim; signature: string}};
export type WitnessResult = Missing | Cancelled | IdentityResult | PreparedResult | GeneratedResult | ProofResult;
export interface WitnessTransport {
  invoke(command: string, args: Record<string, never> | number[]): Promise<unknown>;
  subscribePending(callback: (payload: unknown) => void): Promise<() => void>;
}
const transport: WitnessTransport = {
  invoke: (command, args) => invoke(command, args),
  subscribePending: callback => getCurrentWebviewWindow().listen("treehouse:witness-pending-v1", event => callback(event.payload)),
};
const commands = {identity: "treehouse_witness_public_identity", prepare: "treehouse_witness_prepare_creation",
  generate: "treehouse_witness_generate", proof: "treehouse_witness_prove_binding", cancel: "treehouse_witness_cancel"} as const;
type Method = keyof typeof commands;
type Request = Record<string, string>;
type Running = {invoked: boolean; invalid: boolean; pending: PendingWitness | null; unsubscribe: (() => void) | null;
  abort: (error: Error) => void; cancelled: Promise<never>; cancelling: boolean};

/** UI transport only. The native owner/operation gate remains the source of authority.
 * Listener epochs reject old closures; they cannot authenticate the provenance of
 * a first payload inside a new invocation. No event is consent or eligibility.
 */
export class WitnessAdapter {
  private active: Running | null = null;
  private stopped = false;
  constructor(private readonly bridge: WitnessTransport = transport,
    private readonly onPending: (pending: PendingWitness | null) => void = () => {}) {}
  publicIdentity(): Promise<IdentityResult | Missing | Cancelled> {return this.run("identity", {}) as Promise<IdentityResult | Missing | Cancelled>;}
  prepareCreation(input: PrepareCreation): Promise<PreparedResult | Cancelled> {return this.run("prepare", input) as Promise<PreparedResult | Cancelled>;}
  generate(input: GenerateWitness): Promise<GeneratedResult | Cancelled> {return this.run("generate", input) as Promise<GeneratedResult | Cancelled>;}
  proveBinding(input: ProveBinding): Promise<ProofResult | Cancelled> {return this.run("proof", input) as Promise<ProofResult | Cancelled>;}
  async cancel(): Promise<Cancelled | Missing> {
    const run = this.active;
    if (!run || run.invalid || !run.pending) throw new Error("witness_pending_unavailable");
    if (run.cancelling) throw new Error("witness_cancel_pending");
    run.cancelling = true;
    try {
      const result = await decodeResult("cancel", {}, await this.bridge.invoke(commands.cancel, requestBytes({attemptId: run.pending.attemptId})));
      if (this.active !== run || run.invalid) throw new Error("stale_witness_operation");
      return result as Cancelled | Missing;
    } catch (error) {throw bridgeError(error);} finally {run.cancelling = false;}
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const run = this.active;
    if (run) {
      this.fail(run, "witness_stopped");
      this.unsubscribe(run);
    }
  }
  private notify(pending: PendingWitness | null) {try {this.onPending(pending === null ? null : {...pending});} catch { /* UI observers do not authorize native work. */ }}
  private unsubscribe(run: Running) {const stop = run.unsubscribe; run.unsubscribe = null; if (stop) {try {stop();} catch { /* Epoch guard still rejects late callbacks. */ }}}
  private fail(run: Running, reason: string) {
    if (run.invalid) return;
    run.invalid = true;
    if (run.pending && !run.cancelling) {
      run.cancelling = true;
      const attemptId = run.pending.attemptId;
      void Promise.resolve().then(() => this.bridge.invoke(commands.cancel, requestBytes({attemptId}))).catch(() => {});
    }
    run.pending = null; this.notify(null); run.abort(new Error(reason));
  }
  private event(run: Running, payload: unknown) {
    if (this.active !== run || run.invalid || !run.invoked) return;
    try {
      const value = object(payload, ["version", "attemptId", "phase"]);
      if (value.version !== 1 || !binary(value.attemptId, 32) || (value.phase !== "review" && value.phase !== "presence")) throw new Error();
      const pending = value as unknown as PendingWitness;
      if (run.pending && (run.pending.attemptId !== pending.attemptId || (run.pending.phase === "presence" && pending.phase === "review"))) throw new Error();
      if (run.pending?.phase === pending.phase) return;
      run.pending = {...pending}; this.notify(run.pending);
    } catch {this.fail(run, "invalid_witness_pending_event");}
  }
  private async run(method: Exclude<Method, "cancel">, input: unknown): Promise<WitnessResult> {
    const request = validateRequest(method, input);
    if (this.stopped) throw new Error("witness_stopped");
    if (this.active) throw new Error("witness_busy");
    let abort!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => {abort = reject;});
    const run: Running = {invoked: false, invalid: false, pending: null, unsubscribe: null, abort, cancelled, cancelling: false};
    this.active = run;
    try {
      const subscribe = this.bridge.subscribePending(payload => this.event(run, payload)).then(stop => {
        if (this.active !== run || run.invalid) stop(); else run.unsubscribe = stop;
      });
      await Promise.race([subscribe, cancelled]);
      if (run.invalid || this.active !== run) throw new Error("witness_stopped");
      run.invoked = true;
      const result = await Promise.race([
        this.bridge.invoke(commands[method], method === "identity" ? {} : requestBytes(request))
          .then(value => decodeResult(method, request, value)), cancelled,
      ]);
      if (run.invalid || this.active !== run) throw new Error("stale_witness_operation");
      return result;
    } catch (error) {throw bridgeError(error);} finally {
      run.invalid = true; this.unsubscribe(run);
      if (this.active === run) {this.active = null; this.notify(null);}
    }
  }
}
function bridgeError(error: unknown): Error {
  const reason = error instanceof Error ? error.message : error;
  return new Error(typeof reason === "string" && /^[a-z_]{1,64}$/.test(reason) ? reason : "witness_unavailable");
}
function object(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_witness_result");
  const keys = Object.keys(input);
  if (keys.length !== fields.length || !keys.every(key => fields.includes(key))) throw new Error("invalid_witness_result");
  return input as Record<string, unknown>;
}
function binary(input: unknown, length?: number): Uint8Array | null {
  if (typeof input !== "string" || (length !== undefined && input.length !== 4 * Math.ceil(length / 3))) return null;
  return canonicalBase64Bytes(input, length);
}
function replica(input: unknown): boolean {
  if (typeof input !== "string" || input.length > 512) return false;
  const bytes = new TextEncoder().encode(input);
  return bytes.length > 0 && bytes.length <= 512 && new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes) === input;
}
function revision(input: unknown): boolean {return typeof input === "string" && /^[1-9][0-9]{0,18}$/.test(input) && BigInt(input) <= 9223372036854775807n;}
function requestBytes(value: Request): number[] {const bytes = new TextEncoder().encode(JSON.stringify(value)); if (bytes.length > 131072) throw new Error("invalid_witness_request");return Array.from(bytes);}
function validateRequest(method: Exclude<Method, "cancel">, input: unknown): Request {
  try {
    const fields = method === "identity" ? [] : method === "prepare" ? ["replica", "enrollmentId", "recipient"] :
      method === "generate" ? ["creationAttemptId", "generationChallenge"] : ["replica", "enrollmentId", "recipient", "freshValidatorNonce"];
    const value = object(input, fields);
    if (!fields.every(field => field === "replica" ? replica(value[field]) : binary(value[field], 32) !== null)) throw new Error();
    return Object.fromEntries(fields.map(field => [field, value[field] as string]));
  } catch {throw new Error("invalid_witness_request");}
}
function checkIdentity(input: unknown): WitnessIdentity {
  const value = object(input, ["creationAttemptId", "phase", "generationChallenge", "metadata", "revision"]);
  if (!binary(value.creationAttemptId, 32) || !revision(value.revision)) throw new Error();
  if (value.phase === "prepared") {
    if (value.generationChallenge !== null || value.metadata !== null) throw new Error();
  } else if (value.phase === "generation_started" || value.phase === "generated_unvalidated") {
    if (!binary(value.generationChallenge, 32)) throw new Error();
    if (value.phase === "generation_started") {if (value.metadata !== null) throw new Error();}
    else {
      const metadata = object(value.metadata, ["publicKey", "spki", "appSignerSha256", "creationVersionCode", "certificateChain"]);
      const key = binary(metadata.publicKey, 32), spki = binary(metadata.spki, 44);
      const prefix = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0];
      if (!key || !spki || !binary(metadata.appSignerSha256, 32) || !revision(metadata.creationVersionCode) ||
        !prefix.every((byte, index) => spki[index] === byte) || !key.every((byte, index) => spki[index + 12] === byte) ||
        !Array.isArray(metadata.certificateChain) || metadata.certificateChain.length < 1 || metadata.certificateChain.length > 8) throw new Error();
      let total = 0;
      for (const encoded of metadata.certificateChain) {
        const certificate = binary(encoded);
        if (!certificate || certificate.length < 1 || certificate.length > 16384) throw new Error();
        total += certificate.length;
      }
      if (total > 65536) throw new Error();
    }
  } else throw new Error();
  return value as unknown as WitnessIdentity;
}
async function decodeResult(method: Method, request: Request, raw: unknown): Promise<WitnessResult> {
  try {
    const owned: unknown = structuredClone(raw);
    if (new TextEncoder().encode(JSON.stringify(owned)).length > 131072) throw new Error();
    if (!owned || typeof owned !== "object" || Array.isArray(owned)) throw new Error();
    const status = (owned as Record<string, unknown>).status;
    if (status === "missing" || status === "cancelled") {
      const value = object(owned, ["version", "status"]);
      if (value.version !== 1 || (status === "missing" && method !== "identity" && method !== "cancel")) throw new Error();
      return value as unknown as Missing | Cancelled;
    }
    const expected = method === "identity" ? ["identity", "incomplete"] : method === "prepare" ? ["prepared"] :
      method === "generate" ? ["generated_unvalidated"] : method === "proof" ? ["signed"] : [];
    if (typeof status !== "string" || !expected.includes(status)) throw new Error();
    const value = object(owned, ["version", "status", "eligible", "identity", ...(method === "prepare" ? ["enrollment"] : method === "proof" ? ["binding"] : [])]);
    if (value.version !== 1 || value.eligible !== false) throw new Error();
    const identity = checkIdentity(value.identity);
    const complete = identity.phase === "generated_unvalidated";
    if (method === "identity" && (status === "identity") !== complete) throw new Error();
    if ((method === "generate" || method === "proof") && !complete) throw new Error();
    if (method === "prepare") {
      const enrollment = object(value.enrollment, ["replica", "enrollmentId", "recipient", "creationAttemptId"]);
      if (identity.phase === "generation_started" || enrollment.replica !== request.replica ||
        enrollment.enrollmentId !== request.enrollmentId || enrollment.recipient !== request.recipient ||
        enrollment.creationAttemptId !== identity.creationAttemptId) throw new Error();
    }
    if (method === "generate" && (identity.creationAttemptId !== request.creationAttemptId || identity.generationChallenge !== request.generationChallenge)) throw new Error();
    if (method === "proof") {
      const binding = object(value.binding, ["claim", "signature"]);
      const claim = object(binding.claim, ["domain", "version", "product", "appId", "replica", "enrollmentId", "recipient", "creationAttemptId",
        "actualWitnessPublicKey", "generationChallengeDigest", "freshValidatorNonce", "nativeRandomNonce", "nativeCallerSessionDigest"]);
      if (claim.domain !== "lattice-witness-binding-challenge-v1" || claim.version !== 1 || claim.product !== "treehouse" || claim.appId !== "dev.treetop.lattice.treehouse") throw new Error();
      const {domain: _domain, version: _version, product: _product, appId: _appId, ...variables} = claim;
      const bytes = canonicalBytesForWitnessBinding(variables);
      for (const field of ["replica", "enrollmentId", "recipient", "freshValidatorNonce"]) if (claim[field] !== request[field]) throw new Error();
      if (claim.creationAttemptId !== identity.creationAttemptId || claim.actualWitnessPublicKey !== identity.metadata!.publicKey) throw new Error();
      const challenge = binary(identity.generationChallenge, 32)!;
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(challenge)));
      const expectedDigest = binary(claim.generationChallengeDigest, 32)!;
      if (!hash.every((byte, index) => expectedDigest[index] === byte)) throw new Error();
      const signature = binary(binding.signature, 64), key = binary(claim.actualWitnessPublicKey, 32)!;
      if (!signature || !ed25519.verify(signature, bytes, key, {zip215: false})) throw new Error();
    }
    return value as unknown as WitnessResult;
  } catch {throw new Error("invalid_witness_result");}
}
