import { createIdentityFromSeedHex, type MobileIdentity } from "../native/custody";

// Demo only (M1a.6): the public demo identities. Their seeds are published by the demo relay, so these
// keys prove nothing about who posted; the demo bar says so. The Keychain device key is not a demo mode:
// it is the app's own identity, used when the demo is off.

export const DEMO_ROLES = ["founder", "neighbor"] as const;
export type DemoRole = (typeof DEMO_ROLES)[number];

// 01: the genesis key is "Started this group", never "Founder" (and "Admin" would go stale after a transfer).
export const DEMO_ROLE_LABEL: Record<DemoRole, string> = { founder: "Started this group", neighbor: "Neighbor" };

/** Demo bar and Group > Safety notice (04). */
export const DEMO_KEYS_PUBLIC =
  "Demo identities. Their keys are public, so anyone can post as these identities. Do not use them for anything real.";

export async function fetchDemoSeed(
  origin: string,
  role: DemoRole | "observer",
): Promise<{ realm: string; seedHex: string }> {
  const base = origin.replace(/\/$/, "");
  const res = await fetch(`${base}/demo-seed/${role}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`demo_seed_fetch_failed:${role}:${res.status}`);
  }
  return (await res.json()) as { realm: string; seedHex: string };
}

/** Load one public demo identity. The seed goes straight into the signer and is never kept or logged. */
export async function loadDemoIdentity(origin: string, role: DemoRole): Promise<MobileIdentity> {
  const seed = await fetchDemoSeed(origin, role);
  return createIdentityFromSeedHex(seed.realm, seed.seedHex, "demo-seed");
}
