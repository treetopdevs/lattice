import { spawn } from "node:child_process";
import net from "node:net";

export async function startFlagshipServer(root) {
  const port = Number(process.env.LATTICE_FLAGSHIP_E2E_PORT || (await freePort()));
  const url = `http://localhost:${port}/`;

  const serverProcess = spawn("mix", ["lattice.demo.flagship", String(port)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  serverProcess.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await waitForHttp(url, 15_000, () => stderr);

  return {
    port,
    url,
    stop() {
      serverProcess.kill("SIGTERM");
    },
  };
}

async function waitForHttp(target, timeoutMs, errorContext) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(target);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }

    await delay(100);
  }

  const context = errorContext?.();
  throw new Error(
    `Timed out waiting for ${target}: ${lastError?.message || "no response"}${context ? `\n${context}` : ""}`,
  );
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
