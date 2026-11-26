import type { CarrierAvailability, CarrierAvailabilitySubscription, CarrierOpFrame } from "@treetopdevs/lattice-client";
import { FakeClock, FakeRelay } from "@treetopdevs/lattice-shell-kit/testing";
import { createFeedController } from "@treetopdevs/lattice-shell-kit/sync";
import type { FeedController, FeedState, ShellHost } from "@treetopdevs/lattice-shell-kit/sync";
import type { RelayLink, RouteConfig } from "../../src/session/ports";
import type { SessionHost } from "../../src/session/session";

// A RelayLink over shell-kit's real feed controller, with one in-process FakeRelay per replica in place
// of the socket (the Tauri shell's test/feed.ts pattern). The availability subscription never hints, so
// every sync is the baseline sync on start or an explicit syncNow. Route state (live, refused,
// submitStopped) is therefore shell-kit's own, never written by this file.

class SilentHints implements CarrierAvailabilitySubscription {
  readonly baseline: CarrierAvailability = { generation: 1, frontier: [], frontierTruncated: false };
  private reject: ((error: unknown) => void) | null = null;
  next(): Promise<CarrierAvailability> {
    return new Promise((_resolve, reject) => {
      this.reject = reject;
    });
  }
  async unsubscribe() {
    this.fail();
  }
  fail() {
    this.reject?.(new Error("carrier websocket closed"));
    this.reject = null;
  }
}

export interface FakeFeed {
  clock: FakeClock;
  relays: Map<string, FakeRelay>;
  relay(replica: string): FakeRelay;
  seed(replica: string, frames: readonly CarrierOpFrame[]): void;
  link(host: SessionHost): RelayLink;
}

export function createFakeFeed(): FakeFeed {
  const clock = new FakeClock();
  const relays = new Map<string, FakeRelay>();
  const relay = (replica: string) => {
    if (!relays.has(replica)) {
      const fake = new FakeRelay(clock, replica);
      fake.rateLimit = false;
      relays.set(replica, fake);
    }
    return relays.get(replica)!;
  };
  return {
    clock,
    relays,
    relay,
    seed(replica, frames) {
      const fake = relay(replica);
      for (const frame of frames) fake.log.set(frame.id, structuredClone(frame));
    },
    link(host) {
      let config: RouteConfig | null = null;
      let feed: FeedController | null = null;
      const listeners = new Set<(state: FeedState) => void>();
      const shellHost: ShellHost = { ...host, relay: () => config };
      const emit = (state: FeedState) => {
        for (const listener of [...listeners]) listener(state);
      };
      const build = (onState: (state: FeedState) => void) =>
        createFeedController({
          host: shellHost,
          sync: { connect: async (route) => relay(route.replica).connect(), verifier: host.verifier, sleep: clock.sleep },
          connect: async () => {
            const hints = new SilentHints();
            return { subscribeAvailability: async () => hints, close: () => hints.fail() };
          },
          pollMs: 0,
          autosyncOnMount: true,
          onState,
        });
      const idle = build(() => undefined);
      const state = () => (feed ?? idle).state();
      return {
        async configure(next) {
          config = next;
          if (feed) await feed.reconfigure();
          emit(state());
        },
        async start() {
          if (feed) return;
          feed = build(emit);
          await feed.start();
        },
        async stop() {
          const running = feed;
          feed = null;
          if (running) await running.stop();
          emit(state());
        },
        async syncNow() {
          return feed ? feed.syncNow() : state();
        },
        state,
        onState(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    },
  };
}

/** A route set for a group on loopback; FakeRelay never dials, so the URLs are only shapes. */
export function loopbackRoutes(replicas: string[], localRealm: string): RouteConfig {
  const relayKey = Buffer.alloc(32, 7).toString("base64");
  return {
    localRealm,
    routes: replicas.map((replica, i) => ({
      replica,
      url: `ws://127.0.0.1:${48300 + i}`,
      expectedPeerRealm: "relay",
      expectedPeerPubkey: relayKey,
    })),
  };
}
