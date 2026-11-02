import { authorCarrierOp } from "../../src/codec";
import type { CarrierOpSigner } from "../../src/codec";
import type { CarrierOpFrame, CarrierTerm } from "../../src/carrier";
import { deriveTreehouseCatalogCutoff } from "../../src/treehouse_catalog_cutoff";
import type { CatalogBootstrap, CatalogEntry, CatalogReplacementClaim } from "../../src/treehouse_catalog_codec";
export interface SignerWithSeed extends CarrierOpSigner {
    publicKey: Uint8Array;
}
export declare function seededSigner(label: string): SignerWithSeed;
/** The bootstrap-history shape shared with `treehouse_catalog_bootstrap.ts`'s `fixture()`. */
export interface ReplacementBase {
    root: CarrierOpSigner & {
        publicKey: Uint8Array;
    };
    nominee: CarrierOpSigner & {
        publicKey: Uint8Array;
    };
    replica: string;
    delegation: {
        id: string;
    };
    genesis: CarrierOpFrame;
    creation: CarrierOpFrame;
    pin: CarrierOpFrame;
    record: CatalogBootstrap;
    bootstrap: CarrierOpFrame;
    frames: CarrierOpFrame[];
}
/** A TS-only bootstrap history; same construction as the bootstrap test fixture, other seeds. */
export declare function replacementBaseFixture(prefix?: string): Promise<ReplacementBase>;
export type ReplacementArgs = [CarrierTerm, CarrierTerm, CarrierTerm];
export interface ReplacementHistory {
    base: ReplacementBase;
    newCatalog: SignerWithSeed;
    newService: SignerWithSeed;
    genuine: CarrierOpFrame;
    forged: CarrierOpFrame;
    beacon: CarrierOpFrame;
    before: CarrierOpFrame[];
    entries: CatalogEntry[];
    claim: CatalogReplacementClaim;
    catalogPossession: string;
    servicePossession: string;
    cutoff: Awaited<ReturnType<typeof deriveTreehouseCatalogCutoff>>;
    replacement: CarrierOpFrame;
    sign(claim: CatalogReplacementClaim): ReplacementArgs;
    op(args: CarrierTerm[], overrides?: Partial<Parameters<typeof authorCarrierOp>[0]>): Promise<CarrierOpFrame>;
}
/** Retained bad-signature evidence, a beacon, then one valid root-authored replacement. */
export declare function replacementHistory(base: ReplacementBase, prefix?: string): Promise<ReplacementHistory>;
/** Stage A refusals over `before`, each with its own extra prefix frames. */
export declare function stageACases(h: ReplacementHistory): Promise<{
    name: string;
    prefix: CarrierOpFrame[];
    frame: CarrierOpFrame;
}[]>;
export declare function judge(frames: CarrierOpFrame[]): Promise<ReadonlyMap<string, string>>;
