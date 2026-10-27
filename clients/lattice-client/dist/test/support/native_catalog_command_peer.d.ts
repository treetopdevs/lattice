import type { CarrierOpFrame } from "../../src/carrier";
export interface CommandHistory {
    name: string;
    replica: string;
    frames: CarrierOpFrame[];
}
export declare function threadPolicyCases(): Promise<CommandHistory[]>;
export declare function commandCases(): Promise<CommandHistory[]>;
export declare function judgeCommands(history: CommandHistory): Promise<{
    [k: string]: {
        reason: string | null | undefined;
        fields: string[] | null;
        roles: string[] | null;
    };
}>;
