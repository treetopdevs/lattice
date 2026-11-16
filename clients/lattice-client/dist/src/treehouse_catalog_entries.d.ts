import type { CarrierOpFrame } from "./carrier";
import type { CatalogBootstrap, CatalogEntry, TransportCatalog } from "./treehouse_catalog_codec";
export type TreehouseCatalogEntriesRefusal = "malformed_catalog" | "invalid_verified_history" | "unsupported_cutoff" | "trust_pending" | "invalid_catalog_transition";
export type TreehouseCatalogEntriesResult = {
    ok: true;
    entries: CatalogEntry[];
    bootstrap: {
        id: string;
        record: CatalogBootstrap;
    };
} | {
    ok: false;
    reason: TreehouseCatalogEntriesRefusal;
    refused: string[];
};
/** The catalog's entry facts against `histories` (replica -> authenticated frames), as the BEAM `observe_with_detail/2`. */
export declare function observeTreehouseCatalogEntries(catalog: TransportCatalog, histories: ReadonlyMap<string, readonly CarrierOpFrame[]>): Promise<TreehouseCatalogEntriesResult>;
