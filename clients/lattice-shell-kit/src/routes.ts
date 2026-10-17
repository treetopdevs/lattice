// Plan 186 decision 7: the route and realm validators, parameterized by the route alphabet table and the
// shell's replica vocabulary. A pure move: the rules are the shell's, unchanged. This module has no runtime
// imports; the shell passes its parsed route_alphabet.json and its own replica predicates in.

/** The shape of route_alphabet.json that the validators read. */
export interface RouteAlphabet {
  realm: { edgeWhitespace: readonly string[]; maxUtf8Bytes: number };
  routeUrl: {
    hostAlphabet: string;
    textByteMin: number;
    textByteMax: number;
    loopbackHosts: readonly string[];
    schemes: Readonly<Record<string, string>>;
    portMin: number;
    portMax: number;
    maxLength: number;
  };
}

export interface CarrierRoute {
  replica: string;
  url: string;
  expectedPeerRealm: string;
  expectedPeerPubkey: string;
}

export interface RouteConfig {
  localRealm: string;
  routes: CarrierRoute[];
}

export interface RouteValidatorOptions {
  /** At most this many routes in a set. Read when a list is validated, never at construction (a getter may defer it). */
  maxRoutes: number;
  /** True when the name is a replica the shell routes (any kind). */
  isReplica: (replica: string) => boolean;
  /** True when the replica is the one anchor replica a route set must contain exactly once. */
  isSpace: (replica: string) => boolean;
}

export interface RouteValidators {
  validateLocalRealm: (value: unknown) => string;
  validRouteUrl: (value: string) => boolean;
  validateRoute: (value: unknown) => CarrierRoute;
  validateRoutes: (values: unknown[]) => CarrierRoute[];
  parseRouteList: (text: string) => RouteConfig;
  mergeRelay: (current: RouteConfig | null, next: RouteConfig) => RouteConfig | null;
}

const ROUTE_FIELDS = ["replica", "url", "expectedPeerRealm", "expectedPeerPubkey"] as const;

const fail = (label: string): never => {
  throw new Error(label);
};

