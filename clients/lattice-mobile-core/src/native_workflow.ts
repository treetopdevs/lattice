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

import {
  createJsonCarrierFrameStore,
  createJsonLocalOpLogStore,
  createTauriKeyValueStore,
  createTauriNativeCarrierSigner,
} from "@treetopdevs/lattice-client";
import type {
  CarrierFrameStore,
  CarrierSigner,
  LocalKeyValueStore,
  LocalOpLogStore,
  TauriInvoke,
} from "@treetopdevs/lattice-client";

export const PRODUCT_LOCAL_OP_LOG_KEY = "local_ops";
export const PRODUCT_CARRIER_OUTBOX_KEY = "carrier_frames";
export const PRODUCT_DELEGATION_FRAMES_KEY = "delegation_frames";

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

export function createProductNativeStorage(
  options: Pick<ProductNativeWorkflowOptions, "invoke" | "storageNamespace">,
): LocalKeyValueStore {
  return createTauriKeyValueStore(options.invoke, { namespace: options.storageNamespace });
}

export async function createProductNativeWorkflow(
  options: ProductNativeWorkflowOptions,
): Promise<ProductNativeWorkflow> {
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

interface PersistenceWriter {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

const persistenceWriters = new Map<string, PersistenceWriter>();

/**
 * Serialize persistence writes per storage namespace so concurrent intent
 * flows cannot interleave partial writes.
 */
export async function withProductPersistenceWrite<T>(
  workflow: Pick<ProductNativeWorkflow, "storageNamespace">,
  operation: () => Promise<T>,
): Promise<T> {
  return persistenceWriter(workflow.storageNamespace).runExclusive(operation);
}

function persistenceWriter(storageNamespace: string): PersistenceWriter {
  const existing = persistenceWriters.get(storageNamespace);
  if (existing) return existing;

  let tail = Promise.resolve();
  const writer = {
    async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
      const previous = tail;
      let release = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
  persistenceWriters.set(storageNamespace, writer);
  return writer;
}
