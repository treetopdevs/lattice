import type { CarrierOpFrame } from "./carrier";
export declare const SPACE_EXPORT_FORMAT = "lattice-space-frames-export-v1";
export declare const SPACE_EXPORT_MAX_FRAMES = 4000;
export declare const SPACE_EXPORT_MAX_BYTES: number;
/** The only file names the native writer accepts: one plain `.json` segment, never a path. */
export declare const isExportFileName: (name: string) => boolean;
/** A default file name from the tail of the Space id, sanitized. */
export declare function suggestExportFileName(replica: string): string;
export declare function buildSpaceFramesExport(input: {
    space: string;
    /** The Space root's public key, standard base64 of 32 bytes. */
    rootPublicKey: string;
    frames: readonly CarrierOpFrame[];
    verify: (frame: CarrierOpFrame) => Promise<boolean>;
}): Promise<string>;
