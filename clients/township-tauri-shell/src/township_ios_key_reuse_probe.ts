import {
  logTownshipProbeEvent,
  type TownshipNativeStatus,
  type TownshipNativeWorkflowOptions,
} from "./native_workflow";

export const TOWNSHIP_IOS_KEY_REUSE_PROBE_LOG_PREFIX =
  "township-ios-key-reuse-probe";
export const TOWNSHIP_IOS_KEY_REUSE_PROBE_ENV =
  "VITE_TOWNSHIP_IOS_KEY_REUSE_PROBE";
export const TOWNSHIP_IOS_KEY_REUSE_CONTROL_KEY_ID =
  "township-ios-key-reuse-control";
export const TOWNSHIP_IOS_KEY_REUSE_PROBE_COMMAND =
  "lattice_log_ios_key_reuse_probe";

export type TownshipIosKeyReuseProbeSlot = "control" | "primary";

export interface TownshipIosKeyReuseProbeEnv {
  VITE_TOWNSHIP_IOS_KEY_REUSE_PROBE?: string;
}

export interface TownshipIosKeyReuseProbeOptions extends Pick<
  TownshipNativeWorkflowOptions,
  "invoke"
> {
  slot?: TownshipIosKeyReuseProbeSlot;
}

export function townshipIosKeyReuseProbeEnabled(
  env: TownshipIosKeyReuseProbeEnv,
): boolean {
  return env.VITE_TOWNSHIP_IOS_KEY_REUSE_PROBE?.trim() === "1";
}

export async function logTownshipIosKeyReuseProbeFromEnv(
  status: TownshipNativeStatus,
  env: TownshipIosKeyReuseProbeEnv = (
    import.meta as ImportMeta & { env?: TownshipIosKeyReuseProbeEnv }
  ).env ?? {},
  options: TownshipIosKeyReuseProbeOptions = {},
): Promise<boolean> {
  if (!townshipIosKeyReuseProbeEnabled(env)) return false;
  await logTownshipProbeEvent(
    townshipIosKeyReuseProbeLogLine(status, options.slot),
    {
      command: TOWNSHIP_IOS_KEY_REUSE_PROBE_COMMAND,
      ...(options.invoke ? { invoke: options.invoke } : {}),
    },
  );
  return true;
}

export function townshipIosKeyReuseProbeLogLine(
  status: TownshipNativeStatus,
  slot: TownshipIosKeyReuseProbeSlot = "primary",
): string {
  const fields = [
    TOWNSHIP_IOS_KEY_REUSE_PROBE_LOG_PREFIX,
    "store=ios_protected_keychain",
    `slot=${slot}`,
    `outcome=${status.ready ? "ready" : "error"}`,
    `key_id=${probeToken(status.keyId)}`,
  ];

  if (status.ready) {
    fields.push(`public_key_base64url=${base64Url(status.publicKeyBase64)}`);
    fields.push(
      `signature_bytes=${Math.max(0, Math.round(status.signatureBytes))}`,
    );
  } else {
    fields.push("error=unavailable");
  }

  return fields.join(" ");
}

function base64Url(value: string): string {
  return value
    .trim()
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function probeToken(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9_.:-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "empty"
  );
}
