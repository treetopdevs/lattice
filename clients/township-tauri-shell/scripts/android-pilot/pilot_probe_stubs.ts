// Inert replacements for the dev-only probe modules, aliased in by
// vite.pilot.config.ts for pilot artifacts (plan 158: compile out dev traces,
// environment probes, and seeded-key paths). Every export mirrors the runtime
// surface App.vue consumes; each one reports "no probe configured".

export const TOWNSHIP_IOS_KEY_REUSE_CONTROL_KEY_ID = "township-ios-key-reuse-control";

export type TownshipCanonicalProbeDeepLinkListener = { stop(): void };

export async function createTownshipCanonicalProbeDeepLinkListener(
  _options?: unknown,
): Promise<TownshipCanonicalProbeDeepLinkListener> {
  return { stop() {} };
}

export async function logTownshipCanonicalProbe(): Promise<boolean> {
  return false;
}

export function parseTownshipCanonicalProbeDeepLink(_value: string): null {
  return null;
}

export async function logTownshipReleaseBeamProbeFromEnv(): Promise<boolean> {
  return false;
}

export async function logTownshipReleaseAuthorProbeFromEnv(): Promise<boolean> {
  return false;
}

export type TownshipReleaseRootOriginationProbeEnv = Record<string, string | undefined>;

export function townshipReleaseRootOriginationProbeConfigFromEnv(_env: unknown): null {
  return null;
}

export async function logTownshipReleaseRootOriginationProbeFromEnv(): Promise<boolean> {
  return false;
}

export type TownshipReleaseOnboardingProbeEnv = Record<string, string | undefined>;

export function townshipReleaseOnboardingProbeConfigFromEnv(_env: unknown): null {
  return null;
}

export async function logTownshipReleaseOnboardingProbeFromEnv(): Promise<boolean> {
  return false;
}

export type TownshipReleasePairingProbeEnv = Record<string, string | undefined>;

export function townshipReleasePairingProbeConfigFromEnv(_env: unknown): null {
  return null;
}

export async function logTownshipReleasePairingProbeFromEnv(): Promise<boolean> {
  return false;
}

export async function logTownshipReleaseSyncProbeFromEnv(): Promise<boolean> {
  return false;
}

export async function logTownshipReleaseTransportProbesFromEnv(): Promise<boolean> {
  return false;
}

export type TownshipIosKeyReuseProbeEnv = Record<string, string | undefined>;

export function townshipIosKeyReuseProbeEnabled(_env: unknown): boolean {
  return false;
}

export async function logTownshipIosKeyReuseProbeFromEnv(..._args: unknown[]): Promise<boolean> {
  return false;
}

export async function runTownshipPackagedOnboardingFromEnv(_env: unknown): Promise<null> {
  return null;
}
