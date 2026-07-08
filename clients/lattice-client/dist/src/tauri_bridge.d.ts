import type { CarrierSigner } from "./carrier";
import type { LocalKeyValueStore } from "./local_log";
export type TauriInvoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
export interface TauriKeyValueStoreOptions {
    namespace?: string;
    getCommand?: string;
    setCommand?: string;
}
export interface TauriCarrierSignerOptions {
    keyId: string;
    publicKey: string | Uint8Array;
    signCommand?: string;
}
export interface TauriNativeCarrierSignerOptions {
    keyId: string;
    publicKeyCommand?: string;
    signCommand?: string;
}
export declare function createTauriKeyValueStore(invoke: TauriInvoke, opts?: TauriKeyValueStoreOptions): LocalKeyValueStore;
export declare function createTauriCarrierSigner(invoke: TauriInvoke, opts: TauriCarrierSignerOptions): CarrierSigner;
export declare function createTauriNativeCarrierSigner(invoke: TauriInvoke, opts: TauriNativeCarrierSignerOptions): Promise<CarrierSigner>;