export function createRouteValidators(
  alphabet: RouteAlphabet,
  options: RouteValidatorOptions,
): RouteValidators {
  const { isReplica, isSpace } = options;
  // Plan 198: route_alphabet.json is the one statement of the realm and route alphabet; preview.rs reads it too.
  const EDGE_WHITESPACE: ReadonlySet<number> = new Set(
    alphabet.realm.edgeWhitespace.map((point) => parseInt(point.slice(2), 16)),
  );
  const HOST_ALPHABET = new RegExp(alphabet.routeUrl.hostAlphabet);
  const PRINTABLE_OUTSIDE = new RegExp(
    `[^\\x${alphabet.routeUrl.textByteMin.toString(16)}-\\x${alphabet.routeUrl.textByteMax.toString(16)}]`,
  );
  const LOOPBACK_HOSTS: readonly string[] = alphabet.routeUrl.loopbackHosts;
  const SCHEMES: Readonly<Record<string, string>> = alphabet.routeUrl.schemes;
  // A port is at most as many digits as portMax; the range itself is checked below.
  const PORT_DIGITS = String(alphabet.routeUrl.portMax).length;
  const PORT_TEXT = new RegExp(`^:[1-9][0-9]{0,${PORT_DIGITS - 1}}$`);

  const realmText = (value: unknown, label: string): string => {
    // A realm is pinned for good, so stray whitespace is refused rather than silently kept. Edges are judged
    // by code point against the table, never by trim(), whose set differs from the native store's.
    if (typeof value !== "string" || value === "") return fail(label);
    const points = [...value];
    // A lone surrogate is not UTF-8 and the native store's JSON parser refuses it, so it fails here first.
    if (points.some((point) => {
      const code = point.codePointAt(0)!;
      return code >= 0xd800 && code <= 0xdfff;
    }))
      return fail(label);
    if (
      EDGE_WHITESPACE.has(points[0]!.codePointAt(0)!) ||
      EDGE_WHITESPACE.has(points[points.length - 1]!.codePointAt(0)!) ||
      new TextEncoder().encode(value).length > alphabet.realm.maxUtf8Bytes
    )
      return fail(label);
    return value;
  };

  function validateLocalRealm(value: unknown): string {
    return realmText(value, "invalid_local_realm");
  }

  /** A loopback host may use plain ws; anything else needs wss. No credentials and no fragment. */
  function validRouteUrl(value: string): boolean {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    // URL() silently trims and strips whitespace, so the pinned text must carry none. Hosts stay ASCII so
    // the native store, which checks the raw text, judges the same host.
    if (
      PRINTABLE_OUTSIDE.test(value) ||
      url.username ||
      url.password ||
      // The raw text, not url.hash: an empty fragment ("wss://x#") leaves hash "" yet the native store refuses any "#".
      value.includes("#") ||
      value.length > alphabet.routeUrl.maxLength
    )
      return false;
    // The host must already be in the form URL() normalizes it to (127.1 or a long IPv6 form is refused), so
    // the native store, which checks the raw text, accepts exactly the same hosts.
    // The authority must follow the scheme itself: URL() also parses "wss:example.com?://x" or a backslash form,
    // where a later "://" would otherwise be mistaken for the authority; the native store takes the scheme as
    // everything before the first "://" and refuses those.
    const schemeEnd = value.indexOf("://");
    if (schemeEnd < 0 || `${value.slice(0, schemeEnd).toLowerCase()}:` !== url.protocol) return false;
    const authority = value.slice(schemeEnd + 3).split(/[/?#]/)[0] ?? "";
    const host = authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.split(":")[0]!;
    if (host.toLowerCase() !== url.hostname) return false;
    // A name uses the native store's alphabet: letters, digits, `.`, `-` and `_` (URL() also keeps `!`, `$`, …).
    if (!host.startsWith("[") && !HOST_ALPHABET.test(host)) return false;
    // An `xn--` label is refused outright: URL() validates punycode (IDNA) and throws on a malformed one, and the
    // native store has no IDNA implementation to judge the same way, so neither side accepts one.
    if (!host.startsWith("[") && host.split(".").some((label) => label.toLowerCase().startsWith("xn--"))) return false;
    // A port, when written, is canonical decimal (no leading zeros) and not 0, which names no listening
    // endpoint; the native store requires the same.
    const port = authority.slice(host.length);
    if (port !== "" && port !== ":") {
      if (!PORT_TEXT.test(port)) return false;
      const number = Number(port.slice(1));
      if (number < alphabet.routeUrl.portMin || number > alphabet.routeUrl.portMax) return false;
    }
    // The table says per scheme whether any host is allowed or only a loopback one. A bracketed IPv6 host is never
    // in its loopback list, so ws://[::1] is refused. A scheme the table does not list is refused.
    const rule = Object.hasOwn(SCHEMES, url.protocol.slice(0, -1)) ? SCHEMES[url.protocol.slice(0, -1)] : undefined;
    if (rule === "any-host") return true;
    return rule === "loopback-only" && LOOPBACK_HOSTS.includes(url.hostname);
  }

  function validPeerKey(value: unknown): boolean {
    if (typeof value !== "string") return false;
    try {
      const bytes = atob(value);
      return bytes.length === 32 && btoa(bytes) === value;
    } catch {
      return false;
    }
  }

  /** Closed four-field route record. Throws `invalid_route`. */
  function validateRoute(value: unknown): CarrierRoute {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("invalid_route");
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== ROUTE_FIELDS.length || !ROUTE_FIELDS.every((k) => keys.includes(k)))
      return fail("invalid_route");
    const replica = record.replica;
    const url = record.url;
    if (
      typeof replica !== "string" ||
      !isReplica(replica) ||
      typeof url !== "string" ||
      !validRouteUrl(url) ||
      !validPeerKey(record.expectedPeerPubkey)
    )
      return fail("invalid_route");
    return {
      replica,
      url,
      expectedPeerRealm: realmText(record.expectedPeerRealm, "invalid_route"),
      expectedPeerPubkey: record.expectedPeerPubkey as string,
    };
  }

  /**
   * Validate a list: one route per replica, exactly one of them the Space, and at most three Threads. A saved
   * set is pinned and only extended, so a set without its Space route could never be repaired.
   */
  function validateRoutes(values: unknown[]): CarrierRoute[] {
    if (values.length === 0) return fail("routes_not_configured");
    if (values.length > options.maxRoutes) return fail("too_many_routes");
    const seen = new Set<string>();
    const routes = values.map((value) => {
      const route = validateRoute(value);
      if (seen.has(route.replica)) return fail("duplicate_route");
      seen.add(route.replica);
      return route;
    });
    if (routes.filter((route) => isSpace(route.replica)).length !== 1)
      return fail("route_set_needs_one_space");
    return routes;
  }

  /** The operator-typed route list: `{"localRealm": ..., "routes": [...]}` as JSON text. */
  function parseRouteList(text: string): RouteConfig {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return fail("invalid_route_list");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("invalid_route_list");
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 2 || !keys.includes("localRealm") || !keys.includes("routes") || !Array.isArray(record.routes))
      return fail("invalid_route_list");
    return { localRealm: validateLocalRealm(record.localRealm), routes: validateRoutes(record.routes) };
  }

  const sameRoute = (a: CarrierRoute, b: CarrierRoute) =>
    a.replica === b.replica &&
    a.url === b.url &&
    a.expectedPeerRealm === b.expectedPeerRealm &&
    a.expectedPeerPubkey === b.expectedPeerPubkey;

  /**
   * A relay set is never replaced. A later config may keep every existing route unchanged and add
   * routes (a Thread created after the first route list); anything else is `relay_already_configured`.
   * Returns the config to persist, or null when it equals what is already saved.
   */
  function mergeRelay(current: RouteConfig | null, next: RouteConfig): RouteConfig | null {
    if (current === null) return next;
    if (
      current.localRealm !== next.localRealm ||
      current.routes.some((route) => !next.routes.some((n) => sameRoute(route, n)))
    )
      return fail("relay_already_configured");
    return next.routes.length === current.routes.length ? null : next;
  }

  return { validateLocalRealm, validRouteUrl, validateRoute, validateRoutes, parseRouteList, mergeRelay };
}
