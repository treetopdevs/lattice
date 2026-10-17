import { createRouteValidators } from "@treetopdevs/lattice-shell-kit";
import type { TreehouseOfferRoute, TreehouseProduct } from "@treetopdevs/lattice-client";
import alphabet from "../route_alphabet.json";
import { MAX_ROUTES } from "./treehouse_state";
import type { RelayConfig, RelayRoute } from "./treehouse_state";

// Plan 181 decision 10: route and offer-route validation lives in the shell. The rules are copied from
// lattice-mobile-core's normalizeCarrierPeerConfig (a ws or wss URL, a 32-byte peer key, a realm label)
// and tightened where the lite shell is stricter: ws is accepted for loopback only. This module imports
// nothing from lattice-mobile-core. Plan 186 decision 7: the validators now live in the kit's
// createRouteValidators factory; this module supplies the Treehouse alphabet table and replica names.

const SPACE_REPLICA = /^replica:treehouse:space:[A-Za-z0-9_-]{43}#root:[A-Za-z0-9_-]{43}$/;
const THREAD_REPLICA = /^replica:treehouse:thread:[A-Za-z0-9_-]{43}#root:[A-Za-z0-9_-]{43}$/;
/** The one place a replica name is classified: a Space replica, or otherwise a Thread. */
export const productOf = (replica: string): TreehouseProduct =>
  replica.startsWith("replica:treehouse:space:") ? "Treehouse.Space" : "Treehouse.Thread";

// Plan 198: route_alphabet.json is the one statement of the realm and route alphabet; preview.rs reads it too.
const validators = createRouteValidators(alphabet, {
  // A getter: treehouse_state and this module import each other, so MAX_ROUTES is not yet initialized here.
  get maxRoutes() {
    return MAX_ROUTES;
  },
  isReplica: (replica) => SPACE_REPLICA.test(replica) || THREAD_REPLICA.test(replica),
  isSpace: (replica) => productOf(replica) === "Treehouse.Space",
});

export const validateLocalRealm: (value: unknown) => string = validators.validateLocalRealm;
export const validRouteUrl: (value: string) => boolean = validators.validRouteUrl;
export const validateRoute: (value: unknown) => RelayRoute = validators.validateRoute;
export const validateRoutes: (values: unknown[]) => RelayRoute[] = validators.validateRoutes;
export const parseRouteList: (text: string) => RelayConfig = validators.parseRouteList;
export const mergeRelay: (current: RelayConfig | null, next: RelayConfig) => RelayConfig | null =
  validators.mergeRelay;

const fail = (label: string): never => {
  throw new Error(label);
};

/**
 * Routes carried by an offer. There must be exactly one route per replica in scope (the Space and every
 * Thread of the invitation) and none for any other replica, so the pinned scope is fully routable.
 */
export function routesForOffer(
  routes: readonly TreehouseOfferRoute[],
  scope: { space: string; threads: readonly string[] },
): RelayRoute[] {
  const valid = validateRoutes([...routes]);
  const expected = [scope.space, ...scope.threads];
  if (
    !SPACE_REPLICA.test(scope.space) ||
    scope.threads.some((replica) => !THREAD_REPLICA.test(replica)) ||
    valid.length !== expected.length ||
    expected.some((replica) => !valid.some((route) => route.replica === replica))
  )
    return fail("route_replica_mismatch");
  return expected.map((replica) => valid.find((route) => route.replica === replica)!);
}

/** The offer-side opaque record for a route. */
export function offerRoute(route: RelayRoute): TreehouseOfferRoute {
  return {
    replica: route.replica,
    url: route.url,
    expectedPeerRealm: route.expectedPeerRealm,
    expectedPeerPubkey: route.expectedPeerPubkey,
  };
}
