import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type {
  TownshipPairingDiscoveryAdvert,
  TownshipPairingDiscoverySource,
} from "./township_pairing_discovery";

export const TOWNSHIP_PAIRING_DISCOVERY_COMMAND = "lattice_discover_pairing_adverts";
export const TOWNSHIP_PAIRING_ADVERTISE_COMMAND = "lattice_advertise_pairing_handoff";
export const TOWNSHIP_PAIRING_DISCOVERY_TIMEOUT_MS = 750;
export const TOWNSHIP_PAIRING_DISCOVERY_POLL_INTERVAL_MS = 250;

export type TownshipPairingDiscoveryInvoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export interface TauriPairingDiscoverySourceOptions {
  invoke?: TownshipPairingDiscoveryInvoke;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface TauriPairingHandoffAdvertiseOptions {
  handoff: string;
  label?: string;
  targetAddr?: string;
  invoke?: TownshipPairingDiscoveryInvoke;
}

export async function advertiseTauriPairingHandoff(
  options: TauriPairingHandoffAdvertiseOptions,
): Promise<void> {
  const handoff = present(options.handoff);
  if (handoff === null) {
    throw new Error("pairing handoff cannot be empty");
  }

  const args: Record<string, unknown> = { handoff };
  const label = options.label === undefined ? null : present(options.label);
  const targetAddr = options.targetAddr === undefined ? null : present(options.targetAddr);
  if (label !== null) args.label = label;
  if (targetAddr !== null) args.targetAddr = targetAddr;

  await (options.invoke ?? tauriInvoke)(TOWNSHIP_PAIRING_ADVERTISE_COMMAND, args);
}

export function createTauriPairingDiscoverySource(
  options: TauriPairingDiscoverySourceOptions = {},
): TownshipPairingDiscoverySource {
  const invoke = options.invoke ?? tauriInvoke;
  const timeoutMs = options.timeoutMs ?? TOWNSHIP_PAIRING_DISCOVERY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? TOWNSHIP_PAIRING_DISCOVERY_POLL_INTERVAL_MS;

  return {
    async start(onAdvert: (advert: TownshipPairingDiscoveryAdvert) => void): Promise<() => void> {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const poll = async () => {
        const values = await invoke<unknown>(TOWNSHIP_PAIRING_DISCOVERY_COMMAND, { timeoutMs });
        if (stopped) return;

        for (const advert of townshipPairingDiscoveryAdvertsFromNative(values)) {
          onAdvert(advert);
        }
      };

      const schedule = () => {
        if (stopped) return;
        timer = setTimeout(() => {
          void poll().finally(schedule);
        }, pollIntervalMs);
      };

      await poll();
      schedule();

      return () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
      };
    },
  };
}

export function townshipPairingDiscoveryAdvertsFromNative(
  value: unknown,
): TownshipPairingDiscoveryAdvert[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const advert = townshipPairingDiscoveryAdvertFromNative(candidate);
    return advert ? [advert] : [];
  });
}

function townshipPairingDiscoveryAdvertFromNative(value: unknown): TownshipPairingDiscoveryAdvert | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.handoff !== "string") return null;

  const handoff = present(record.handoff);
  if (handoff === null) return null;

  return {
    label: typeof record.label === "string" ? present(record.label) : undefined,
    handoff,
  };
}

function present(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
