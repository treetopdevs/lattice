import * as codec from "../../src/treehouse_member_continuity_codec";
/** Synthetic consent bytes only: these claim IDs do not prove real membership or a current epoch. */
export declare function memberContinuityFixture(): Promise<{
    claim: codec.MemberContinuityClaim;
    certificate: codec.MemberContinuityCertificate;
    challenge: codec.MemberKeyReturnChallenge;
    returnSignature: string;
    frames: import("../../src").CarrierOpFrame[];
    replica: string;
    command: import("../../src").CarrierOpFrame;
}>;
export declare function verifyMemberContinuityVector(vector: unknown): Promise<void>;
