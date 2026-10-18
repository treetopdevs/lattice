import {
  createRelayObserver as createKitRelayObserver,
  spawnPilotManifestServer as spawnKitPilotManifestServer,
  writePilotManifest as writeKitPilotManifest,
} from "@treetopdevs/lattice-shell-kit/testing/relay";
import type {
  PilotInstanceSpec,
  PilotManifestInput as KitPilotManifestInput,
  PilotRelay,
  RelayObserver,
} from "@treetopdevs/lattice-shell-kit/testing/relay";
import type { RelayRoute } from "../../src/treehouse_state";

// The manifest relay spawner and the read-only observer live in the shell kit
// (`@treetopdevs/lattice-shell-kit/testing/relay`, plan 186 PR 3). This file binds the Treehouse
// values: the `pilot_node.exs` fixture entrypoint and the manifest file name.

const PILOT_SCRIPT = "apps/lattice_carrier_server/priv/pilot_node.exs";
const MANIFEST_NAME = "treehouse-manifest.json";

export type { PilotInstanceSpec, PilotRelay, RelayObserver };
export type PilotManifestInput = Omit<KitPilotManifestInput, "manifestName">;

/** Write identity files (0600) and the manifest (0600). Returns the manifest path. */
export function writePilotManifest(input: PilotManifestInput): string {
  return writeKitPilotManifest({ ...input, manifestName: MANIFEST_NAME });
}

/** Boot `pilot_node.exs` against a manifest. Readiness can take several seconds (preload and log verification). */
export function spawnPilotManifestServer(manifestPath: string): Promise<PilotRelay> {
  return spawnKitPilotManifestServer(manifestPath, PILOT_SCRIPT);
}

export function createRelayObserver(seed: Uint8Array, routes: Record<string, RelayRoute>): RelayObserver {
  return createKitRelayObserver(seed, routes);
}
