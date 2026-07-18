import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinnedToolPath } from "./packaged_action_handoff";

export interface GovernanceKeyDiscoveryOptions {
  shellRoot: string;
}

export const GOVERNANCE_TEST_PRESENCE_KEY_FILE_ENV = "TOWNSHIP_GOVERNANCE_TEST_PRESENCE_KEY_FILE";
const GOVERNANCE_TEST_PRESENCE_PROBE_TIMEOUT_MS = 300_000;

/**
 * Discover the dedicated governance witness public key through the test-only
 * provider, without launching or rebuilding the packaged app: the feature-gated
 * Rust probe binds the deterministic test-presence custody and writes the
 * canonical public key to a file this step owns.
 */
export async function discoverGovernanceTestPresencePublicKey(
  options: GovernanceKeyDiscoveryOptions,
): Promise<string> {
  const tempRoot = mkdtempSync(join(tmpdir(), "township-governance-key-probe-"));
  const keyPath = join(tempRoot, "governance-public-key");

  try {
    await runCargoProbe(options.shellRoot, keyPath);
    if (!existsSync(keyPath)) {
      throw new Error(`governance key probe did not create ${keyPath}`);
    }
    const value = readFileSync(keyPath, "utf8");
    const decoded = Buffer.from(value, "base64");
    if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
      throw new Error(
        `governance key probe produced a noncanonical key: ${JSON.stringify(value)}`,
      );
    }
    return value;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runCargoProbe(shellRoot: string, keyPath: string): Promise<void> {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(
      "cargo",
      [
        "test",
        "--features",
        "township-dev-trace,township-governance-test-presence",
        "--test",
        "governance_test_presence_probe",
      ],
      {
        cwd: join(shellRoot, "src-tauri"),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          PATH: pinnedToolPath(shellRoot),
          [GOVERNANCE_TEST_PRESENCE_KEY_FILE_ENV]: keyPath,
        },
      },
    );
    const lines: string[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // The child may have exited between the timeout and the group signal.
        }
      }
      child.kill("SIGKILL");
    }, GOVERNANCE_TEST_PRESENCE_PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectProbe(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        rejectProbe(
          new Error(
            `governance key probe exceeded ${GOVERNANCE_TEST_PRESENCE_PROBE_TIMEOUT_MS}ms:\n${lines.join("")}`,
          ),
        );
      } else if (code === 0) resolveProbe();
      else rejectProbe(new Error(`governance key probe exited with ${code}:\n${lines.join("")}`));
    });
  });
}
