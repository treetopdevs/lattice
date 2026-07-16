import type { CarrierOpFrame } from "./carrier";
import type { Op } from "./op";
export interface LocalKeyValueStore {
    getItem(key: string): string | null | undefined | Promise<string | null | undefined>;
    setItem(key: string, value: string): void | Promise<void>;
}
export interface LocalOpLogStore {
    load(): Promise<Op[]>;
    save(ops: Op[]): Promise<void>;
    append(op: Op): Promise<Op[]>;
}
export interface CarrierFrameStore {
    load(): Promise<CarrierOpFrame[]>;
    save(frames: CarrierOpFrame[]): Promise<void>;
    append(frame: CarrierOpFrame): Promise<CarrierOpFrame[]>;
}
export declare function createJsonLocalOpLogStore(storage: LocalKeyValueStore, key: string): LocalOpLogStore;
export declare function createJsonCarrierFrameStore(storage: LocalKeyValueStore, key: string): CarrierFrameStore;
