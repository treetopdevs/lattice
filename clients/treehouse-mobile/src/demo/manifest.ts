import type { CarrierRoute } from "@treetopdevs/lattice-shell-kit";

// Demo only (M1a.6): the public demo relay's endpoint manifest. Reached only from the composition root
// behind __DEV__ or EXPO_PUBLIC_TREEHOUSE_DEMO=1; session and ui never import this directory.

export const DEFAULT_DEMO_WSS_ORIGIN = "https://lattice-demo-wss.fly.dev";

const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;

/**
 * The dev-build pointer (M1a.7): `pointer` is EXPO_PUBLIC_TREEHOUSE_DEMO_ORIGIN, set on the Metro command line to
 * the loopback demo server (test/support/loopback_demo_server.mts) so a simulator run posts to a local relay
 * only. Unset means the public demo relay. A set pointer must be loopback; anything else is refused, never
 * replaced by the public origin.
 */
export function demoOrigin(pointer: string | undefined): string {
  if (pointer === undefined || pointer === "") return DEFAULT_DEMO_WSS_ORIGIN;
  const origin = pointer.trim().replace(/\/$/, "");
  if (!LOOPBACK_ORIGIN.test(origin)) throw new Error("demo_origin_not_loopback");
  return origin;
}

/** Read by dot notation so Metro inlines it, and only here, so only a bundle that requires src/demo holds it. */
export const DEMO_ORIGIN_POINTER: string | undefined = process.env.EXPO_PUBLIC_TREEHOUSE_DEMO_ORIGIN;

/** One demo route; structurally the M0 host's HostEndpoint, declared here so the demo outlives that host. */
export interface DemoEndpoint {
  name: string;
  product: string;
  replica: string;
  ws_url: string;
  peer_realm: string;
  peer_pubkey: string;
  relay_realms: string[];
  initial_ops: number;
}

export interface DemoParticipantInfo {
  realm: string;
  pubkey: string;
  seed_file: string;
}

export interface DemoEndpointsManifest {
  mode: string;
  notice: string;
  manifest_path: string;
  health: {
    livez: string;
    readyz: string;
  };
  participants: Record<string, DemoParticipantInfo>;
  endpoints: DemoEndpoint[];
  treehouse_routes: CarrierRoute[];
}

export async function fetchDemoEndpoints(origin = DEFAULT_DEMO_WSS_ORIGIN): Promise<DemoEndpointsManifest> {
  const base = origin.replace(/\/$/, "");
  const res = await fetch(`${base}/demo-endpoints.json`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`demo_endpoints_fetch_failed:${res.status}`);
  }
  return (await res.json()) as DemoEndpointsManifest;
}

/** Realm labels for the manifest's public participants, keyed by public key. */
export function demoRealmByPubkey(manifest: DemoEndpointsManifest): Record<string, string> {
  const realmByPubkey: Record<string, string> = {};
  for (const info of Object.values(manifest.participants)) realmByPubkey[info.pubkey] = info.realm;
  return realmByPubkey;
}
