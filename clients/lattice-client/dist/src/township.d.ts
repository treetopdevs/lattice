import type { AuthorCarrierOpInput, CarrierOpSigner } from "./codec";
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
export interface AuthorTownshipDelegationInput {
    replica: string;
    deps: string[];
    audiencePubkey: string | Uint8Array;
    parentId?: string | null;
    ops?: readonly string[];
    roles?: readonly string[];
    live?: boolean;
    expiresEpoch?: number;
    signer: CarrierOpSigner;
}
export interface TownshipLegacyGenesisPolicy {
    successorPubkey: string | Uint8Array;
    dormantTicks: number;
}
export interface TownshipBeaconGenesisPolicy {
    mode: "witnessed";
    version: 1;
    witnesses: readonly (string | Uint8Array)[];
    threshold: number;
    maxEpochStep: number;
}
export type TownshipGenesisPolicy = TownshipLegacyGenesisPolicy | TownshipBeaconGenesisPolicy;
export interface AuthorTownshipGenesisInput {
    replica: string;
    ops?: readonly string[];
    roles?: readonly string[];
    live?: boolean;
    policies?: Record<string, TownshipGenesisPolicy>;
    signer: CarrierOpSigner;
}
export interface AuthorTownshipRevocationInput extends Pick<AuthorCarrierOpInput, "replica" | "deps" | "signer"> {
    delegationId: string;
}
export interface AuthorAndPersistTownshipCommandInput extends Pick<AuthorTownshipCommandInput, "replica" | "command" | "signer"> {
    localLog: LocalOpLogStore;
    carrierFrames: CarrierFrameStore;
    delegationFrames?: CarrierFrameStore;
    realmByPubkey: Record<string, string>;
}
export interface AuthorAndPersistTownshipDelegationInput extends Pick<AuthorTownshipDelegationInput, "replica" | "audiencePubkey" | "ops" | "roles" | "live" | "expiresEpoch" | "signer"> {
    parentId?: string | null;
    localLog: LocalOpLogStore;
    carrierFrames: CarrierFrameStore;
    delegationFrames?: CarrierFrameStore;
    realmByPubkey: Record<string, string>;
}
export interface AuthorAndPersistTownshipCommandResult {
    frame: CarrierOpFrame;
    op: Op;
    capId: string;
}
export interface AuthorAndPersistTownshipDelegationResult {
    frame: CarrierOpFrame;
    op: Op;
    delegation: CarrierDelegation;
    parentId: string | null;
}
export declare function townshipCommandBody(command: TownshipCommand): CarrierTerm;
export declare function townshipCapTerm(capId: string | null): CarrierTerm;
export declare function townshipGrantBody(delegation: CarrierDelegation): CarrierTerm;
export declare function townshipGenesisBody(delegation: CarrierDelegation, policies?: Record<string, TownshipGenesisPolicy>): CarrierTerm;
export declare function townshipRevokeBody(delegationId: string): CarrierTerm;
export declare function selectTownshipCapId(command: TownshipCommand, delegations: CarrierDelegation[], audiencePubkey: string | Uint8Array): string | null;
export declare function selectTownshipDelegationParentId(delegations: readonly CarrierDelegation[], issuerPubkey: string | Uint8Array, options?: {
    replica?: string;
    ops?: readonly string[];
    roles?: readonly string[];
    live?: boolean;
}): string | null;
export declare function authorTownshipCommand(input: AuthorTownshipCommandInput): Promise<CarrierOpFrame>;
export declare function authorTownshipCommandFromLog(input: AuthorTownshipCommandFromLogInput): Promise<CarrierOpFrame>;
export declare function authorTownshipDelegation(input: AuthorTownshipDelegationInput): Promise<CarrierOpFrame>;
export declare function authorTownshipGenesis(input: AuthorTownshipGenesisInput): Promise<CarrierOpFrame>;
export declare function authorTownshipRevocation(input: AuthorTownshipRevocationInput): Promise<CarrierOpFrame>;
export declare function bindTownshipReplica(replica: string, rootPubkey: string | Uint8Array): Promise<string>;
export declare function townshipReplicaCommitment(replica: string): string | null;
export declare function townshipReplicaRootTag(rootPubkey: string | Uint8Array): Promise<string>;
export declare function authorAndPersistTownshipCommand(input: AuthorAndPersistTownshipCommandInput): Promise<AuthorAndPersistTownshipCommandResult>;
export declare function authorAndPersistTownshipDelegation(input: AuthorAndPersistTownshipDelegationInput): Promise<AuthorAndPersistTownshipDelegationResult>;
