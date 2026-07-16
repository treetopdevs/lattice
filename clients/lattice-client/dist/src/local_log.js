import { integrate } from "./sync";
export function createJsonLocalOpLogStore(storage, key) {
    return {
        async load() {
            const raw = await storage.getItem(key);
            if (raw === null || raw === undefined || raw === "")
                return [];
            const ops = JSON.parse(raw);
            if (!Array.isArray(ops))
                throw new Error(`local op log ${key} is not an array`);
            return ops;
        },
        async save(ops) {
            await storage.setItem(key, JSON.stringify(ops));
        },
        async append(op) {
            const ops = integrate(await this.load(), [op]);
            await this.save(ops);
            return ops;
        },
    };
}
export function createJsonCarrierFrameStore(storage, key) {
    return {
        async load() {
            const raw = await storage.getItem(key);
            if (raw === null || raw === undefined || raw === "")
                return [];
            const frames = JSON.parse(raw);
            if (!Array.isArray(frames))
                throw new Error(`carrier frame store ${key} is not an array`);
            return frames;
        },
        async save(frames) {
            await storage.setItem(key, JSON.stringify(frames));
        },
        async append(frame) {
            const byId = new Map((await this.load()).map((existing) => [existing.id, existing]));
            if (!byId.has(frame.id))
                byId.set(frame.id, frame);
            const frames = [...byId.values()];
            await this.save(frames);
            return frames;
        },
    };
}
