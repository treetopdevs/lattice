import type { CarrierOpSigner } from "../../src/codec";
import type { ContinuationProfile } from "../../src/continuation";
import type { CatalogBootstrap, TransportCatalog, CatalogRotation, CatalogCutoff } from "../../src/treehouse_catalog_codec";
export declare const fixtureId: (label: string) => string;
export declare const fixtureSigner: (label: string) => CarrierOpSigner;
export declare function signedCatalog(catalog: TransportCatalog, signer: CarrierOpSigner): Promise<string>;
export declare function signedRotation(rotation: CatalogRotation, old: CarrierOpSigner, next: CarrierOpSigner): Promise<string>;
/** Independently signed synthetic histories, including distinct Space and child roots. */
export declare function trustFixture(threadCount?: number): Promise<{
    space: {
        replica: string;
        signer: CarrierOpSigner;
        delegation: import("../../src").CarrierDelegation;
        genesis: import("../../src").CarrierOpFrame;
        creation: import("../../src").CarrierOpFrame;
        pin: import("../../src").CarrierOpFrame;
        profile: ContinuationProfile;
        frames: import("../../src").CarrierOpFrame[];
    };
    threads: {
        reference: import("../../src").CarrierOpFrame;
        replica: string;
        signer: CarrierOpSigner;
        delegation: import("../../src").CarrierDelegation;
        genesis: import("../../src").CarrierOpFrame;
        creation: import("../../src").CarrierOpFrame;
        pin: import("../../src").CarrierOpFrame;
        profile: ContinuationProfile;
        frames: import("../../src").CarrierOpFrame[];
    }[];
    root: CarrierOpSigner;
    catalogSigner: CarrierOpSigner;
    nextCatalogSigner: CarrierOpSigner;
    serviceSigner: CarrierOpSigner;
    bootstrapRecord: CatalogBootstrap;
    bootstrap: import("../../src").CarrierOpFrame;
    review: {
        version: 1;
        product: "treehouse";
        space: string;
        spaceRoot: string;
        bootstrapId: string;
        observedBootstrapIds: string[];
        disposition: "pin_exact_observed_bootstrap";
    };
    histories: {
        replica: string;
        frames: import("../../src").CarrierOpFrame[];
        rejected: never[];
    }[];
    cutoffProofs: {
        cutoff: CatalogCutoff;
        history: {
            replica: string;
            frames: import("../../src").CarrierOpFrame[];
            rejected: never[];
        };
    }[];
    catalog: TransportCatalog;
    catalogJson: string;
    rotation: CatalogRotation;
    rotationJson: string;
}>;
