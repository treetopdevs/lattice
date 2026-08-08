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
import { createJsonCarrierFrameStore, createJsonLocalOpLogStore, createTauriKeyValueStore, createTauriNativeCarrierSigner, } from "@treetopdevs/lattice-client";
export const PRODUCT_LOCAL_OP_LOG_KEY = "local_ops";
export const PRODUCT_CARRIER_OUTBOX_KEY = "carrier_frames";
export const PRODUCT_DELEGATION_FRAMES_KEY = "delegation_frames";
export function createProductNativeStorage(options) {
    return createTauriKeyValueStore(options.invoke, { namespace: options.storageNamespace });
}
export async function createProductNativeWorkflow(options) {
    const storage = createProductNativeStorage(options);
    const signer = await createTauriNativeCarrierSigner(options.invoke, { keyId: options.keyId });
    return {
        keyId: options.keyId,
        storageNamespace: options.storageNamespace,
        storage,
        localLog: createJsonLocalOpLogStore(storage, PRODUCT_LOCAL_OP_LOG_KEY),
        carrierFrames: createJsonCarrierFrameStore(storage, PRODUCT_CARRIER_OUTBOX_KEY),
        delegationFrames: createJsonCarrierFrameStore(storage, PRODUCT_DELEGATION_FRAMES_KEY),
        signer,
    };
}
const persistenceWriters = new Map();
/**
 * Serialize persistence writes per storage namespace so concurrent intent
 * flows cannot interleave partial writes.
 */
export async function withProductPersistenceWrite(workflow, operation) {
    return persistenceWriter(workflow.storageNamespace).runExclusive(operation);
}
function persistenceWriter(storageNamespace) {
    const existing = persistenceWriters.get(storageNamespace);
    if (existing)
        return existing;
    let tail = Promise.resolve();
    const writer = {
        async runExclusive(operation) {
            const previous = tail;
            let release = () => { };
            tail = new Promise((resolve) => {
                release = resolve;
            });
            await previous;
            try {
                return await operation();
            }
            finally {
                release();
            }
        },
    };
    persistenceWriters.set(storageNamespace, writer);
    return writer;
}
