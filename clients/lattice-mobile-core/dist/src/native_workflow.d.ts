/**
 * Product-neutral native workflow seam.
 *
 * Extracted from the Township shell's `native_workflow.ts`: the manifest
 * driven composition of native key-value storage, the local op log, the
 * carrier outbox and delegation frame stores, and the native carrier signer.
 * The product supplies its key ID, storage namespace and Tauri invoke; the
 * storage keys are shared across products because each product already
 * isolates at the database/namespace level.
 */
import type { CarrierFrameStore, CarrierSigner, LocalKeyValueStore, LocalOpLogStore, TauriInvoke } from "@treetopdevs/lattice-client";
export declare const PRODUCT_LOCAL_OP_LOG_KEY = "local_ops";
export declare const PRODUCT_CARRIER_OUTBOX_KEY = "carrier_frames";
export declare const PRODUCT_DELEGATION_FRAMES_KEY = "delegation_frames";
export interface ProductNativeWorkflowOptions {
    invoke: TauriInvoke;
    keyId: string;
    storageNamespace: string;
}
export interface ProductNativeWorkflow {
    keyId: string;
    storageNamespace: string;
    storage: LocalKeyValueStore;
    localLog: LocalOpLogStore;
    carrierFrames: CarrierFrameStore;
    delegationFrames: CarrierFrameStore;
    signer: CarrierSigner;
}
export declare function createProductNativeStorage(options: Pick<ProductNativeWorkflowOptions, "invoke" | "storageNamespace">): LocalKeyValueStore;
export declare function createProductNativeWorkflow(options: ProductNativeWorkflowOptions): Promise<ProductNativeWorkflow>;
/**
 * Serialize persistence writes per storage namespace so concurrent intent
 * flows cannot interleave partial writes.
 */
export declare function withProductPersistenceWrite<T>(workflow: Pick<ProductNativeWorkflow, "storageNamespace">, operation: () => Promise<T>): Promise<T>;
