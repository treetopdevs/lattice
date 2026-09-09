import { defineConfig } from "vite";
import { popcorn } from "@swmansion/popcorn/vite";
import { fileURLToPath } from "node:url";

// Dedicated local research origin. Do not copy this CSP to the main application.
export const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; connect-src 'self' ws://127.0.0.1:*; style-src 'self'; object-src 'none'; base-uri 'none'"
};
export default defineConfig({
  plugins: [popcorn({ rootDir: fileURLToPath(new URL("browser", import.meta.url)), app: "lattice_browser", runtimeVariant: "crypto" })],
  server: {
    host: "127.0.0.1", port: 5179, strictPort: true, headers,
    proxy: { "/ws": { target: `ws://127.0.0.1:${process.env.LATTICE_POPCORN_PORT || 4059}`, ws: true } }
  },
  preview: { host: "127.0.0.1", headers }
});
