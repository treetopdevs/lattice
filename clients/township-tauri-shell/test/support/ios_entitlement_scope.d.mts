export interface DevelopmentEntitlementOptions {
  bundleIdentifier: string;
  expectedApplicationIdentifier: string;
  expectedTeamIdentifier: string;
}

export function developmentEntitlementErrors(
  entitlements: string,
  options: DevelopmentEntitlementOptions,
): string[];
