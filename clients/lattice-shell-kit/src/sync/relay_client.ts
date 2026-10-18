import { connectCarrierWebSocket } from "@treetopdevs/lattice-client";
import type {
  CarrierVerifier,
  ConnectCarrierWebSocketOptions,
} from "@treetopdevs/lattice-client";
import type { FeedSession } from "./feed";
import type { CarrierRoute, ShellHost } from "./host";
import type { RelayConnection } from "./sync";

// Plan 181 slice 3b2. The real relay client: one authenticated WebSocket per replica route, dialled only
// to a route already saved in the relay record. The hello handshake pins the server's realm and public
// key, so a different server is refused and its socket closed. The shell never listens, spawns or binds
// anything (CD1 stays closed); this module only dials out. It imports nothing from lattice-mobile-core.

export interface RelayConnectorOptions {
  host: ShellHost;
  /** Server hello check. The shell supplies strict Ed25519 (no ZIP-215 leniency), as operation checks use. */
  verifier: CarrierVerifier;
  /** Test seam for a scripted socket. The packaged shell uses the platform WebSocket. */
  webSocket?: ConnectCarrierWebSocketOptions["webSocket"];
}

export interface RelayConnector {
  /** Sync connection: advertise, pull and one-op relay submission. */
  connect(route: CarrierRoute, localRealm: string, signal?: AbortSignal): Promise<RelayConnection>;
  /** Availability connection: it can subscribe and close, and by type nothing that submits. */
  connectFeed(route: CarrierRoute, localRealm: string, signal?: AbortSignal): Promise<FeedSession>;
}

const fromBase64 = (value: string): Uint8Array => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

export function createRelayConnector(options: RelayConnectorOptions): RelayConnector {
  const verifier = options.verifier;

  async function dial(route: CarrierRoute, localRealm: string, signal?: AbortSignal) {
    // Validate before any socket exists, and dial only the saved copy of the route.
    const checked = options.host.validators.validateRoute(route);
    const realm = options.host.validators.validateLocalRealm(localRealm);
    const saved = options.host.relay()?.routes.find(
      (r) =>
        r.replica === checked.replica &&
        r.url === checked.url &&
        r.expectedPeerRealm === checked.expectedPeerRealm &&
        r.expectedPeerPubkey === checked.expectedPeerPubkey,
    );
    if (!saved) throw new Error("unknown_route_replica");
    const connectOptions: ConnectCarrierWebSocketOptions = {
      url: saved.url,
      localRealm: realm,
      replica: saved.replica,
      signer: options.host.signer(),
      expectedPeerRealm: saved.expectedPeerRealm,
      expectedPeerPubkey: fromBase64(saved.expectedPeerPubkey),
      verifier,
    };
    if (options.webSocket !== undefined) connectOptions.webSocket = options.webSocket;
    if (signal !== undefined) connectOptions.signal = signal;
    return connectCarrierWebSocket(connectOptions);
  }

  return {
    connect: (route, localRealm, signal) => dial(route, localRealm, signal),
    async connectFeed(route, localRealm, signal) {
      const client = await dial(route, localRealm, signal);
      return {
        subscribeAvailability: () => client.subscribeAvailability(),
        close: () => client.close(),
      };
    },
  };
}
