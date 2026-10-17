import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

// Plan 186: the shell kit's `./testing` subpath is test support only; the production build never reaches it.
// It reads the whole module graph, not chunk module lists, which omit modules the optimizer inlined.
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
  plugins: [vue(), shellKitTestingBoundary],
  // Plan 186: the kit and lattice-client are file: links; resolving through the shell's node_modules keeps one lattice-client copy and lets kit modules find their peers.
  resolve: { preserveSymlinks: true },
  server: { host: "127.0.0.1", port: 5175, strictPort: true },
});
