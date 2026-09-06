import type { CarrierOpFrame, CarrierTerm } from "../../src/carrier";
export declare function cutoffFixture(): Promise<{
    replica: string;
    signer: {
        publicKey: Uint8Array<ArrayBufferLike> & Uint8Array<ArrayBuffer>;
        sign: (bytes: Uint8Array) => Uint8Array<ArrayBufferLike> & Uint8Array<ArrayBuffer>;
    };
    genesis: CarrierOpFrame;
    name: CarrierOpFrame;
    denied: CarrierOpFrame;
    high: CarrierOpFrame;
    genuine: CarrierOpFrame;
    forged: {
        sig: string;
        v: number;
        id: string;
        replica: string;
        author: string;
        deps: string[];
        kind: import("../../src").OpKind;
        body: CarrierTerm;
        cap: CarrierTerm;
    };
    supplied: {
        id: string;
        deps: string[];
        sig: string;
        v: number;
        replica: string;
        author: string;
        kind: import("../../src").OpKind;
        body: CarrierTerm;
        cap: CarrierTerm;
    };
    frames: CarrierOpFrame[];
}>;
