import { integrate } from "./sync";
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

export function createJsonLocalOpLogStore(storage: LocalKeyValueStore, key: string): LocalOpLogStore {
  return {
    async load(): Promise<Op[]> {
      const raw = await storage.getItem(key);
      if (raw === null || raw === undefined || raw === "") return [];
      const ops = JSON.parse(raw) as unknown;
      if (!Array.isArray(ops)) throw new Error(`local op log ${key} is not an array`);
      return ops as Op[];
    },

    async save(ops: Op[]): Promise<void> {
      await storage.setItem(key, JSON.stringify(ops));
    },

    async append(op: Op): Promise<Op[]> {
      const ops = integrate(await this.load(), [op]);
      await this.save(ops);
      return ops;
    },
  };
}

export function createJsonCarrierFrameStore(storage: LocalKeyValueStore, key: string): CarrierFrameStore {
  return {
    async load(): Promise<CarrierOpFrame[]> {
      const raw = await storage.getItem(key);
      if (raw === null || raw === undefined || raw === "") return [];
      const frames = JSON.parse(raw) as unknown;
      if (!Array.isArray(frames)) throw new Error(`carrier frame store ${key} is not an array`);
      return frames as CarrierOpFrame[];
    },

    async save(frames: CarrierOpFrame[]): Promise<void> {
      await storage.setItem(key, JSON.stringify(frames));
    },

    async append(frame: CarrierOpFrame): Promise<CarrierOpFrame[]> {
      const byId = new Map((await this.load()).map((existing) => [existing.id, existing]));
      if (!byId.has(frame.id)) byId.set(frame.id, frame);
      const frames = [...byId.values()];
      await this.save(frames);
      return frames;
    },
  };
}
