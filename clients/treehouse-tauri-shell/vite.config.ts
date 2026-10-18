import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

// Plan 181 row 201: the enrollment test variant needs both frontend flags; every other state is refused so an
// ordinary build can never carry (or half-carry) the enrollment panel. The check reads the resolved config's env,
// which is what import.meta.env sees (process.env plus the .env files of the resolved envDir), whatever the cwd.
const VARIANT_FLAGS = ["VITE_TREEHOUSE_ENROLLMENT", "VITE_TREEHOUSE_DEV_TRACE"] as const;

export function assertVariantFlags(env: Record<string, string | undefined>): void {
  const values = VARIANT_FLAGS.map((name) => env[name]);
  const bad = values.some((value) => value !== undefined && value !== "1");
  const on = values.filter((value) => value === "1").length;
  if (bad || on === 1)
    throw new Error(
      `Treehouse variant flags: ${VARIANT_FLAGS.join(" and ")} must both be unset (ordinary build) or both be exactly "1" (dev-trace enrollment build); got ${VARIANT_FLAGS.map((name, i) => `${name}=${values[i] === undefined ? "<unset>" : JSON.stringify(values[i])}`).join(", ")}`,
    );
}

// Plan 186: the shell kit's `./testing` subpath is test support only; the production build never reaches it.
// It reads the whole module graph, not chunk module lists, which omit modules the optimizer inlined.
const variantFlagGuard: Plugin = {
  name: "treehouse-variant-flag-guard",
  configResolved(config) {
    assertVariantFlags(config.env);
  },
};

const shellKitTestingBoundary: Plugin = {
  name: "lattice-shell-kit-testing-boundary",
  apply: "build",
  generateBundle() {
    for (const id of this.getModuleIds()) {
      if (id.replaceAll("\\", "/").includes("lattice-shell-kit/src/testing/"))
        this.error(`production build reaches shell-kit test support: ${id}`);
    }
  },
};

export default defineConfig({
  plugins: [variantFlagGuard, vue(), shellKitTestingBoundary],
  // Plan 186: the kit and lattice-client are file: links; resolving through the shell's node_modules keeps one lattice-client copy and lets kit modules find their peers.
  resolve: { preserveSymlinks: true },
  server: { host: "127.0.0.1", port: 5175, strictPort: true },
});
