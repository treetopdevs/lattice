import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";

function demoEcosystemPlugin(): Plugin {
  const demoDir = path.resolve(
    import.meta.dirname,
    process.env.DEMO_ECOSYSTEM_DIR || "../../output/demo_ecosystem",
  );

  const serve = (
    req: { url?: string },
    res: {
      statusCode: number;
      setHeader(name: string, value: string): void;
      end(body: string): void;
    },
    next: () => void,
  ) => {
    const reqPath = (req.url || "").split("?")[0] ?? "";
    if (reqPath === "/demo-endpoints.json") {
      const target = path.join(demoDir, "demo-endpoints.json");
      if (!fs.existsSync(target)) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: "demo_endpoints_missing",
            hint: "Start scripts/demo_ecosystem_relay.sh first.",
          }),
        );
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(fs.readFileSync(target, "utf8"));
      return;
    }

    const seedMatch = /^\/demo-seed\/(founder|neighbor|observer)$/.exec(reqPath);
    if (seedMatch) {
      const role = seedMatch[1]!;
      const target = path.join(demoDir, "identities", `participant_${role}.seed`);
      if (!fs.existsSync(target)) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "demo_seed_missing", role }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(
        JSON.stringify({
          role,
          realm: `demo-${role}`,
          seedHex: fs.readFileSync(target, "utf8").trim(),
          notice: "Local dev demo seed only — never expose in production.",
        }),
      );
      return;
    }

    next();
  };

  return {
    name: "lattice-demo-ecosystem-dev-endpoints",
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve);
    },
  };
}

export default defineConfig({
  plugins: [vue(), demoEcosystemPlugin()],
  resolve: {
    preserveSymlinks: true,
  },
  build: {
    assetsDir: "starter-assets",
  },
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: false,
  },
});
