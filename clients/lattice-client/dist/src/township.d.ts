import type { AuthorCarrierOpInput } from "./codec";
import type { CarrierDelegation, CarrierOpFrame, CarrierTerm } from "./carrier";
import type { CarrierFrameStore, LocalOpLogStore } from "./local_log";
import type { Op } from "./op";
export type TownshipCommand = {
    command: "set_title";
    text: string;
} | {
    command: "set_summary";
    text: string;
} | {
    command: "post";
    text: string;
} | {
    command: "admit";
    member: string;
} | {
    command: "remove_member";
    member: string;
} | {
    command: "close_matter";
} | {
    command: "reopen_matter";
};
export interface AuthorTownshipCommandInput extends Pick<AuthorCarrierOpInput, "replica" | "deps" | "signer"> {
    command: TownshipCommand;
    capId: string | null;
}
export interface AuthorTownshipCommandFromLogInput extends Pick<AuthorTownshipCommandInput, "replica" | "command" | "capId" | "signer"> {
    localOps: Op[];
}
export interface AuthorAndPersistTownshipCommandInput extends Pick<AuthorTownshipCommandInput, "replica" | "command" | "signer"> {
    localLog: LocalOpLogStore;
    carrierFrames: CarrierFrameStore;
    realmByPubkey: Record<string, string>;
}
export interface AuthorAndPersistTownshipCommandResult {
    frame: CarrierOpFrame;
    op: Op;
    capId: string;
}
export declare function townshipCommandBody(command: TownshipCommand): CarrierTerm;
export declare function townshipCapTerm(capId: string | null): CarrierTerm;
export declare function selectTownshipCapId(command: TownshipCommand, delegations: CarrierDelegation[], audiencePubkey: string | Uint8Array): string | null;
export declare function authorTownshipCommand(input: AuthorTownshipCommandInput): Promise<CarrierOpFrame>;
export declare function authorTownshipCommandFromLog(input: AuthorTownshipCommandFromLogInput): Promise<CarrierOpFrame>;
export declare function authorAndPersistTownshipCommand(input: AuthorAndPersistTownshipCommandInput): Promise<AuthorAndPersistTownshipCommandResult>;
