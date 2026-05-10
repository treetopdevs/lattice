import { spawn } from "node:child_process";
import net from "node:net";

export async function startFlagshipServer(root) {
  const port = Number(process.env.LATTICE_FLAGSHIP_E2E_PORT || (await freePort()));
  const url = `http://127.0.0.1:${port}/`;
  const timeoutMs = Number(process.env.LATTICE_FLAGSHIP_START_TIMEOUT_MS || 45_000);

  const serverProcess = spawn("mix", ["lattice.demo.flagship", String(port)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let exitStatus = null;

  serverProcess.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  serverProcess.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  serverProcess.on("exit", (code, signal) => {
    exitStatus = { code, signal };
  });

  await waitForHttp(url, timeoutMs, () => ({ stdout, stderr, exitStatus }));

  return {
    port,
    url,
    stop() {
      return stopProcess(serverProcess);
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
    `Timed out waiting for ${target}: ${lastError?.message || "no response"}${formatContext(context)}`,
  );
}

function formatContext(context) {
  if (!context) return "";

  return [
    context.exitStatus ? `process exit: ${JSON.stringify(context.exitStatus)}` : null,
    `stdout:\n${context.stdout || "(empty)"}`,
    `stderr:\n${context.stderr || "(empty)"}`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .replace(/^/, "\n\n");
}

function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    timer.unref();

    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });

    child.kill("SIGTERM");
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
