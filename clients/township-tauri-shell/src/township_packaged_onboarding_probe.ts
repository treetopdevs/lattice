import { traceTownshipDevEvent } from "./native_workflow";
import {
  onboardTownshipDesktop,
  type TownshipDesktopOnboarding,
} from "./township_onboarding";

export interface TownshipPackagedOnboardingEnv {
  VITE_TOWNSHIP_PACKAGED_ONBOARDING_HANDOFF?: string;
  VITE_TOWNSHIP_PACKAGED_ONBOARDING_LOCAL_REALM?: string;
  VITE_TOWNSHIP_PACKAGED_ONBOARDING_POST_TEXT?: string;
}

export async function runTownshipPackagedOnboardingFromEnv(
  env: TownshipPackagedOnboardingEnv,
): Promise<TownshipDesktopOnboarding | null> {
  const pairingHandoff = env.VITE_TOWNSHIP_PACKAGED_ONBOARDING_HANDOFF?.trim();
  if (!pairingHandoff) return null;

  const localRealm = env.VITE_TOWNSHIP_PACKAGED_ONBOARDING_LOCAL_REALM?.trim();
  const postText = env.VITE_TOWNSHIP_PACKAGED_ONBOARDING_POST_TEXT?.trim();
  if (!localRealm || !postText) {
    await traceTownshipDevEvent("township-onboarding-failed:invalid_probe_config");
    return null;
  }

  const onboarding = await onboardTownshipDesktop({
    pairingHandoff,
    localRealm,
    postText,
    confirmed: true,
  });
  if (!onboarding.ok) {
    await traceTownshipDevEvent(`township-onboarding-failed:${onboarding.reason}`);
    return onboarding;
  }
  if (onboarding.pendingOutboxIds.length !== 0) {
    await traceTownshipDevEvent("township-onboarding-failed:outbox_not_drained");
    return onboarding;
  }

  await traceTownshipDevEvent(`township-onboarding-drained:${onboarding.post.frameId}`);
  return onboarding;
}
