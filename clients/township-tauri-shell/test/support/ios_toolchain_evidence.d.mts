export interface DeveloperToolchainReferenceCounts {
  approvedReferenceCount: number;
  foreignReferenceCount: number;
}

export function classifyDeveloperToolchainReferences(
  contents: string | Uint8Array,
  approvedDeveloperRoot: string,
): DeveloperToolchainReferenceCounts;
