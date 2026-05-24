import { spawn } from "node:child_process";
import net from "node:net";

const DEFAULT_TIMEOUT_MS = 45_000;

export async function startServer({
  root,
  command = "mix",
  args = [],
  port,
  host = "127.0.0.1",
  timeoutMs,
  readyPath = "/",
  env,
} = {}) {
  const resolvedPort = Number(port ?? (await freePort()));
  const url = `http://${host}:${resolvedPort}/`;
  const resolvedTimeout = Number(
    timeoutMs ?? process.env.LATTICE_E2E_START_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  );

  const serverProcess = spawn(command, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    ...(env ? { env } : {}),
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

  const target = url + readyPath.replace(/^\//, "");
  await waitForHttp(target, resolvedTimeout, () => ({ stdout, stderr, exitStatus }));

  return {
    port: resolvedPort,
    url,
    process: serverProcess,
    stop() {
      return stopProcess(serverProcess);
    },
  };
}

export async function startFlagshipServer(root) {
  const port = Number(process.env.LATTICE_FLAGSHIP_E2E_PORT || (await freePort()));
  const timeoutMs = process.env.LATTICE_FLAGSHIP_START_TIMEOUT_MS
    ? Number(process.env.LATTICE_FLAGSHIP_START_TIMEOUT_MS)
    : undefined;

  return startServer({
    root,
    command: "mix",
    args: ["lattice.demo.flagship", String(port)],
    port,
    timeoutMs,
  });
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

export function freePort() {
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
