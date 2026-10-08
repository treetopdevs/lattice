import { connectCarrierWebSocket } from "@treetopdevs/lattice-client";
import type {
  CarrierSigner,
  CarrierVerifier,
  ConnectCarrierWebSocketOptions,
} from "@treetopdevs/lattice-client";
import type { TreehouseFeedSession } from "./treehouse_feed";
import { validateLocalRealm, validateRoute } from "./treehouse_routes";
import type { RelayRoute } from "./treehouse_state";
import { fromBase64, strictEd25519 } from "./treehouse_workflow";
import type { TreehouseWorkflow } from "./treehouse_workflow";
import type { TreehouseRelayConnection } from "./treehouse_sync";

// Plan 181 slice 3b2. The real relay client: one authenticated WebSocket per replica route, dialled only
// to a route already saved in the relay record. The hello handshake pins the server's realm and public
// key, so a different server is refused and its socket closed. The shell never listens, spawns or binds
// anything (CD1 stays closed); this module only dials out. It imports nothing from lattice-mobile-core.

export interface TreehouseRelayConnectorOptions {
  workflow: TreehouseWorkflow;
  /** Server hello check. Defaults to strict Ed25519 (no ZIP-215 leniency), as operation checks use. */
  verifier?: CarrierVerifier;
  /** Test seam for a scripted socket. The packaged shell uses the platform WebSocket. */
  webSocket?: ConnectCarrierWebSocketOptions["webSocket"];
}

export interface TreehouseRelayConnector {
  /** Sync connection: advertise, pull and one-op relay submission. */
  connect(route: RelayRoute, localRealm: string, signal?: AbortSignal): Promise<TreehouseRelayConnection>;
  /** Availability connection: it can subscribe and close, and by type nothing that submits. */
  connectFeed(route: RelayRoute, localRealm: string, signal?: AbortSignal): Promise<TreehouseFeedSession>;
}

const defaultVerifier: CarrierVerifier = {
  verify: (pubkey, bytes, signature) => strictEd25519(signature, bytes, pubkey),
};

/**
 * The carrier session signer for the local key. The public key comes from the saved record and every
 * signature goes through native signing, so no seed or private key is ever held in TypeScript.
 */
export function treehouseCarrierSigner(workflow: TreehouseWorkflow): CarrierSigner {
  const publicKey = workflow.state.publicKey;
  if (publicKey === null || !workflow.keyAvailable) throw new Error("identity_unavailable");
  return {
    publicKey: fromBase64(publicKey),
    sign: (bytes) => workflow.native.sign(bytes),
  };
}

export function createTreehouseRelayConnector(
  options: TreehouseRelayConnectorOptions,
): TreehouseRelayConnector {
  const verifier = options.verifier ?? defaultVerifier;

  async function dial(route: RelayRoute, localRealm: string, signal?: AbortSignal) {
    // Validate before any socket exists, and dial only the saved copy of the route.
    const checked = validateRoute(route);
    const realm = validateLocalRealm(localRealm);
    const saved = options.workflow.state.relay?.routes.find(
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
      signer: treehouseCarrierSigner(options.workflow),
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
