// Pilot-artifact frontend build (plan 158 "Signed Android Internal
// Distribution"): identical to the ordinary build except that every dev-only
// probe module is aliased to an inert stub so no probe surface, env-seeded
// configuration, or emulator-host address reaches the pilot bundle. The build
// also refuses to run in a seeded VITE_TOWNSHIP_* environment.

import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const seeded = Object.keys(process.env).filter((key) => key.startsWith("VITE_TOWNSHIP_"));
if (seeded.length > 0) {
  throw new Error(
    `pilot frontend build refuses a seeded environment: ${seeded.join(", ")} (probe/env-seed paths are dev-only)`,
  );
}

const stubPath = fileURLToPath(new URL("./scripts/android-pilot/pilot_probe_stubs.ts", import.meta.url));

const stubbedModules = [
  "township_canonical_probe",
  "township_release_beam_probe",
  "township_release_author_probe",
  "township_release_root_origination_probe",
  "township_release_onboarding_probe",
  "township_release_pairing_probe",
  "township_release_sync_probe",
  "township_release_transport_probe",
  "township_ios_key_reuse_probe",
  "township_packaged_onboarding_probe",
];

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: stubbedModules.map((name) => ({
      find: new RegExp(`^(\\./)?${name}$`),
      replacement: stubPath,
    })),
  },
});
