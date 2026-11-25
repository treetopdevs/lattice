import type { FeedState, RelayLink, RouteConfig } from "../ports";

/**
 * A RelayLink that never connects: every configured route stays `idle`. For Core tests of everything
 * that does not need a relay. Tests that need sync use the shell-kit feed link against a real relay.
 */
export class MemoryRelayLink implements RelayLink {
  private config: RouteConfig | null = null;
  private readonly listeners = new Set<(state: FeedState) => void>();

  async configure(config: RouteConfig | null): Promise<void> {
    this.config = config;
    this.emit();
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async syncNow(): Promise<FeedState> {
    return this.state();
  }
  state(): FeedState {
    return {
      configured: this.config !== null,
      routes: (this.config?.routes ?? []).map((route) => ({
        replica: route.replica,
        connection: "idle",
        pending: 0,
        acked: 0,
        generation: null,
        matchesRelay: null,
        refused: [],
        submitStopped: null,
        message: "Not connected.",
      })),
    };
  }
  onState(listener: (state: FeedState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void {
    const state = this.state();
    for (const listener of [...this.listeners]) listener(state);
  }
}
