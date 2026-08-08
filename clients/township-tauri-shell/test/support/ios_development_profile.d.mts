export interface NormalizedIosDevelopmentProfile {
  teamIdentifiers: unknown;
  applicationIdentifierPrefixes: unknown;
  duplicateEntitlementKeys: unknown;
  entitlements: {
    applicationIdentifier: unknown;
    teamIdentifier: unknown;
    getTaskAllow: unknown;
    keychainAccessGroups?: unknown;
  };
  provisionedDevices: unknown;
  provisionsAllDevices: unknown;
  creationTimeMs: unknown;
  expirationTimeMs: unknown;
}

export interface IosDevelopmentProfileOptions {
  bundleIdentifier: string;
  deviceUdid: string;
  expectedTeamIdentifier: string;
  minimumRemainingMs: number;
  nowMs: number;
}

export function developmentProfileErrors(
  profile: NormalizedIosDevelopmentProfile,
  options: IosDevelopmentProfileOptions,
): string[];

export function duplicateProfileEntitlementKeys(
  entitlementsXml: string,
): string[] | undefined;

export function profileDateTimeMs(value: unknown): number;
