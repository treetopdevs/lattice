import type {
  IosDevelopmentProfileOptions,
  NormalizedIosDevelopmentProfile,
} from "./ios_development_profile.mjs";

export interface InstalledIosDevelopmentProfileCandidate {
  identity?: string;
  profile?: NormalizedIosDevelopmentProfile;
}

export interface InstalledIosDevelopmentProfileAssessment {
  decodedUniqueProfileCount: number;
  errorCounts: Record<string, number>;
  invalidProfileCount: number;
  undecodableProfileCount: number;
  validProfileCount: number;
}

export function assessInstalledIosDevelopmentProfiles(
  candidates: InstalledIosDevelopmentProfileCandidate[],
  options: IosDevelopmentProfileOptions,
): InstalledIosDevelopmentProfileAssessment;

export function installedIosDevelopmentProfileDiagnostic(
  assessment: InstalledIosDevelopmentProfileAssessment,
): string;

export function inspectInstalledIosDevelopmentProfiles(
  options: IosDevelopmentProfileOptions & { home: string },
): InstalledIosDevelopmentProfileAssessment;
